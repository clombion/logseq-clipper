import { escapeMarkdown } from '../string-utils';

export const link = (str: string, param?: string): string => {
	if (!str.trim()) {
		return str;
	}

	let linkText = 'link';
	if (param) {
		// Remove outer parentheses if present
		param = param.replace(/^\((.*)\)$/, '$1');
		// Remove surrounding quotes (both single and double)
		linkText = param.replace(/^(['"])([\s\S]*)\1$/, '$2');
	}

	const encodeUrl = (url: string): string => {
		return url.replace(/ /g, '%20');
	};

	try {
		const data: unknown = JSON.parse(str);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
		const processObject = (obj: any): string[] => {
			return Object.entries(obj).flatMap(([key, value]) => {
				if (typeof value === 'object' && value !== null) {
					return processObject(value);
				}
				return `[${escapeMarkdown(String(value))}](${encodeUrl(escapeMarkdown(key))})`;
			});
		};

		if (Array.isArray(data)) {
			const result = data.map((item) => {
				if (typeof item === 'object' && item !== null) {
					return processObject(item);
				}
				return item ? `[${linkText}](${encodeUrl(escapeMarkdown(String(item)))})` : '';
			});
			return result.join('\n');
		} else if (typeof data === 'object' && data !== null) {
			return processObject(data).join('\n');
		}
	} catch (_error) {
		// If parsing fails, treat it as a single URL string
		return `[${linkText}](${encodeUrl(escapeMarkdown(str))})`;
	}

	return str;
};
