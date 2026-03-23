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

		const processObject = (obj: Record<string, unknown>): string[] => {
			return Object.entries(obj).flatMap(([key, value]) => {
				if (typeof value === 'object' && value !== null) {
					return processObject(value as Record<string, unknown>);
				}
				return `[${escapeMarkdown(String(value))}](${encodeUrl(escapeMarkdown(key))})`;
			});
		};

		if (Array.isArray(data)) {
			const result = data.map((item) => {
				if (typeof item === 'object' && item !== null) {
					return processObject(item as Record<string, unknown>);
				}
				return item ? `[${linkText}](${encodeUrl(escapeMarkdown(String(item)))})` : '';
			});
			return result.join('\n');
		} else if (typeof data === 'object' && data !== null) {
			return processObject(data as Record<string, unknown>).join('\n');
		}
	} catch (_error) {
		// If parsing fails, treat it as a single URL string
		return `[${linkText}](${encodeUrl(escapeMarkdown(str))})`;
	}

	return str;
};
