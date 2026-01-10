/**
 * PDF detection utilities for identifying PDF documents.
 * This module provides lightweight, synchronous detection based on URL patterns.
 * 
 * IMPORTANT: These functions provide heuristic hints only, not authoritative detection.
 * For authoritative PDF detection, use verifyPdfContentType() from pdf-extractor.ts
 * which checks the actual Content-Type header from the server.
 * 
 * Use cases for this module:
 * - Fast synchronous checks for template trigger matching (type:pdf)
 * - Deciding whether to attempt PDF extraction
 * - UI hints before making network requests
 */

/**
 * Academic PDF URL patterns for major publishers and repositories.
 * These patterns detect PDF URLs that don't end in .pdf extension.
 */
const ACADEMIC_PDF_PATTERNS = [
	/arxiv\.org\/pdf\//i,
	/arxiv\.org\/ftp\//i,
	/dl\.acm\.org\/doi\/pdf\//i,
	/link\.springer\.com\/content\/pdf\//i,
	/openreview\.net\/pdf/i,
	/papers\.nips\.cc\/.*\.pdf$/i,
	/proceedings\.mlr\.press\/.*\.pdf$/i,
];

/**
 * Checks if a URL likely points to a PDF document based on URL pattern matching.
 * This is a fast, synchronous HEURISTIC check suitable for trigger matching.
 * 
 * NOTE: This is NOT authoritative. A URL matching these patterns might return
 * HTML (e.g., login page) and a URL not matching might still serve a PDF.
 * For authoritative detection, use verifyPdfContentType() from pdf-extractor.ts.
 * 
 * Supports:
 * - Direct .pdf URLs (e.g., example.com/document.pdf)
 * - ArXiv PDF URLs (e.g., arxiv.org/pdf/2301.00001)
 * - ACM Digital Library PDFs (e.g., dl.acm.org/doi/pdf/...)
 * - Springer PDFs (e.g., link.springer.com/content/pdf/...)
 * - OpenReview PDFs (e.g., openreview.net/pdf?id=...)
 * - NeurIPS/MLIR proceedings
 * 
 * @param url - The URL to check
 * @returns true if the URL appears to be a PDF based on URL patterns, false otherwise
 * 
 * @example
 * isPdfUrl('https://example.com/document.pdf') // true
 * isPdfUrl('https://example.com/document.pdf?download=1') // true
 * isPdfUrl('https://example.com/document.PDF') // true (case insensitive)
 * isPdfUrl('https://arxiv.org/pdf/2301.00001') // true
 * isPdfUrl('https://arxiv.org/abs/2301.00001') // false (abstract page)
 * isPdfUrl('https://example.com/page.html') // false
 */
export function isPdfUrl(url: string): boolean {
	if (!url) return false;

	// Check academic patterns first (these don't require URL parsing)
	for (const pattern of ACADEMIC_PDF_PATTERNS) {
		if (pattern.test(url)) return true;
	}

	try {
		const urlObj = new URL(url);
		
		// Only support http/https protocols (not file://)
		if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
			return false;
		}

		// Check if the pathname ends with .pdf (ignoring query string and hash)
		return /\.pdf$/i.test(urlObj.pathname);
	} catch {
		// If URL parsing fails, fall back to simple pattern matching
		return /\.pdf(\?.*)?$/i.test(url);
	}
}

/**
 * Extracts the filename from a PDF URL.
 * 
 * @param url - The PDF URL
 * @returns The filename without extension, or 'document' as fallback
 * 
 * @example
 * getPdfFilename('https://example.com/my-document.pdf') // 'my-document'
 * getPdfFilename('https://example.com/path/to/file.pdf?v=1') // 'file'
 */
export function getPdfFilename(url: string): string {
	if (!url) return 'document';

	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname;
		
		// Extract the filename from the path
		const filename = pathname.split('/').pop() || 'document';
		
		// Remove .pdf extension (case insensitive)
		return filename.replace(/\.pdf$/i, '') || 'document';
	} catch {
		// Fallback: try to extract from the raw URL
		const match = url.match(/([^/]+)\.pdf/i);
		return match ? match[1] : 'document';
	}
}
