import type { HistoryEntry, ModelConfig, PropertyType, Provider, Rating, Settings } from '../types/types';
import browser from './browser-polyfill';
import { debugLog } from './debug';

export type { HistoryEntry, ModelConfig, PropertyType, Provider, Rating, Settings };

export let generalSettings: Settings = {
	openBehavior: 'popup',
	highlighterEnabled: true,
	alwaysShowHighlights: false,
	highlightBehavior: 'highlight-inline',
	showMoreActionsButton: false,
	interpreterModel: '',
	models: [],
	providers: [],
	interpreterEnabled: false,
	interpreterAutoRun: false,
	defaultPromptContext: '',
	propertyTypes: [],
	readerSettings: {
		fontSize: 1.5,
		lineHeight: 1.6,
		maxWidth: 38,
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

export function setLocalStorage(key: string, value: unknown): Promise<void> {
	return browser.storage.local.set({ [key]: value });
}

export function getLocalStorage(key: string): Promise<unknown> {
	return browser.storage.local.get(key).then((result: Record<string, unknown>) => result[key]);
}

interface StorageData {
	general_settings?: {
		showMoreActionsButton?: boolean;
		openBehavior?: boolean | 'popup' | 'embedded';
		saveBehavior?: 'addToLogseq' | 'copyToClipboard' | 'saveFile';
	};
	highlighter_settings?: {
		highlighterEnabled?: boolean;
		alwaysShowHighlights?: boolean;
		highlightBehavior?: string;
	};
	reader_settings?: {
		fontSize?: number;
		lineHeight?: number;
		maxWidth?: number;
		theme?: 'default' | 'flexoki';
		themeMode?: 'auto' | 'light' | 'dark';
	};
	interpreter_settings?: {
		interpreterModel?: string;
		models?: ModelConfig[];
		providers?: Provider[];
		interpreterEnabled?: boolean;
		interpreterAutoRun?: boolean;
		defaultPromptContext?: string;
	};
	logseq_settings?: {
		apiPort?: number;
		apiToken?: string;
		logPage?: string;
	};
	property_types?: PropertyType[];
	stats?: {
		addToLogseq: number;
		saveFile: number;
		copyToClipboard: number;
		share: number;
	};
	history?: HistoryEntry[];
	ratings?: Rating[];
	migrationVersion?: number;
}

const CURRENT_MIGRATION_VERSION = 1;

export async function loadSettings(): Promise<Settings> {
	const data = (await browser.storage.sync.get(null)) as StorageData;

	// Load credential data from local storage (never cloud-synced)
	const localData = await browser.storage.local.get(['interpreter_providers', 'logseq_settings']);
	const localProviders = localData.interpreter_providers as Provider[] | undefined;
	const localLogseq = localData.logseq_settings as StorageData['logseq_settings'] | undefined;

	// Migration: if providers exist in sync but not yet in local, use sync data (first load after upgrade)
	const effectiveProviders = localProviders ?? data.interpreter_settings?.providers;
	const effectiveLogseq = localLogseq ?? data.logseq_settings;

	// Load default settings first
	const defaultSettings: Settings = {
		showMoreActionsButton: false,
		openBehavior: 'popup',
		highlighterEnabled: true,
		alwaysShowHighlights: true,
		highlightBehavior: 'highlight-inline',
		interpreterModel: '',
		models: [],
		providers: [],
		interpreterEnabled: false,
		interpreterAutoRun: false,
		defaultPromptContext: '',
		propertyTypes: [],
		saveBehavior: 'addToLogseq',
		readerSettings: {
			fontSize: 1.5,
			lineHeight: 1.6,
			maxWidth: 38,
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
	};

	// Update migration version if needed
	if (!data.migrationVersion || data.migrationVersion < CURRENT_MIGRATION_VERSION) {
		await browser.storage.sync.set({ migrationVersion: CURRENT_MIGRATION_VERSION });
		debugLog('Settings', `Updated migration version to ${CURRENT_MIGRATION_VERSION}`);
	}

	// Validate and sanitize data to prevent corruption
	const sanitizedModels = Array.isArray(data.interpreter_settings?.models)
		? data.interpreter_settings.models.filter((m) => m && typeof m === 'object' && typeof m.id === 'string')
		: [];
	const sanitizedProviders = Array.isArray(effectiveProviders)
		? effectiveProviders.filter((p) => p && typeof p === 'object' && typeof p.id === 'string')
		: [];

	// Load user settings
	const loadedSettings: Settings = {
		showMoreActionsButton: data.general_settings?.showMoreActionsButton ?? defaultSettings.showMoreActionsButton,
		openBehavior:
			typeof data.general_settings?.openBehavior === 'boolean'
				? data.general_settings.openBehavior
					? 'embedded'
					: 'popup'
				: (data.general_settings?.openBehavior ?? defaultSettings.openBehavior),
		highlighterEnabled: data.highlighter_settings?.highlighterEnabled ?? defaultSettings.highlighterEnabled,
		alwaysShowHighlights: data.highlighter_settings?.alwaysShowHighlights ?? defaultSettings.alwaysShowHighlights,
		highlightBehavior: data.highlighter_settings?.highlightBehavior ?? defaultSettings.highlightBehavior,
		interpreterModel: data.interpreter_settings?.interpreterModel || defaultSettings.interpreterModel,
		models: sanitizedModels,
		providers: sanitizedProviders,
		interpreterEnabled: data.interpreter_settings?.interpreterEnabled ?? defaultSettings.interpreterEnabled,
		interpreterAutoRun: data.interpreter_settings?.interpreterAutoRun ?? defaultSettings.interpreterAutoRun,
		defaultPromptContext: data.interpreter_settings?.defaultPromptContext || defaultSettings.defaultPromptContext,
		propertyTypes: data.property_types ?? defaultSettings.propertyTypes,
		readerSettings: {
			fontSize: data.reader_settings?.fontSize ?? defaultSettings.readerSettings.fontSize,
			lineHeight: data.reader_settings?.lineHeight ?? defaultSettings.readerSettings.lineHeight,
			maxWidth: data.reader_settings?.maxWidth ?? defaultSettings.readerSettings.maxWidth,
			theme: (data.reader_settings?.theme as 'default' | 'flexoki') ?? defaultSettings.readerSettings.theme,
			themeMode:
				(data.reader_settings?.themeMode as 'auto' | 'light' | 'dark') ??
				defaultSettings.readerSettings.themeMode,
		},
		logseqApiPort: effectiveLogseq?.apiPort ?? defaultSettings.logseqApiPort,
		logseqApiToken: effectiveLogseq?.apiToken ?? defaultSettings.logseqApiToken,
		logseqLogPage: effectiveLogseq?.logPage ?? defaultSettings.logseqLogPage,
		stats: data.stats ?? defaultSettings.stats,
		history: data.history ?? defaultSettings.history,
		ratings: data.ratings ?? defaultSettings.ratings,
		saveBehavior: data.general_settings?.saveBehavior ?? defaultSettings.saveBehavior,
	};

	generalSettings = loadedSettings;

	// Migration: move credentials from sync to local on first load after upgrade
	if (!localProviders && data.interpreter_settings?.providers) {
		await browser.storage.local.set({ interpreter_providers: generalSettings.providers });
		const { providers: _removed, ...rest } = data.interpreter_settings;
		await browser.storage.sync.set({ interpreter_settings: rest });
		debugLog('Settings', 'Migrated providers from sync to local storage');
	} else if (data.interpreter_settings?.providers) {
		// Safety: if providers still exist in sync after a previous partial migration, clean up
		const { providers: _removed, ...rest } = data.interpreter_settings;
		await browser.storage.sync.set({ interpreter_settings: rest });
		debugLog('Settings', 'Cleaned up stale providers from sync storage');
	}
	if (!localLogseq && data.logseq_settings) {
		await browser.storage.local.set({ logseq_settings: data.logseq_settings });
		await browser.storage.sync.remove('logseq_settings');
		debugLog('Settings', 'Migrated logseq_settings from sync to local storage');
	} else if (data.logseq_settings) {
		// Safety: clean up stale logseq_settings from sync after partial migration
		await browser.storage.sync.remove('logseq_settings');
		debugLog('Settings', 'Cleaned up stale logseq_settings from sync storage');
	}

	debugLog('Settings', 'Loaded settings:', generalSettings);
	return generalSettings;
}

export async function saveSettings(settings?: Partial<Settings>): Promise<void> {
	if (settings) {
		generalSettings = { ...generalSettings, ...settings };
	}

	await browser.storage.sync.set({
		general_settings: {
			showMoreActionsButton: generalSettings.showMoreActionsButton,
			openBehavior: generalSettings.openBehavior,
			saveBehavior: generalSettings.saveBehavior,
		},
		highlighter_settings: {
			highlighterEnabled: generalSettings.highlighterEnabled,
			alwaysShowHighlights: generalSettings.alwaysShowHighlights,
			highlightBehavior: generalSettings.highlightBehavior,
		},
		interpreter_settings: {
			interpreterModel: generalSettings.interpreterModel,
			models: generalSettings.models,
			interpreterEnabled: generalSettings.interpreterEnabled,
			interpreterAutoRun: generalSettings.interpreterAutoRun,
			defaultPromptContext: generalSettings.defaultPromptContext,
		},
		property_types: generalSettings.propertyTypes,
		reader_settings: {
			fontSize: generalSettings.readerSettings.fontSize,
			lineHeight: generalSettings.readerSettings.lineHeight,
			maxWidth: generalSettings.readerSettings.maxWidth,
			theme: generalSettings.readerSettings.theme,
			themeMode: generalSettings.readerSettings.themeMode,
		},
		stats: generalSettings.stats,
	});

	// Credentials stored locally only — never cloud-synced
	await browser.storage.local.set({
		interpreter_providers: generalSettings.providers,
		logseq_settings: {
			apiPort: generalSettings.logseqApiPort,
			apiToken: generalSettings.logseqApiToken,
			logPage: generalSettings.logseqLogPage,
		},
	});
}

// HACK: load-then-save is non-atomic — concurrent calls can lose an increment.
// Acceptable because incrementStat is only called from single UI actions (click handlers)
// and the stats are cosmetic counters, not critical data.
export async function incrementStat(
	action: keyof Settings['stats'],
	path?: string,
	url?: string,
	title?: string,
): Promise<void> {
	const settings = await loadSettings();
	settings.stats[action]++;
	await saveSettings(settings);

	// Add history entry if URL is provided
	if (url) {
		await addHistoryEntry(action, url, title, path);
	}
}

export async function addHistoryEntry(
	action: keyof Settings['stats'],
	url: string,
	title?: string,
	path?: string,
): Promise<void> {
	const entry: HistoryEntry = {
		datetime: new Date().toISOString(),
		url,
		action,
		title,
		path,
	};

	// Get existing history from local storage
	const result = await browser.storage.local.get('history');
	const history: HistoryEntry[] = (result.history || []) as HistoryEntry[];

	// Add new entry at the beginning
	history.unshift(entry);

	// Keep only the last 1000 entries
	const trimmedHistory = history.slice(0, 1000);

	// Save back to local storage
	await browser.storage.local.set({ history: trimmedHistory });
}

export async function getClipHistory(): Promise<HistoryEntry[]> {
	const result = await browser.storage.local.get('history');
	return (result.history || []) as HistoryEntry[];
}

declare global {
	interface Window {
		debugStorage: (key?: string) => Promise<Record<string, unknown>>;
	}
}

// Make storage accessible from console — use `window.debugStorage()` to see all sync storage, or `window.debugStorage(key)` to see a specific key
if (typeof window !== 'undefined') {
	window.debugStorage = (key?: string) => {
		if (key) {
			return browser.storage.sync.get(key).then((data) => {
				debugLog('Storage', `Sync storage contents for key "${key}":`, data);
				return data;
			});
		}
		return browser.storage.sync.get(null).then((data) => {
			debugLog('Storage', 'Sync storage contents:', data);
			return data;
		});
	};
}
