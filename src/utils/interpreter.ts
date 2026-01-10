import { generalSettings, saveSettings } from './storage-utils';
import { PromptVariable, Template, ModelConfig, ObsidianPropertyType, PromptLocation } from '../types/types';
import { compileTemplate } from './template-compiler';
import { applyFilters } from './filters';
import { formatDuration, formatCost } from './string-utils';
import { adjustNoteNameHeight } from './ui-utils';
import { debugLog, redactUrlForLogging } from './debug';
import { getMessage } from './i18n';
import { updateTokenCountWithLimit, updateTokenCountWithPdf, countTokens, PdfDisplayInfo } from './token-counter';
import { interpret } from '../ai-sdk/interpreter-service';
import { detectProviderType, supportsPdfUrl } from '../ai-sdk/provider-factory';
import { getContextLimit, getModelCost, initializeRegistry, getEffectiveProviderId, supportsPdfInput } from '../ai-sdk/model-registry';
import { SupportedProvider, UsageInfo, PromptResponse, isSupportedProvider, PdfAttachment } from '../ai-sdk/types';
import browser from './browser-polyfill';
import { formatFileSize } from './pdf-extractor';
import { getPdfFilename } from './pdf-utils';

// Store event listeners for cleanup
const eventListeners = new WeakMap<HTMLElement, { [key: string]: EventListener }>();

/**
 * Format usage info for display
 */
function formatUsageInfo(usage: UsageInfo): string {
	const totalTokens = usage.totalTokens.toLocaleString();
	
	if (usage.estimatedCost) {
		const costStr = formatCost(usage.estimatedCost.total);
		return `${totalTokens} tokens (~${costStr})`;
	}
	
	return `${totalTokens} tokens`;
}

/**
 * Result from sendToLLM including usage information
 */
export interface LLMResult {
	promptResponses: PromptResponse[];
	usage?: UsageInfo;
}

/**
 * Options for sending to LLM, including optional PDF attachment
 */
export interface SendToLLMOptions {
	promptContext: string;
	promptVariables: PromptVariable[];
	model: ModelConfig;
	/** Optional PDF URL for PDF-capable models */
	pdfUrl?: string;
}

/**
 * Result from PDF extraction with base64 data
 */
interface PdfExtractionWithBase64 {
	success: boolean;
	base64?: string;
	sizeBytes?: number;
	error?: string;
}

/**
 * Prepare PDF attachment for a model that supports PDF input.
 * Returns URL-only attachment for providers that support it, or fetches base64 for others.
 */
async function preparePdfAttachment(
	pdfUrl: string, 
	providerId: string, 
	modelId: string,
	providerType: SupportedProvider,
	forceBase64: boolean
): Promise<PdfAttachment | undefined> {
	// Check if model supports PDF input
	const modelSupportsPdf = supportsPdfInput(providerId, modelId);
	
	if (!modelSupportsPdf) {
		debugLog('Interpreter', 'Model does not support PDF input, skipping attachment', {
			providerId,
			modelId,
		});
		return undefined;
	}

	// Check if we should use URL-based PDF (provider supports it and not forced to base64)
	if (!forceBase64 && supportsPdfUrl(providerType)) {
		debugLog('Interpreter', 'Using URL-based PDF attachment', { 
			providerId, 
			providerType,
			pdfUrl: redactUrlForLogging(pdfUrl),
		});
		return {
			url: pdfUrl,
			mimeType: 'application/pdf',
			// No base64 - provider will fetch the URL directly
		};
	}

	// Provider requires base64, or user forced base64
	debugLog('Interpreter', 'Using base64 PDF attachment', { 
		providerId, 
		providerType,
		forceBase64 
	});
	
	try {
		// Use extractPdf with includeBase64 flag for single-fetch optimization
		const result = await browser.runtime.sendMessage({
			action: 'extractPdf',
			url: pdfUrl,
			includeBase64: true
		}) as PdfExtractionWithBase64;

		if (result.success && result.base64) {
			debugLog('Interpreter', 'PDF base64 fetched successfully', {
				sizeBytes: result.sizeBytes,
			});
			return {
				url: pdfUrl,
				base64: result.base64,
				mimeType: 'application/pdf',
				sizeBytes: result.sizeBytes,
			};
		} else {
			console.warn('Failed to fetch PDF base64:', result.error);
			return undefined;
		}
	} catch (error) {
		console.error('Error fetching PDF base64:', error);
		return undefined;
	}
}

