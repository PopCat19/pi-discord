/**
 * Sensitivity filter for redacting sensitive information from text.
 */

const SENSITIVE_PATTERNS = [
	// Discord secrets
	{ pattern: /[A-Za-z0-9]{24,}\.[A-Za-z0-9]{6}\.[A-Za-z0-9_-]{27,}/g, replacement: '[BOT_TOKEN]' },
	{ pattern: /[A-Za-z0-9_-]{32,}/g, replacement: '[API_KEY]' },
	
	// Common secret patterns
	{ pattern: /bot[_-]?token[:\s=]*[A-Za-z0-9._-]+/gi, replacement: 'bot_token=[BOT_TOKEN]' },
	{ pattern: /api[_-]?key[:\s=]*[A-Za-z0-9._-]+/gi, replacement: 'api_key=[API_KEY]' },
	{ pattern: /password[:\s=]*[^\s]+/gi, replacement: 'password=[REDACTED]' },
	{ pattern: /secret[:\s=]*[^\s]+/gi, replacement: 'secret=[REDACTED]' },
	{ pattern: /token[:\s=]*[A-Za-z0-9._-]+/gi, replacement: 'token=[REDACTED]' },
	
	// Personal information
	{ pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[CARD]' },
	{ pattern: /\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/g, replacement: '[PHONE]' },
	{ pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
	
	// Discord specific
	{ pattern: /discord\.gg\/[a-zA-Z0-9]+/g, replacement: '[INVITE]' },
	{ pattern: /discord\.com\/invite\/[a-zA-Z0-9]+/g, replacement: '[INVITE]' },
	
	// URLs with credentials
	{ pattern: /https?:\/\/[^:]+:[^@]+@/g, replacement: 'https://[REDACTED]:' },
];

/**
 * Redact sensitive information from text.
 * @param {string} text - Text to sanitize
 * @returns {string} Sanitized text
 */
export function sanitize(text) {
	if (typeof text !== 'string') return text;
	
	let cleaned = text;
	for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
		cleaned = cleaned.replace(pattern, replacement);
	}
	return cleaned;
}

/**
 * Sanitize an object recursively.
 * @param {unknown} obj - Object to sanitize
 * @returns {unknown} Sanitized object
 */
export function sanitizeObject(obj) {
	if (typeof obj === 'string') {
		return sanitize(obj);
	}
	if (Array.isArray(obj)) {
		return obj.map(sanitizeObject);
	}
	if (obj && typeof obj === 'object') {
		const result = {};
		for (const [key, value] of Object.entries(obj)) {
			// Also skip keys that look sensitive
			if (/token|secret|password|key|credential/i.test(key)) {
				result[key] = '[REDACTED]';
			} else {
				result[key] = sanitizeObject(value);
			}
		}
		return result;
	}
	return obj;
}