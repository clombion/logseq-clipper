import type { ParamValidationResult } from '../filters';

const validOsParams = ['windows', 'mac', 'linux'];

export const validateSafeNameParams = (param: string | undefined): ParamValidationResult => {
	// No param is valid (defaults to most conservative)
	if (!param) {
		return { valid: true };
	}

	if (!validOsParams.includes(param.toLowerCase().trim())) {
		return {
			valid: false,
			error: `invalid OS "${param}". Use "windows", "mac", or "linux"`,
		};
	}

	return { valid: true };
};

export const safe_name = (str: string, param?: string): string => {
	const os = param ? param.toLowerCase().trim() : 'default';

	let sanitized = str;

	// First remove characters that should be sanitized across all platforms
	sanitized = sanitized.replace(/[#|^[\]]/g, '');

	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character stripping for filesystem safety
	const controlCharsWindows = /[<>:"/\\|?*\x00-\x1F]/g;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character stripping for filesystem safety
	const controlCharsMac = /[/:\x00-\x1F]/g;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character stripping for filesystem safety
	const controlCharsLinux = /[/\x00-\x1F]/g;
	// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character stripping for filesystem safety
	const controlCharsDefault = /[<>:"/\\|?*:\x00-\x1F]/g;

	switch (os) {
		case 'windows':
			sanitized = sanitized
				.replace(controlCharsWindows, '')
				.replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2')
				.replace(/[\s.]+$/, '');
			break;
		case 'mac':
			sanitized = sanitized.replace(controlCharsMac, '').replace(/^\./, '_');
			break;
		case 'linux':
			sanitized = sanitized.replace(controlCharsLinux, '').replace(/^\./, '_');
			break;
		default:
			// Most conservative approach (combination of all rules)
			sanitized = sanitized
				.replace(controlCharsDefault, '')
				.replace(/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i, '_$1$2')
				.replace(/[\s.]+$/, '')
				.replace(/^\./, '_');
			break;
	}

	// Common operations for all platforms
	sanitized = sanitized
		.replace(/^\.+/, '') // Remove leading periods
		.slice(0, 245); // Trim to leave room for ' 1.md'

	// Ensure the file name is not empty
	if (sanitized.length === 0) {
		sanitized = 'Untitled';
	}

	return sanitized;
};