/**
 * Send prompt variables to an LLM for processing using the AI SDK.
 * 
 * This is a wrapper that maintains backwards compatibility while using
 * the new AI SDK-based interpreter service under the hood.
 */
export async function sendToLLM(promptContext: string, promptVariables: PromptVariable[], model: ModelConfig, pdfUrl?: string): Promise<LLMResult> {
	debugLog('Interpreter', 'Sending request to LLM via AI SDK...');
	
	// Find the provider for this model
	const provider = generalSettings.providers.find(p => p.id === model.providerId);
	if (!provider) {
		throw new Error(`Provider not found for model ${model.name}`);
	}

	// Only check for API key if the provider requires it
	if (provider.apiKeyRequired && !provider.apiKey) {
		throw new Error(`API key is not set for provider ${provider.name}`);
	}

	// Determine provider type - use explicit type if valid, otherwise auto-detect
	const providerType: SupportedProvider = isSupportedProvider(provider.type) 
		? provider.type 
		: detectProviderType(provider.baseUrl, provider.name);

	// Get the effective provider ID for model lookups
	const modelsDevProviderId = getEffectiveProviderId(provider.presetId, model.providerModelId);

	// Prepare PDF attachment if URL provided and model supports it
	let pdfAttachment: PdfAttachment | undefined;
	if (pdfUrl && modelsDevProviderId) {
		pdfAttachment = await preparePdfAttachment(
			pdfUrl, 
			modelsDevProviderId, 
			model.providerModelId,
			providerType,
			provider.forceBase64Pdf ?? false
		);
	}

	// When PDF is attached, use minimal context to avoid sending duplicate content
	// The model can read the PDF directly, so we don't need the extracted text
	const effectiveContext = pdfAttachment 
		? '[[See attached PDF]]'
		: promptContext;

	debugLog('Interpreter', 'Sending to LLM', {
		hasPdfUrl: !!pdfUrl,
		hasPdfAttachment: !!pdfAttachment,
		effectiveContextLength: effectiveContext.length,
	});

	// Call the new AI SDK-based interpreter service
	const result = await interpret({
		providerId: provider.presetId || provider.id, // Use presetId (models.dev ID) if available
		providerModelId: model.providerModelId,
		apiKey: provider.apiKey,
		baseUrl: provider.baseUrl,
		providerType,
		promptVariables,
		context: effectiveContext,
		// Pass model-specific settings if configured
		modelSettings: model.settings,
		// Pass PDF attachment if available
		pdfAttachment,
	});

	debugLog('Interpreter', 'AI SDK response received', {
		responseCount: result.promptResponses.length,
		usage: result.usage,
		hadPdfAttachment: !!pdfAttachment,
	});

	return { 
		promptResponses: result.promptResponses,
		usage: result.usage
	};
}

/**
 * Get the Obsidian property type for a given property name
 */
function getPropertyType(propertyName: string): ObsidianPropertyType | undefined {
	const propertyType = generalSettings.propertyTypes.find(pt => pt.name === propertyName);
	if (propertyType) {
		return propertyType.type as ObsidianPropertyType;
	}
	return undefined;
}

export function collectPromptVariables(template: Template | null): PromptVariable[] {
	const promptMap = new Map<string, PromptVariable>();
	const promptRegex = /{{(?:prompt:)?"([\s\S]*?)"(\|.*?)?}}/g;
	let match;

	function addPrompt(
		prompt: string, 
		filters: string, 
		location: PromptLocation,
		propertyName?: string, 
		propertyType?: ObsidianPropertyType
	) {
		if (!promptMap.has(prompt)) {
			// Use property name as key if available, otherwise generate a descriptive key
			let key: string;
			if (propertyName) {
				key = propertyName;
			} else if (location === 'note_name') {
				key = 'note_title';
			} else {
				key = `content_prompt_${promptMap.size + 1}`;
			}
			promptMap.set(prompt, { key, prompt, filters, location, propertyName, propertyType });
		}
	}

	// Collect prompts from note name format
	if (template?.noteNameFormat) {
		while ((match = promptRegex.exec(template.noteNameFormat)) !== null) {
			// Note name prompts - always text type for filename
			addPrompt(match[1], match[2] || '', 'note_name');
		}
	}

	// Collect prompts from properties
	if (template?.properties) {
		for (const property of template.properties) {
			const propertyValue = property.value;
			while ((match = promptRegex.exec(propertyValue)) !== null) {
				// Use the property name as the key and look up the property type
				const propType = getPropertyType(property.name);
				addPrompt(match[1], match[2] || '', 'properties', property.name, propType);
			}
		}
	}

	// Collect prompts from note content format
	if (template?.noteContentFormat) {
		while ((match = promptRegex.exec(template.noteContentFormat)) !== null) {
			// Prompts in note content don't have a property name or type
			addPrompt(match[1], match[2] || '', 'note_content');
		}
	}

	// Also check current DOM input values (for any dynamic prompts)
	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			let inputValue = input.value;
			// Determine location based on input id
			const location: PromptLocation = input.id === 'note-name-field' 
				? 'note_name' 
				: input.closest('.property-editor') 
					? 'properties' 
					: 'note_content';
			while ((match = promptRegex.exec(inputValue)) !== null) {
				addPrompt(match[1], match[2] || '', location);
			}
		}
	});

	return Array.from(promptMap.values());
}

