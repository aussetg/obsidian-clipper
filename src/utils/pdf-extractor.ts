/**
 * PDF extraction module for extracting text and metadata from PDF documents.
 * This module is designed to be lazy-loaded to minimize bundle size.
 * It runs in the background script context using fake worker mode for MV3 compatibility.
 */

import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/**
 * Options for PDF extraction
 */
export interface PdfExtractionOptions {
	/** Include base64-encoded PDF data for LLM attachment */
	includeBase64?: boolean;
}

/**
 * Result of PDF extraction
 */
export interface PdfExtractionResult {
	success: boolean;
	text: string;
	title: string;
	author: string;
	pages: number;
	error?: string;
	sizeBytes?: number;
	sizeWarning?: boolean;
	/** Base64-encoded PDF data (only present if includeBase64 option was true and size < 25MB) */
	base64?: string;
	/** The raw ArrayBuffer, used for caching and lazy base64 conversion */
	arrayBuffer?: ArrayBuffer;
	/** Whether the result came from cache */
	fromCache?: boolean;
}

/**
 * Result of Content-Type verification
 */
export interface ContentTypeVerification {
	isPdf: boolean;
	contentLength?: number;
	error?: string;
}

/**
 * Size limit for base64 encoding (25MB)
 * PDFs larger than this can still have text extracted, but won't be attached to LLMs
 */
export const BASE64_SIZE_LIMIT = 25 * 1024 * 1024;

/**
 * Size threshold for warning (10MB)
 */
const SIZE_WARNING_THRESHOLD = 10 * 1024 * 1024;

/**
 * Lazily loaded PDF.js library
 */
let pdfjsLib: typeof import('pdfjs-dist') | null = null;

/**
 * Loads PDF.js library on demand and configures it for service worker context.
 * Uses fake worker mode for MV3 service worker compatibility.
 */
async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
	if (pdfjsLib) {
		return pdfjsLib;
	}

	// Dynamic import to enable webpack chunking
	pdfjsLib = await import('pdfjs-dist');
	
	// Configure the worker source for PDF.js
	// In a browser extension, we need to point to the bundled worker file
	// The worker file is copied to the extension root by webpack
	if (typeof pdfjsLib.GlobalWorkerOptions !== 'undefined') {
		// Check if we're in a browser extension context
		if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL) {
			pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL('pdf.worker.min.mjs');
		} else if (typeof browser !== 'undefined' && (browser as any).runtime && (browser as any).runtime.getURL) {
			pdfjsLib.GlobalWorkerOptions.workerSrc = (browser as any).runtime.getURL('pdf.worker.min.mjs');
		} else {
			// Fallback: try to use the worker from the same directory
			pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdf.worker.min.mjs';
		}
	}

	return pdfjsLib;
}

/**
 * Converts an ArrayBuffer to a base64 string.
 * Processes in chunks to avoid call stack limits.
 */
export function arrayBufferToBase64(arrayBuffer: ArrayBuffer): string {
	const uint8Array = new Uint8Array(arrayBuffer);
	let binaryString = '';
	const chunkSize = 8192; // Process in chunks to avoid call stack limits
	
	for (let i = 0; i < uint8Array.length; i += chunkSize) {
		const chunk = uint8Array.subarray(i, i + chunkSize);
		binaryString += String.fromCharCode.apply(null, Array.from(chunk));
	}
	
	return btoa(binaryString);
}

/**
 * Verifies that a URL points to a PDF by checking the Content-Type header.
 * Uses HEAD request first, falls back to GET + abort if HEAD fails (405).
 * 
 * @param url - The URL to verify
 * @returns Verification result with isPdf flag, contentLength, and optional error
 */
export async function verifyPdfContentType(url: string): Promise<ContentTypeVerification> {
	// Try HEAD request first
	try {
		const headResponse = await fetch(url, { method: 'HEAD' });
		const contentType = headResponse.headers.get('Content-Type') || '';
		const contentLength = parseInt(headResponse.headers.get('Content-Length') || '0', 10);
		
		if (contentType.includes('application/pdf')) {
			return { isPdf: true, contentLength };
		}
		
		if (contentType.includes('text/html')) {
			return { 
				isPdf: false, 
				error: 'This URL returned an HTML page. You may need to log in first.' 
			};
		}
		
		// Some other content type
		return { 
			isPdf: false, 
			error: `Unexpected content type: ${contentType}` 
		};
		
	} catch (headError) {
		// HEAD failed (405, network error, etc.) - fall back to GET with abort
		const controller = new AbortController();
		
		try {
			const getResponse = await fetch(url, { signal: controller.signal });
			const contentType = getResponse.headers.get('Content-Type') || '';
			const contentLength = parseInt(getResponse.headers.get('Content-Length') || '0', 10);
			
			// Abort immediately - we only needed headers
			controller.abort();
			
			if (contentType.includes('application/pdf')) {
				return { isPdf: true, contentLength };
			}
			
			if (contentType.includes('text/html')) {
				return { 
					isPdf: false, 
					error: 'This URL returned an HTML page. You may need to log in first.' 
				};
			}
			
			return { 
				isPdf: false, 
				error: `Unexpected content type: ${contentType}` 
			};
			
		} catch (getError) {
			// AbortError is expected after we got headers
			if (getError instanceof Error && getError.name === 'AbortError') {
				// We shouldn't reach here if we processed headers above
				// This means the abort happened before we could read headers
				return { isPdf: false, error: 'Failed to verify PDF type' };
			}
			
			// Check for CORS errors
			if (getError instanceof TypeError && getError.message.includes('Failed to fetch')) {
				return { 
					isPdf: false, 
					error: 'Unable to access this PDF. The website may be blocking external access.' 
				};
			}
			
			return { 
				isPdf: false, 
				error: `Failed to verify PDF: ${getError instanceof Error ? getError.message : String(getError)}` 
			};
		}
	}
}

