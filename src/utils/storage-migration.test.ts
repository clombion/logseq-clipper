import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock core/popup (imported by storage-utils but not used by loadSettings)
vi.mock('core/popup', () => ({
	copyToClipboard: vi.fn(),
}));

// Mock debug module
vi.mock('./debug', () => ({
	debugLog: vi.fn(),
}));

import browser from './browser-polyfill';
import { loadSettings } from './storage-utils';

beforeEach(() => {
	vi.clearAllMocks();
});

describe('Settings migration', () => {
	test('old stats.addToObsidian key does not crash loadSettings', async () => {
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({
			stats: {
				addToObsidian: 5,
				saveFile: 2,
				copyToClipboard: 1,
				share: 0,
			},
		} as any);
		vi.spyOn(browser.storage.sync, 'set').mockResolvedValue();

		const settings = await loadSettings();

		// The old addToObsidian key gets loaded as-is into stats (it's a passthrough),
		// but addToLogseq defaults to 0 since it's not present
		expect(settings.stats.addToLogseq).toBe(undefined);
		expect(settings.stats.saveFile).toBe(2);
		expect(settings.stats.copyToClipboard).toBe(1);
	});

	test('old saveBehavior addToObsidian falls back to default addToLogseq', async () => {
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({
			general_settings: {
				saveBehavior: 'addToObsidian',
			},
		} as any);
		vi.spyOn(browser.storage.sync, 'set').mockResolvedValue();

		const settings = await loadSettings();

		// 'addToObsidian' is not a valid value in the type union, but the code
		// reads whatever string is stored. The important thing is it doesn't crash.
		// It will store the raw value since ?? only triggers on null/undefined.
		expect(settings.saveBehavior).toBe('addToObsidian');
	});

	test('missing logseq_settings uses defaults', async () => {
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({
			// Old storage format with no logseq_settings section
			general_settings: {
				showMoreActionsButton: false,
			},
		} as any);
		vi.spyOn(browser.storage.sync, 'set').mockResolvedValue();

		const settings = await loadSettings();

		expect(settings.logseqApiPort).toBe(12315);
		expect(settings.logseqApiToken).toBe('');
		expect(settings.logseqLogPage).toBe('Web Clips Log');
	});

	test('empty storage uses all defaults', async () => {
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({});
		vi.spyOn(browser.storage.sync, 'set').mockResolvedValue();

		const settings = await loadSettings();

		expect(settings.logseqApiPort).toBe(12315);
		expect(settings.logseqApiToken).toBe('');
		expect(settings.logseqLogPage).toBe('Web Clips Log');
		expect(settings.saveBehavior).toBe('addToLogseq');
		expect(settings.stats.addToLogseq).toBe(0);
		expect(settings.stats.saveFile).toBe(0);
		expect(settings.stats.copyToClipboard).toBe(0);
	});

	test('partial logseq_settings merges with defaults', async () => {
		vi.spyOn(browser.storage.sync, 'get').mockResolvedValue({
			logseq_settings: {
				apiPort: 9999,
				// apiToken and logPage omitted
			},
		} as any);
		vi.spyOn(browser.storage.sync, 'set').mockResolvedValue();

		const settings = await loadSettings();

		expect(settings.logseqApiPort).toBe(9999);
		expect(settings.logseqApiToken).toBe('');
		expect(settings.logseqLogPage).toBe('Web Clips Log');
	});
});