export async function initializeInterpreter(template: Template, variables: { [key: string]: string }, tabId: number, currentUrl: string, pdfUrl?: string) {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn');
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;
	const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
	const tokenCounter = document.getElementById('token-counter');

	// Initialize model registry for context limits
	await initializeRegistry();

	function removeOldListeners(element: HTMLElement, eventType: string) {
		const listeners = eventListeners.get(element);
		if (listeners && listeners[eventType]) {
			element.removeEventListener(eventType, listeners[eventType]);
		}
	}

	function storeListener(element: HTMLElement, eventType: string, listener: EventListener) {
		let listeners = eventListeners.get(element);
		if (!listeners) {
			listeners = {};
			eventListeners.set(element, listeners);
		}
		removeOldListeners(element, eventType);
		listeners[eventType] = listener;
		element.addEventListener(eventType, listener);
	}

	// Helper to get model info (context limit, cost, PDF support) for currently selected model
	function getSelectedModelInfo(): { contextLimit?: number; inputCost?: number; modelSupportsPdf?: boolean; modelsDevProviderId?: string; providerModelId?: string } {
		const selectedModelId = modelSelect?.value;
		if (!selectedModelId) return {};
		
		const modelConfig = generalSettings.models.find(m => m.id === selectedModelId);
		if (!modelConfig) return {};
		
		const provider = generalSettings.providers.find(p => p.id === modelConfig.providerId);
		if (!provider) return {};
		
		// Use presetId (the models.dev provider ID) for model lookups
		// presetId is required for models.dev providers, undefined for custom OpenAI-compatible providers
		const modelsDevProviderId = getEffectiveProviderId(provider.presetId, modelConfig.providerModelId);
		if (!modelsDevProviderId) return {};
		
		// Get info from models.dev registry
		const contextLimit = getContextLimit(modelsDevProviderId, modelConfig.providerModelId);
		const cost = getModelCost(modelsDevProviderId, modelConfig.providerModelId);
		const modelSupportsPdf = supportsPdfInput(modelsDevProviderId, modelConfig.providerModelId);
		
		return {
			contextLimit,
			inputCost: cost?.input,
			modelSupportsPdf,
			modelsDevProviderId,
			providerModelId: modelConfig.providerModelId
		};
	}

	// Track extracted PDF text tokens for display (will be set when processing PDF)
	let extractedPdfTextTokens: number | undefined;
	
	// Helper to update token count with current model's context limit, cost, and PDF info
	function updateTokenDisplay() {
		if (tokenCounter && promptContextTextarea) {
			const { contextLimit, inputCost, modelSupportsPdf } = getSelectedModelInfo();
			
			// If we have a PDF URL and the model supports PDF input,
			// show the effective context (minimal) + PDF attachment info
			if (pdfUrl && modelSupportsPdf && extractedPdfTextTokens !== undefined) {
				// The effective context when PDF is attached is just "[[See attached PDF]]"
				const effectiveContext = '[[See attached PDF]]';
				const pdfInfo: PdfDisplayInfo = {
					extractedTokens: extractedPdfTextTokens
				};
				updateTokenCountWithPdf(effectiveContext, tokenCounter, contextLimit, inputCost, pdfInfo);
			} else {
				// No PDF or model doesn't support PDF - show full context tokens
				updateTokenCountWithLimit(promptContextTextarea.value, tokenCounter, contextLimit, inputCost);
			}
		}
	}

	const promptVariables = collectPromptVariables(template);

	// Hide interpreter if it's disabled or there are no prompt variables
	if (!generalSettings.interpreterEnabled || promptVariables.length === 0) {
		if (interpreterContainer) interpreterContainer.style.display = 'none';
		if (interpretBtn) interpretBtn.style.display = 'none';
		return;
	}

	if (interpreterContainer) interpreterContainer.style.display = 'flex';
	if (interpretBtn) interpretBtn.style.display = 'inline-block';
	
	if (promptContextTextarea) {
		const inputListener = () => {
			template.context = promptContextTextarea.value;
			updateTokenDisplay();
		};
		
		storeListener(promptContextTextarea, 'input', inputListener);

		let promptToDisplay =
			template.context
			|| generalSettings.defaultPromptContext
			|| '{{fullHtml|remove_html:("#navbar,.footer,#footer,header,footer,style,script")|strip_tags:("script,h1,h2,h3,h4,h5,h6,meta,a,ol,ul,li,p,em,strong,i,b,s,strike,u,sup,sub,img,video,audio,math,table,cite,td,th,tr,caption")|strip_attr:("alt,src,href,id,content,property,name,datetime,title")}}';
		promptToDisplay = await compileTemplate(tabId, promptToDisplay, variables, currentUrl);
		
		// If this is a PDF page, calculate extracted text tokens for display
		// This is the token count of the extracted PDF text (used when model supports PDF natively)
		if (pdfUrl) {
			// Store the token count of the extracted PDF text BEFORE adding any prefixes
			// This represents the tokens in the PDF content that will be sent as an attachment
			extractedPdfTextTokens = countTokens(promptToDisplay);
			
			const filename = getPdfFilename(pdfUrl);
			// Add PDF indicator prefix for user clarity in the context textarea
			const pdfIndicator = `[PDF: ${filename}.pdf]\n\n`;
			promptToDisplay = pdfIndicator + promptToDisplay;
		}
		
		promptContextTextarea.value = promptToDisplay;
		
		// Initial token count (will show PDF-aware format if applicable)
		updateTokenDisplay();
	}

	if (template) {
		// Only add click listener if auto-run is disabled
		if (interpretBtn && !generalSettings.interpreterAutoRun) {
			const clickListener = async () => {
				const selectedModelId = modelSelect.value;
				const modelConfig = generalSettings.models.find(m => m.id === selectedModelId);
				if (!modelConfig) {
					throw new Error(`Model configuration not found for ${selectedModelId}`);
				}
				await handleInterpreterUI(template, variables, tabId, currentUrl, modelConfig, pdfUrl);
			};
			storeListener(interpretBtn, 'click', clickListener);
		}

		if (modelSelect) {
			const changeListener = async () => {
				generalSettings.interpreterModel = modelSelect.value;
				await saveSettings();
				// Update token display with new model's context limit
				updateTokenDisplay();
			};
			storeListener(modelSelect, 'change', changeListener);

			modelSelect.style.display = 'inline-block';
			
			// Filter enabled models
			const enabledModels = generalSettings.models.filter(model => model.enabled);
			
			// Clear existing options
			modelSelect.textContent = '';
			
			// Add model options
			enabledModels.forEach(model => {
				const option = document.createElement('option');
				option.value = model.id;
				option.textContent = model.name;
				modelSelect.appendChild(option);
			});

			// Check if last selected model exists and is enabled
			const lastSelectedModel = enabledModels.find(model => model.id === generalSettings.interpreterModel);
			
			if (!lastSelectedModel && enabledModels.length > 0) {
				// If last selected model is not available/enabled, use first enabled model
				generalSettings.interpreterModel = enabledModels[0].id;
				await saveSettings();
			}

			modelSelect.value = generalSettings.interpreterModel || (enabledModels[0]?.id ?? '');
			
			// Update token display after model selection is set
			updateTokenDisplay();
		}
	}
}