/**
 * Extracts text and metadata from a PDF ArrayBuffer.
 * This is the core extraction logic, separated from fetching.
 * 
 * @param arrayBuffer - The PDF data as ArrayBuffer
 * @returns Extraction result with text and metadata
 */
export async function extractPdfFromBuffer(arrayBuffer: ArrayBuffer): Promise<{
	success: boolean;
	text: string;
	title: string;
	author: string;
	pages: number;
	error?: string;
}> {
	try {
		// Load PDF.js
		const pdfjs = await loadPdfJs();

		// Load the PDF document with fake worker mode options
		// We pass worker: null to prevent PDF.js from trying to use a web worker
		// This is required for MV3 service workers where web workers aren't available
		const loadingTask = pdfjs.getDocument({
			data: arrayBuffer,
			useWorkerFetch: false,
			isEvalSupported: false,
			useSystemFonts: true
		});

		const pdf: PDFDocumentProxy = await loadingTask.promise;

		// Extract metadata
		const metadata = await pdf.getMetadata();
		const info = metadata.info as Record<string, unknown>;
		
		const title = extractMetadataField(info, 'Title') || '';
		const author = extractMetadataField(info, 'Author') || '';
		const pages = pdf.numPages;

		// Extract text from all pages
		const textParts: string[] = [];
		for (let i = 1; i <= pages; i++) {
			const page: PDFPageProxy = await pdf.getPage(i);
			const textContent = await page.getTextContent();
			
			// Combine text items with proper spacing
			const pageText = textContent.items
				.map((item: any) => {
					if ('str' in item) {
						return item.str;
					}
					return '';
				})
				.join(' ');
			
			textParts.push(pageText);
		}

		const text = textParts.join('\n\n');

		return {
			success: true,
			text,
			title,
			author,
			pages
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		
		// Provide user-friendly error messages
		let friendlyMessage = errorMessage;
		if (errorMessage.includes('password')) {
			friendlyMessage = 'Password-protected PDFs are not supported';
		} else if (errorMessage.includes('Invalid PDF')) {
			friendlyMessage = 'Unable to read this PDF. The file may be corrupted.';
		}

		return {
			success: false,
			text: `[PDF extraction failed: ${friendlyMessage}]`,
			title: '',
			author: '',
			pages: 0,
			error: friendlyMessage
		};
	}
}

/**
 * Extracts text and metadata from a PDF URL.
 * 
 * @param url - The URL of the PDF to extract
 * @param options - Extraction options (e.g., includeBase64 for LLM attachment)
 * @returns Extraction result with text, metadata, arrayBuffer, and optionally base64 data
 */
export async function extractPdfContent(url: string, options?: PdfExtractionOptions): Promise<PdfExtractionResult> {
	try {
		// Fetch the PDF data
		const response = await fetch(url);
		
		if (!response.ok) {
			return {
				success: false,
				text: `[PDF extraction failed: ${response.status} ${response.statusText}]`,
				title: '',
				author: '',
				pages: 0,
				error: `HTTP ${response.status}: ${response.statusText}`
			};
		}

		const arrayBuffer = await response.arrayBuffer();
		const sizeBytes = arrayBuffer.byteLength;
		const sizeWarning = sizeBytes > SIZE_WARNING_THRESHOLD;

		// Make a copy of the ArrayBuffer for PDF.js since it may transfer/detach the original
		// We keep the original for caching and base64 conversion
		const arrayBufferCopy = arrayBuffer.slice(0);

		// Extract text and metadata from the buffer copy
		const extraction = await extractPdfFromBuffer(arrayBufferCopy);
		
		if (!extraction.success) {
			return {
				...extraction,
				sizeBytes,
				sizeWarning
			};
		}

		// Convert to base64 if requested and under size limit
		let base64: string | undefined;
		let base64SizeWarning = false;
		
		if (options?.includeBase64) {
			if (sizeBytes < BASE64_SIZE_LIMIT) {
				base64 = arrayBufferToBase64(arrayBuffer);
			} else {
				base64SizeWarning = true;
			}
		}

		return {
			success: true,
			text: extraction.text,
			title: extraction.title,
			author: extraction.author,
			pages: extraction.pages,
			sizeBytes,
			sizeWarning: sizeWarning || base64SizeWarning,
			base64,
			arrayBuffer // Return for caching
		};
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		
		// Check for CORS errors
		let friendlyMessage = errorMessage;
		if (error instanceof TypeError && errorMessage.includes('Failed to fetch')) {
			friendlyMessage = 'Unable to access this PDF. The website may be blocking external access.';
		}

		return {
			success: false,
			text: `[PDF extraction failed: ${friendlyMessage}]`,
			title: '',
			author: '',
			pages: 0,
			error: friendlyMessage
		};
	}
}

/**
 * Extracts a metadata field from PDF info, handling various formats.
 */
function extractMetadataField(info: Record<string, unknown>, field: string): string {
	const value = info[field];
	
	if (typeof value === 'string') {
		return value;
	}
	
	if (value && typeof value === 'object' && 'str' in value) {
		return String((value as { str: unknown }).str);
	}
	
	return '';
}

/**
 * Formats a file size in bytes to a human-readable string.
 * 
 * @param bytes - Size in bytes
 * @returns Formatted string like "2.3MB" or "456KB"
 */
export function formatFileSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes}B`;
	} else if (bytes < 1024 * 1024) {
		return `${(bytes / 1024).toFixed(1)}KB`;
	} else {
		return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
	}
}
