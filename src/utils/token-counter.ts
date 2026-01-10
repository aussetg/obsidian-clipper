import { formatCost } from './string-utils';
import { getMessage } from './i18n';

/**
 * Attachment info for display purposes (future-proof for images, pptx, etc.)
 */
export interface AttachmentInfo {
	/** Type of attachment (e.g., 'PDF', 'image', 'pptx') */
	type: string;
	/** Estimated token count for this attachment */
	estimatedTokens: number;
	/** Number of attachments of this type */
	count?: number;
}

/**
 * @deprecated Use AttachmentInfo instead
 * Info about a PDF attachment for display purposes
 */
export interface PdfDisplayInfo {
	/** Token count of the extracted PDF text (what will be sent as attachment) */
	extractedTokens: number;
	/** Size of the PDF file in bytes (optional) */
	sizeBytes?: number;
}

/**
 * Approximate token count estimation for LLMs.
 * 
 * This is a rough estimation used for pre-request validation and cost estimates.
 * Actual token counts vary by model and tokenizer. Common approximations:
 * 
 *   - 1 token ≈ 4 characters (English text)
 *   - 1 token ≈ ¾ of a word
 *   - 100 tokens ≈ 75 words
 *   - 1-2 sentences ≈ 30 tokens
 *   - 1 paragraph ≈ 100 tokens
 *   - ~1,500 words ≈ 2,048 tokens
 * 
 * Note: Code, non-English text, and special characters may tokenize differently.
 * The AI SDK returns actual token usage in the response for accurate tracking.
 */
export function countTokens(text: string): number {
	if (!text) return 0;
	// 1 token ≈ 4 characters is a widely-used approximation for English text
	return Math.ceil(text.length / 4);
}

/**
 * Calculate estimated cost for input tokens only
 * Cost is per million tokens from models.dev
 */
function calculateInputCost(tokenCount: number, inputCostPerMillion: number): number {
	return (tokenCount / 1_000_000) * inputCostPerMillion;
}

/**
 * Update token count display with basic thresholds
 */
export function updateTokenCount(text: string, displayElement: HTMLElement): void {
	const count = countTokens(text);
	displayElement.textContent = `~${count.toLocaleString()} ${getMessage('tokens')}`;
	
	// Add warning class if count is getting high (basic thresholds)
	displayElement.classList.toggle('warning', count > 50000);
	displayElement.classList.toggle('error', count > 100000);
	displayElement.classList.remove('usage-complete');
}

/**
 * Update token count display with model-specific context limit and optional cost estimate
 * 
 * @param text - The text to count tokens for
 * @param displayElement - The HTML element to update
 * @param contextLimit - Optional model context window limit
 * @param inputCost - Optional input cost per million tokens from models.dev
 */
export function updateTokenCountWithLimit(
	text: string,
	displayElement: HTMLElement,
	contextLimit: number | undefined,
	inputCost?: number
): void {
	const count = countTokens(text);
	
	// Build display parts
	const parts: string[] = [];
	
	// Token count with optional limit
	if (contextLimit) {
		const percentUsed = (count / contextLimit) * 100;
		parts.push(`~${count.toLocaleString()} / ${contextLimit.toLocaleString()} ${getMessage('tokens')} (${percentUsed.toFixed(0)}%)`);
		
		// Warning at 70%, error at 90%
		displayElement.classList.toggle('warning', percentUsed > 70 && percentUsed <= 90);
		displayElement.classList.toggle('error', percentUsed > 90);
	} else {
		parts.push(`~${count.toLocaleString()} ${getMessage('tokens')}`);
		// Fall back to basic thresholds if no limit known
		displayElement.classList.toggle('warning', count > 50000);
		displayElement.classList.toggle('error', count > 100000);
	}
	
	// Add estimated cost if available
	if (inputCost !== undefined && inputCost > 0) {
		const estimatedCost = calculateInputCost(count, inputCost);
		parts.push(formatCost(estimatedCost, true));
	}
	
	displayElement.textContent = parts.join(' ');
	displayElement.classList.remove('usage-complete');
}

