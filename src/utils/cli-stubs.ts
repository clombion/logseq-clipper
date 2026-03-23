// Stubs for browser-only modules used in CLI build.
// These are aliased by esbuild so that transitive imports
// of browser-polyfill and storage-utils resolve without error.

import type { Settings } from '../types/types';

export default {} as unknown;

export const generalSettings: Settings = {
	openBehavior: 'popup',
	highlighterEnabled: false,
	alwaysShowHighlights: false,
	highlightBehavior: 'no-highlights',
	showMoreActionsButton: false,
	interpreterModel: '',
	models: [],
	providers: [],
	interpreterEnabled: false,
	interpreterAutoRun: false,
	defaultPromptContext: '',
	propertyTypes: [],
	readerSettings: {
		fontSize: 16,
		lineHeight: 1.5,
		maxWidth: 700,
		theme: 'default',
		themeMode: 'auto',
	},
	logseqApiPort: 12315,
	logseqApiToken: '',
	logseqLogPage: 'Web Clips Log',
	stats: {
		addToLogseq: 0,
		saveFile: 0,
		copyToClipboard: 0,
		share: 0,
	},
	history: [],
	ratings: [],
	saveBehavior: 'addToLogseq',
};

export const loadSettings = async () => {};
export const saveSettings = async () => {};
export const incrementStat = async () => {};
export const getLocalStorage = async () => ({});
export const setLocalStorage = async () => {};
