import type { TemplateValue } from '../../types/types';
import { generalSettings } from '../storage-utils';

// This function doesn't really do anything, it just returns the whole prompt variable
// so that it's still visible in the input fields in the popup
export async function processPrompt(
	match: string,
	_variables: { [key: string]: TemplateValue },
	_currentUrl: string,
): Promise<string> {
	if (generalSettings.interpreterEnabled) {
		const promptRegex = /{{(?:prompt:)?"(.*?)"(\|.*?)?}}/;
		const matches = match.match(promptRegex);
		if (!matches) {
			console.error('Invalid prompt format:', match);
			return match;
		}

		const [, _promptText, _filters = ''] = matches;

		return match;
	} else {
		return '';
	}
}