export async function handleInterpreterUI(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string,
	modelConfig: ModelConfig,
	pdfUrl?: string
): Promise<void> {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
	const interpreterErrorMessage = document.getElementById('interpreter-error') as HTMLDivElement;
	const responseTimer = document.getElementById('interpreter-timer') as HTMLSpanElement;
	const clipButton = document.getElementById('clip-btn') as HTMLButtonElement;
	const moreButton = document.getElementById('more-btn') as HTMLButtonElement;
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;

	try {
		// Hide any previous error message
		interpreterErrorMessage.style.display = 'none';
		interpreterErrorMessage.textContent = '';

		// Remove any previous done or error classes
		interpreterContainer?.classList.remove('done', 'error');

		// Find the provider for this model
		const provider = generalSettings.providers.find(p => p.id === modelConfig.providerId);
		if (!provider) {
			throw new Error(`Provider not found for model ${modelConfig.name}`);
		}

		// Only check for API key if the provider requires it
		if (provider.apiKeyRequired && !provider.apiKey) {
			throw new Error(`API key is not set for provider ${provider.name}`);
		}

		const promptVariables = collectPromptVariables(template);

		if (promptVariables.length === 0) {
			throw new Error('No prompt variables found. Please add at least one prompt variable to your template.');
		}

		const contextToUse = promptContextTextarea.value;

		// Start the timer
		const startTime = performance.now();
		let timerInterval: number;

		// Change button text and add class
		interpretBtn.textContent = getMessage('thinking');
		interpretBtn.classList.add('processing');

		// Disable the clip button
		clipButton.disabled = true;
		moreButton.disabled = true;

		// Show and update the timer
		responseTimer.style.display = 'inline';
		responseTimer.textContent = '0ms';

		// Update the timer text with elapsed time
		timerInterval = window.setInterval(() => {
			const elapsedTime = performance.now() - startTime;
			responseTimer.textContent = formatDuration(elapsedTime);
		}, 10);

		const { promptResponses, usage } = await sendToLLM(contextToUse, promptVariables, modelConfig, pdfUrl);
		debugLog('Interpreter', 'LLM response:', { promptResponses, usage, hadPdfUrl: !!pdfUrl });

		// Stop the timer and update UI
		clearInterval(timerInterval);
		const endTime = performance.now();
		const totalTime = endTime - startTime;
		responseTimer.textContent = formatDuration(totalTime);

		// Update button state
		interpretBtn.textContent = getMessage('done').toLowerCase();
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add('done');
		interpretBtn.disabled = true;

		// Add done class to container
		interpreterContainer?.classList.add('done');

		// Display usage info in token counter
		const tokenCounter = document.getElementById('token-counter');
		if (tokenCounter && usage) {
			const usageText = formatUsageInfo(usage);
			tokenCounter.textContent = usageText;
			tokenCounter.classList.add('usage-complete');
		}
		
		// Update fields with responses
		replacePromptVariables(promptVariables, promptResponses);

		// Re-enable clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		// Adjust height for noteNameField after content is replaced
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement | null;
		if (noteNameField instanceof HTMLTextAreaElement) {
			adjustNoteNameHeight(noteNameField);
		}

	} catch (error) {
		console.error('Error processing LLM:', error);
		
		// Revert button text and remove class in case of error
		interpretBtn.textContent = getMessage('error');
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add('error');
		interpretBtn.disabled = true;

		// Add error class to interpreter container
		interpreterContainer?.classList.add('error');

		// Hide the timer
		responseTimer.style.display = 'none';

		// Display the error message
		interpreterErrorMessage.textContent = error instanceof Error ? error.message : 'An unknown error occurred while processing the interpreter request.';
		interpreterErrorMessage.style.display = 'block';

		// Re-enable the clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		if (error instanceof Error) {
			throw new Error(`${error.message}`);
		} else {
			throw new Error('An unknown error occurred while processing the interpreter request.');
		}
	}
}