/**
 * Update token count display with attachments info
 * Shows token count on first line, attachments on second line:
 *   "~18,857 tokens / 400,000 (5%) < $0.001"
 *   "Attachments: 1 PDF"
 * 
 * @param effectiveContextText - The actual text that will be sent as context
 * @param displayElement - The HTML element to update
 * @param contextLimit - Optional model context window limit
 * @param inputCost - Optional input cost per million tokens from models.dev
 * @param attachments - Optional array of attachment info (PDF, images, etc.)
 */
export function updateTokenCountWithAttachments(
	effectiveContextText: string,
	displayElement: HTMLElement,
	contextLimit: number | undefined,
	inputCost?: number,
	attachments?: AttachmentInfo[]
): void {
	const contextTokens = countTokens(effectiveContextText);
	
	// Calculate total tokens (context + all attachment tokens)
	const attachmentTokens = attachments?.reduce((sum, a) => sum + a.estimatedTokens * (a.count ?? 1), 0) ?? 0;
	const totalEstimatedTokens = contextTokens + attachmentTokens;
	
	// Build first line: token count
	const tokenParts: string[] = [];
	
	if (contextLimit) {
		const percentUsed = (totalEstimatedTokens / contextLimit) * 100;
		tokenParts.push(`~${totalEstimatedTokens.toLocaleString()} ${getMessage('tokens')} / ${contextLimit.toLocaleString()} (${percentUsed.toFixed(0)}%)`);
		
		// Warning at 70%, error at 90%
		displayElement.classList.toggle('warning', percentUsed > 70 && percentUsed <= 90);
		displayElement.classList.toggle('error', percentUsed > 90);
	} else {
		tokenParts.push(`~${totalEstimatedTokens.toLocaleString()} ${getMessage('tokens')}`);
		// Fall back to basic thresholds if no limit known
		displayElement.classList.toggle('warning', totalEstimatedTokens > 50000);
		displayElement.classList.toggle('error', totalEstimatedTokens > 100000);
	}
	
	// Add estimated cost if available
	if (inputCost !== undefined && inputCost > 0) {
		const estimatedCost = calculateInputCost(totalEstimatedTokens, inputCost);
		tokenParts.push(formatCost(estimatedCost, true));
	}
	
	// Clear existing content
	displayElement.textContent = '';
	
	// Add token line
	const tokenLine = document.createElement('div');
	tokenLine.textContent = tokenParts.join(' ');
	displayElement.appendChild(tokenLine);
	
	// Add attachments line if there are any
	if (attachments && attachments.length > 0) {
		const attachmentLine = document.createElement('div');
		attachmentLine.className = 'token-counter-attachments';
		
		// Format: "Attachments: 1 PDF, 2 images"
		const attachmentParts = attachments.map(a => {
			const count = a.count ?? 1;
			return `${count} ${a.type}`;
		});
		attachmentLine.textContent = `${getMessage('attachments')}: ${attachmentParts.join(', ')}`;
		displayElement.appendChild(attachmentLine);
	}
	
	displayElement.classList.remove('usage-complete');
}

/**
 * @deprecated Use updateTokenCountWithAttachments instead
 * Update token count display with PDF attachment info
 */
export function updateTokenCountWithPdf(
	effectiveContextText: string,
	displayElement: HTMLElement,
	contextLimit: number | undefined,
	inputCost?: number,
	pdfInfo?: PdfDisplayInfo
): void {
	const attachments: AttachmentInfo[] | undefined = pdfInfo 
		? [{ type: 'PDF', estimatedTokens: pdfInfo.extractedTokens, count: 1 }]
		: undefined;
	
	updateTokenCountWithAttachments(effectiveContextText, displayElement, contextLimit, inputCost, attachments);
}