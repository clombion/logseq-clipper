import { debugLog } from '../debug';
import type { ParamValidationResult } from '../filters';

export const validateTemplateParams = (param: string | undefined): ParamValidationResult => {
	if (!param) {
		// biome-ignore lint/suspicious/noTemplateCurlyInString: template syntax example in error message
		return { valid: false, error: 'requires a template string (e.g., template:"${name}")' };
	}

	return { valid: true };
};

export const template = (input: string | unknown[], param?: string): string => {
	debugLog('Template', 'Template input:', input);
	debugLog('Template', 'Template param:', param);

	if (!param) {
		debugLog('Template', 'No param provided, returning input');
		return typeof input === 'string' ? input : JSON.stringify(input);
	}

	// Remove outer parentheses if present
	param = param.replace(/^\((.*)\)$/, '$1');
	// Remove surrounding quotes (both single and double)
	param = param.replace(/^(['"])([\s\S]*)\1$/, '$2');

	let obj: unknown[] = [];
	if (typeof input === 'string') {
		try {
			obj = JSON.parse(input);
			debugLog('Template', 'Parsed input:', obj);
		} catch (_error) {
			debugLog('Template', 'Parsing failed, using input as is');
			obj = [input];
		}
	} else {
		obj = input;
	}

	// Ensure obj is always an array
	obj = Array.isArray(obj) ? obj : [obj];

	debugLog('Template', 'Object to process:', obj);

	const result = obj.map((item) => replaceTemplateVariables(item, param)).join('\n\n');
	debugLog('Template', 'Processing result:', result);
	return result;
};

function replaceTemplateVariables(obj: unknown, template: string): string {
	debugLog('Template', 'Replacing template variables for:', obj);
	debugLog('Template', 'Template:', template);

	// If obj is a plain string, make it available as ${str} for template compatibility
	let resolved: Record<string, unknown> = {};
	if (typeof obj === 'string') {
		const strValue = obj;
		try {
			resolved = parseObjectString(obj);
			debugLog('Template', 'Parsed object:', resolved);
		} catch (_error) {
			debugLog('Template', 'Failed to parse object string:', obj);
		}
		// Ensure str property is set for plain strings
		if (resolved.str === undefined) {
			resolved.str = strValue;
		}
	} else if (typeof obj === 'object' && obj !== null) {
		resolved = obj as Record<string, unknown>;
	}

	let result = template.replace(/\$\{([\w.]+)\}/g, (match, path) => {
		debugLog('Template', 'Replacing:', match);
		const value = getNestedProperty(resolved, path);
		debugLog('Template', 'Replaced with:', value);
		return value !== undefined && value !== 'undefined' ? String(value) : '';
	});

	debugLog('Template', 'Result after variable replacement:', result);

	// Replace \n with actual newlines
	result = result.replace(/\\n/g, '\n');
	debugLog('Template', 'Result after newline replacement:', result);

	// Remove any empty lines (which might be caused by undefined values)
	result = result
		.split('\n')
		.filter((line) => line.trim() !== '')
		.join('\n');
	debugLog('Template', 'Result after empty line removal:', result);

	return result.trim();
}

function parseObjectString(str: string): Record<string, unknown> {
	const obj: Record<string, unknown> = {};
	const regex = /(\w+):\s*("(?:\\.|[^"\\])*"|[^,}]+)/g;
	let match: RegExpExecArray | null = regex.exec(str);

	while (match !== null) {
		let [, key, value] = match;
		// Remove quotes from the value if it's a string
		if (value?.startsWith('"') && value?.endsWith('"')) {
			value = value?.slice(1, -1);
		}
		obj[key!] = value === 'undefined' ? undefined : value;
		match = regex.exec(str);
	}

	return obj;
}

function getNestedProperty(obj: Record<string, unknown>, path: string): unknown {
	debugLog('Template', 'Getting nested property:', { obj, path });
	const result = path.split('.').reduce<unknown>((current, key) => {
		return current && typeof current === 'object' ? (current as Record<string, unknown>)[key] : undefined;
	}, obj);
	debugLog('Template', 'Nested property result:', result);
	return result;
}
