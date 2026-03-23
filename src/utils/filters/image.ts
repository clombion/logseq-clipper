import { escapeMarkdown } from '../string-utils';

export const image = (str: string, param?: string): string | string[] => {
	if (!str.trim()) {
		return str;
	}

	let altText = '';
	if (param) {
		// Remove outer parentheses if present
		param = param.replace(/^\((.*)\)$/, '$1');
		// Remove surrounding quotes (both single and double)
		altText = param.replace(/^(['"])([\s\S]*)\1$/, '$2');
	}

	try {
		const data = JSON.parse(str);

		const processObject = (obj: Record<string, unknown>): string[] => {
			return Object.entries(obj).flatMap(([key, value]) => {
				if (typeof value === 'object' && value !== null) {
					return processObject(value as Record<string, unknown>);
				}
				return `![${escapeMarkdown(String(value))}](${escapeMarkdown(key)})`;
			});
		};

		if (Array.isArray(data)) {
			return data.flatMap((item) => {
				if (typeof item === 'object' && item !== null) {
					return processObject(item as Record<string, unknown>);
				}
				return item ? `![${altText}](${escapeMarkdown(String(item))})` : '';
			});
		} else if (typeof data === 'object' && data !== null) {
			return processObject(data as Record<string, unknown>);
		}
	} catch (_error) {
		// If parsing fails, treat it as a single URL string
		return `![${altText}](${escapeMarkdown(str)})`;
	}

	return str;
};