// Similar to replaceVariables, but happens after the LLM response is received
export function replacePromptVariables(promptVariables: PromptVariable[], promptResponses: PromptResponse[]) {
	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			input.value = input.value.replace(/{{(?:prompt:)?"([\s\S]*?)"(\|[\s\S]*?)?}}/g, (match, promptText, filters) => {
				const variable = promptVariables.find(v => v.prompt === promptText);
				if (!variable) return match;

				const response = promptResponses.find(r => r.key === variable.key);
				if (response && response.user_response !== undefined) {
					let value = response.user_response;
					
					// Handle different response types based on Obsidian property type
					if (Array.isArray(value)) {
						// For multitext (tags), join array elements with comma
						value = value.join(', ');
					} else if (typeof value === 'boolean') {
						// Convert boolean to string
						value = String(value);
					} else if (typeof value === 'number') {
						// Convert number to string
						value = String(value);
					} else if (typeof value === 'object' && value !== null) {
						// Handle any other object types
						try {
							value = JSON.stringify(value, null, 2);
						} catch (error) {
							console.error('Error stringifying object:', error);
							value = String(value);
						}
					}

					if (filters) {
						value = applyFilters(value, filters.slice(1));
					}
					
					return value;
				}
				return match; // Return original if no match found
			});

			// Adjust height for noteNameField after updating its value
			if (input.id === 'note-name-field' && input instanceof HTMLTextAreaElement) {
				adjustNoteNameHeight(input);
			}
		}
	});
}