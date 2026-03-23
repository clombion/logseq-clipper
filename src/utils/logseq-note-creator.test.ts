import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./logseq-api', () => ({
	createPage: vi.fn(),
	getPage: vi.fn(),
	appendBlockInPage: vi.fn(),
	prependBlockInPage: vi.fn(),
	insertBatchBlock: vi.fn(),
	getPageBlocksTree: vi.fn(),
	queryByProperty: vi.fn(),
	removeBlock: vi.fn(),
	upsertBlockProperty: vi.fn(),
	getTodayJournalPageName: vi.fn().mockResolvedValue('Mar 23rd, 2026'),
}));

vi.mock('./markdown-to-blocks', () => ({
	markdownToBlocks: vi.fn(),
}));

// Mock storage-utils so generalSettings is writable
vi.mock('./storage-utils', () => ({
	generalSettings: {
		logseqApiPort: 12315,
		logseqApiToken: 'test-token',
		logseqLogPage: 'Web Clips Log',
	},
}));

// Mock crypto.subtle for SHA-256
const mockDigest = vi.fn();
vi.stubGlobal('crypto', {
	subtle: {
		digest: mockDigest,
	},
});

import {
	createPage,
	getPage,
	appendBlockInPage,
	prependBlockInPage,
	insertBatchBlock,
	getPageBlocksTree,
	queryByProperty,
	removeBlock,
	upsertBlockProperty,
} from './logseq-api';
import { markdownToBlocks } from './markdown-to-blocks';
import {
	checkDuplicate,
	saveToLogseq,
	updateExistingClip,
	computeContentHash,
	syncSettings,
} from './logseq-note-creator';
import { generalSettings } from './storage-utils';

const mockedQueryByProperty = vi.mocked(queryByProperty);
const mockedCreatePage = vi.mocked(createPage);
const mockedGetPage = vi.mocked(getPage);
const mockedAppendBlockInPage = vi.mocked(appendBlockInPage);
const mockedPrependBlockInPage = vi.mocked(prependBlockInPage);
const mockedInsertBatchBlock = vi.mocked(insertBatchBlock);
const mockedGetPageBlocksTree = vi.mocked(getPageBlocksTree);
const mockedRemoveBlock = vi.mocked(removeBlock);
const mockedUpsertBlockProperty = vi.mocked(upsertBlockProperty);
const mockedMarkdownToBlocks = vi.mocked(markdownToBlocks);

// Helper: SHA-256 of empty-ish content
function stubHashDigest() {
	// Return a fixed 32-byte ArrayBuffer
	const buf = new Uint8Array(32);
	buf[0] = 0xab;
	buf[1] = 0xcd;
	mockDigest.mockResolvedValue(buf.buffer);
}

beforeEach(() => {
	vi.clearAllMocks();
	stubHashDigest();
	// Default: appendBlockInPage returns a block with uuid for log entries
	mockedAppendBlockInPage.mockResolvedValue({ uuid: 'log-block-uuid', content: '' });
	mockedInsertBatchBlock.mockResolvedValue([]);
});

describe('checkDuplicate', () => {
	test('returns exists:true when queryByProperty finds results', async () => {
		mockedQueryByProperty.mockResolvedValue([
			{
				uuid: 'log-entry-1',
				content: '[[My Article]]',
				properties: {
					source: 'https://example.com/article',
					'clipped-at': '2025-01-01T00:00:00.000Z',
					'destination-page': 'My Article',
				},
			},
		]);
		mockedGetPage.mockResolvedValue({ name: 'my article', uuid: 'page-1' });

		const result = await checkDuplicate('https://example.com/article');

		expect(result.exists).toBe(true);
		expect(result.pageTitle).toBe('My Article');
		expect(result.destinationPage).toBe('My Article');
		expect(result.clippedAt).toBe('2025-01-01T00:00:00.000Z');
	});

	test('returns exists:false when no results', async () => {
		mockedQueryByProperty.mockResolvedValue([]);

		const result = await checkDuplicate('https://example.com/new');

		expect(result.exists).toBe(false);
		expect(result.pageTitle).toBeUndefined();
		expect(result.clippedAt).toBeUndefined();
	});
});

describe('saveToLogseq', () => {
	test('create behavior calls createPage with empty props, upsertBlockProperty for each property, then appendBlockInPage + insertBatchBlock', async () => {
		const blocks = [
			{ content: 'Hello world' },
			{ content: 'Second block' },
		];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedCreatePage.mockResolvedValue({ name: 'Test Note', uuid: 'page-uuid' });
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'anchor-uuid', content: 'Hello world' });

		await saveToLogseq(
			'Hello world\n\nSecond block',
			'Test Note',
			[{ name: 'tags', value: 'test' }],
			'create',
			'https://example.com',
		);

		// createPage called without properties (upsertBlockProperty handles props)
		expect(mockedCreatePage).toHaveBeenCalledTimes(1);
		const createArgs = mockedCreatePage.mock.calls[0];
		expect(createArgs[1]).toBe('Test Note');
		expect(createArgs[2]).toEqual({ redirect: false });

		// upsertBlockProperty called only for template properties (not source/clipped-at)
		expect(mockedUpsertBlockProperty).toHaveBeenCalledTimes(1);
		expect(mockedUpsertBlockProperty).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'page-uuid',
			'tags',
			'test',
		);

		// appendBlockInPage called with page name and first block content
		expect(mockedAppendBlockInPage).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'Test Note',
			'Hello world',
		);

		// insertBatchBlock called with anchor uuid for remaining blocks as siblings
		expect(mockedInsertBatchBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'anchor-uuid',
			[{ content: 'Second block' }],
			{ sibling: true },
		);
	});

	test('create with null page from createPage throws "Failed to create page"', async () => {
		mockedMarkdownToBlocks.mockReturnValue([{ content: 'test' }]);
		mockedCreatePage.mockResolvedValue(null as any);

		await expect(
			saveToLogseq('test', 'Bad Page', [], 'create', 'https://example.com'),
		).rejects.toThrow("Failed to create page 'Bad Page'");
	});

	test('create with null anchor from appendBlockInPage throws "Failed to create block"', async () => {
		mockedMarkdownToBlocks.mockReturnValue([{ content: 'test' }]);
		mockedCreatePage.mockResolvedValue({ name: 'Test', uuid: 'page-uuid' });
		mockedAppendBlockInPage.mockResolvedValue(null as any);

		await expect(
			saveToLogseq('test', 'Test', [], 'create', 'https://example.com'),
		).rejects.toThrow("Failed to create block on page 'Test'");
	});

	test('create on existing page — upsertBlockProperty called (verifies F2 fix)', async () => {
		mockedMarkdownToBlocks.mockReturnValue([]);
		// createPage on existing page returns the existing page entity
		mockedCreatePage.mockResolvedValue({ name: 'Existing', uuid: 'existing-uuid' });

		await saveToLogseq('', 'Existing', [{ name: 'tags', value: 'retest' }], 'create', 'https://example.com/existing');

		// upsertBlockProperty is the mechanism that works for existing pages (template props only)
		expect(mockedUpsertBlockProperty).toHaveBeenCalledTimes(1);
		expect(mockedUpsertBlockProperty).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'existing-uuid',
			'tags',
			'retest',
		);
	});

	test('append-specific creates metadata parent with properties, content as children', async () => {
		const blocks = [{ content: 'Appended content' }];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'meta-uuid', content: '' });

		await saveToLogseq(
			'Appended content',
			'Existing Page',
			[{ name: 'resource', value: 'Test Resource' }],
			'append-specific',
			'https://example.com/append',
		);

		// Metadata block created with template properties only (no source/clipped-at)
		const appendCalls = mockedAppendBlockInPage.mock.calls;
		const metaCall = appendCalls.find((c) => c[1] === 'Existing Page' && c[2] !== '');
		expect(metaCall).toBeDefined();
		expect(metaCall![2]).toContain('resource:: Test Resource');
		// source and clipped-at are no longer injected into the metadata block
		expect(metaCall![2]).not.toMatch(/^source::/m);
		expect(metaCall![2]).not.toMatch(/^clipped-at::/m);

		// Content inserted as children via insertBatchBlock
		expect(mockedInsertBatchBlock).toHaveBeenCalledWith(
			expect.anything(),
			'meta-uuid',
			blocks,
			{ sibling: false },
		);
	});

	test('always calls appendToClipLog (log entry created)', async () => {
		mockedMarkdownToBlocks.mockReturnValue([{ content: 'test' }]);
		mockedCreatePage.mockResolvedValue({ name: 'Log Test', uuid: 'p-uuid' });
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'anchor-uuid', content: '' });

		await saveToLogseq(
			'test content',
			'Log Test',
			[],
			'create',
			'https://example.com/log',
		);

		// appendBlockInPage should be called for the clip log
		const logCall = mockedAppendBlockInPage.mock.calls.find(
			(c) => c[1] === 'Web Clips Log',
		);
		expect(logCall).toBeDefined();
		expect(logCall![2]).toBe('[[Log Test]]');
	});

	test('template properties passed through via upsertBlockProperty, no source/clipped-at', async () => {
		mockedMarkdownToBlocks.mockReturnValue([]);
		mockedCreatePage.mockResolvedValue({ name: 'Props Test', uuid: 'p-uuid' });

		await saveToLogseq(
			'',
			'Props Test',
			[{ name: 'author', value: 'Alice' }],
			'create',
			'https://example.com/props',
		);

		// createPage called without properties (upsertBlockProperty handles them)
		expect(mockedCreatePage.mock.calls[0][2]).toEqual({ redirect: false });

		// Only template properties set via upsertBlockProperty
		expect(mockedUpsertBlockProperty).toHaveBeenCalledTimes(1);
		const upsertCalls = mockedUpsertBlockProperty.mock.calls;

		const authorCall = upsertCalls.find(c => c[2] === 'author');
		expect(authorCall).toBeDefined();
		expect(authorCall![3]).toBe('Alice');

		// source and clipped-at are NOT set via upsertBlockProperty
		const sourceCall = upsertCalls.find(c => c[2] === 'source');
		expect(sourceCall).toBeUndefined();
		const clippedAtCall = upsertCalls.find(c => c[2] === 'clipped-at');
		expect(clippedAtCall).toBeUndefined();
	});

	test('prepend-specific creates metadata parent with properties, content as children', async () => {
		const blocks = [{ content: 'Prepended content' }];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedPrependBlockInPage.mockResolvedValue({ uuid: 'meta-uuid', content: '' });

		await saveToLogseq(
			'Prepended content',
			'Prepend Page',
			[],
			'prepend-specific',
			'https://example.com/prepend',
		);

		expect(mockedPrependBlockInPage).toHaveBeenCalled();
		const prependCall = mockedPrependBlockInPage.mock.calls.find(
			(c) => c[1] === 'Prepend Page',
		);
		expect(prependCall).toBeDefined();
		// Metadata block contains only template properties (none here), not source/clipped-at
		expect(prependCall![2]).not.toContain('source::');
		expect(prependCall![2]).not.toContain('clipped-at::');

		expect(mockedInsertBatchBlock).toHaveBeenCalledWith(
			expect.anything(),
			'meta-uuid',
			blocks,
			{ sibling: false },
		);
	});
});

describe('updateExistingClip', () => {
	test('gets page, upserts properties, removes ALL old blocks, inserts new ones, appends log', async () => {
		mockedGetPage.mockResolvedValue({ uuid: 'page-uuid', name: 'Existing Article' });
		mockedGetPageBlocksTree.mockResolvedValue([
			{ uuid: 'block-1', content: 'first block' },
			{ uuid: 'block-2', content: 'old content 1' },
			{ uuid: 'block-3', content: 'old content 2' },
		]);
		const newBlocks = [{ content: 'Updated content' }];
		mockedMarkdownToBlocks.mockReturnValue(newBlocks);
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'new-anchor', content: 'Updated content' });

		await updateExistingClip(
			'Existing Article',
			'Updated content',
			[{ name: 'tags', value: 'updated' }],
			'https://example.com/existing',
		);

		// getPage called
		expect(mockedGetPage).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'Existing Article',
		);

		// upsertBlockProperty for template properties only (not source/clipped-at)
		expect(mockedUpsertBlockProperty).toHaveBeenCalledTimes(1);
		expect(mockedUpsertBlockProperty).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'page-uuid',
			'tags',
			'updated',
		);

		// ALL old blocks removed (not skipping first)
		expect(mockedRemoveBlock).toHaveBeenCalledTimes(3);
		expect(mockedRemoveBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'block-1',
		);
		expect(mockedRemoveBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'block-2',
		);
		expect(mockedRemoveBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'block-3',
		);

		// New content inserted via appendBlockInPage
		expect(mockedAppendBlockInPage).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'Existing Article',
			'Updated content',
		);

		// Log entry created with replaces pointer
		const logCall = mockedAppendBlockInPage.mock.calls.find(
			(c) => c[1] === 'Web Clips Log',
		);
		expect(logCall).toBeDefined();
		expect(logCall![2]).toBe('[[Existing Article]]');

		// Check that log properties include replaces
		const logInsertCall = mockedInsertBatchBlock.mock.calls.find(
			(c) => {
				const blocks = c[2] as any[];
				return blocks.some((b: any) => b.content?.includes('replaces::'));
			},
		);
		expect(logInsertCall).toBeDefined();
	});

	test('empty tree from getPageBlocksTree — removeBlock not called, new content still inserted', async () => {
		mockedGetPage.mockResolvedValue({ uuid: 'page-uuid', name: 'Empty Page' });
		mockedGetPageBlocksTree.mockResolvedValue([]);
		mockedMarkdownToBlocks.mockReturnValue([{ content: 'New content' }]);
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'new-anchor', content: 'New content' });

		await updateExistingClip(
			'Empty Page',
			'New content',
			[],
			'https://example.com/empty',
		);

		// No old blocks to remove
		expect(mockedRemoveBlock).not.toHaveBeenCalled();

		// New content still inserted
		expect(mockedAppendBlockInPage).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'Empty Page',
			'New content',
		);
	});

	test('null page from getPage throws "Page not found"', async () => {
		mockedGetPage.mockResolvedValue(null);

		await expect(
			updateExistingClip('Missing Page', 'content', [], 'https://example.com'),
		).rejects.toThrow("Page 'Missing Page' not found");
	});
});

describe('computeContentHash', () => {
	test('returns consistent SHA-256 hex string', async () => {
		const hash = await computeContentHash('test content');

		expect(mockDigest).toHaveBeenCalledWith('SHA-256', expect.any(Uint8Array));
		// Our mock returns 32 bytes starting with 0xab, 0xcd, then zeros
		expect(hash).toBe('abcd' + '00'.repeat(30));
		expect(hash).toHaveLength(64);
	});

	test('same input produces same output', async () => {
		const hash1 = await computeContentHash('identical');
		const hash2 = await computeContentHash('identical');

		expect(hash1).toBe(hash2);
	});
});


describe('clip log entry format', () => {
	test('new clip log entry has source, clipped-at, content-hash properties', async () => {
		mockedMarkdownToBlocks.mockReturnValue([{ content: 'test' }]);
		mockedCreatePage.mockResolvedValue({ name: 'My Page', uuid: 'p-uuid' });
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'anchor-uuid', content: '' });

		await saveToLogseq('test', 'My Page', [], 'create', 'https://example.com');

		// Find the insertBatchBlock call for the log entry
		const logInsertCall = mockedInsertBatchBlock.mock.calls.find(
			(c) => {
				const blocks = c[2] as any[];
				return blocks.some((b: any) => b.content?.includes('source::'));
			},
		);
		expect(logInsertCall).toBeDefined();
		const propChildren = logInsertCall![2] as { content: string }[];
		const propKeys = propChildren.map((b) => b.content.split('::')[0].trim());
		expect(propKeys).toContain('source');
		expect(propKeys).toContain('clipped-at');
		expect(propKeys).toContain('content-hash');
	});

	test('update log entry includes replaces property', async () => {
		mockedGetPage.mockResolvedValue({ uuid: 'page-uuid', name: 'Old Page' });
		mockedGetPageBlocksTree.mockResolvedValue([
			{ uuid: 'old-block', content: 'old' },
		]);
		mockedMarkdownToBlocks.mockReturnValue([{ content: 'new' }]);
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'new-anchor', content: 'new' });

		await updateExistingClip('Old Page', 'new content', [], 'https://example.com/old');

		const logInsertCall = mockedInsertBatchBlock.mock.calls.find(
			(c) => {
				const blocks = c[2] as { content: string }[];
				return blocks.some((b) => b.content.includes('replaces::'));
			},
		);
		expect(logInsertCall).toBeDefined();
		const propChildren = logInsertCall![2] as { content: string }[];
		const replacesBlock = propChildren.find((b) => b.content.startsWith('replaces::'));
		expect(replacesBlock).toBeDefined();
		expect(replacesBlock!.content).toContain('Old Page');
	});

	test('log entry content is wiki-link format [[Page Title]]', async () => {
		mockedMarkdownToBlocks.mockReturnValue([]);
		mockedCreatePage.mockResolvedValue({ name: 'Wiki Test', uuid: 'p-uuid' });

		await saveToLogseq('', 'Wiki Test', [], 'create', 'https://example.com');

		const logCall = mockedAppendBlockInPage.mock.calls.find(
			(c) => c[1] === 'Web Clips Log',
		);
		expect(logCall).toBeDefined();
		expect(logCall![2]).toBe('[[Wiki Test]]');
	});
});

describe('syncSettings', () => {
	test('write calls appendBlockInPage with settings JSON on the log page', async () => {
		await syncSettings('write');

		const call = mockedAppendBlockInPage.mock.calls.find(
			(c) => c[1] === 'Web Clips Log',
		);
		expect(call).toBeDefined();
		const content = call![2] as string;
		expect(content).toContain('## Settings');
		expect(content).toContain('```json');
		// Should contain serialized generalSettings
		const parsed = JSON.parse(content.match(/```json\n([\s\S]*?)\n```/)![1]);
		expect(parsed.logseqApiPort).toBe(12315);
	});

	test('write with null from appendBlockInPage returns gracefully', async () => {
		mockedAppendBlockInPage.mockResolvedValue(null as any);

		// Should not throw
		await syncSettings('write');

		expect(mockedAppendBlockInPage).toHaveBeenCalled();
	});

	test('read parses settings from log page blocks and updates generalSettings', async () => {
		const settingsPayload = JSON.stringify({ logseqApiPort: 9999 });
		mockedGetPageBlocksTree.mockResolvedValue([
			{
				uuid: 'settings-block',
				content: `## Settings\n\`\`\`json\n${settingsPayload}\n\`\`\``,
			},
		]);

		await syncSettings('read');

		expect(generalSettings.logseqApiPort).toBe(9999);
		// Restore for other tests
		(generalSettings as any).logseqApiPort = 12315;
	});
});

describe('saveToLogseq edge cases', () => {
	test('empty noteContent still creates page with properties via upsertBlockProperty', async () => {
		mockedMarkdownToBlocks.mockReturnValue([]);
		mockedCreatePage.mockResolvedValue({ name: 'Empty Note', uuid: 'p-uuid' });

		await saveToLogseq(
			'',
			'Empty Note',
			[{ name: 'tags', value: 'empty' }],
			'create',
			'https://example.com/empty',
		);

		expect(mockedCreatePage).toHaveBeenCalledTimes(1);
		// createPage called without properties
		expect(mockedCreatePage.mock.calls[0][2]).toEqual({ redirect: false });

		// Only template properties set via upsertBlockProperty (not source/clipped-at)
		expect(mockedUpsertBlockProperty).toHaveBeenCalledTimes(1);
		expect(mockedUpsertBlockProperty).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'p-uuid',
			'tags',
			'empty',
		);

		// insertBatchBlock should NOT be called for content (no blocks)
		// but IS called for the log entry
		const contentInsertCalls = mockedInsertBatchBlock.mock.calls.filter(
			(c) => {
				const blocks = c[2] as any[];
				return !blocks.some((b: any) => b.content?.includes('::'));
			},
		);
		expect(contentInsertCalls).toHaveLength(0);
	});

	test('prepend-daily creates metadata block on journal page with content as children', async () => {
		const blocks = [{ content: 'Prepended daily content' }];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedPrependBlockInPage.mockResolvedValue({ uuid: 'meta-uuid', content: '' });

		await saveToLogseq(
			'Prepended daily content',
			'Some Title',
			[],
			'prepend-daily',
			'https://example.com/prepend-daily',
		);

		expect(mockedPrependBlockInPage).toHaveBeenCalled();
		const prependCall = mockedPrependBlockInPage.mock.calls[0];
		expect(prependCall[1]).toBe('Mar 23rd, 2026');
		// Metadata block contains only template properties (none here), not source/clipped-at
		expect(prependCall[2]).not.toContain('source::');
		expect(prependCall[2]).not.toContain('clipped-at::');

		expect(mockedInsertBatchBlock).toHaveBeenCalledWith(
			expect.anything(),
			'meta-uuid',
			blocks,
			{ sibling: false },
		);
	});

	test('append-daily creates metadata block on journal page with content as children', async () => {
		const blocks = [{ content: 'Daily content' }];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'meta-uuid', content: '' });

		await saveToLogseq(
			'Daily content',
			'Some Title',
			[],
			'append-daily',
			'https://example.com/daily',
		);

		// Metadata block is created on journal page (even if empty, since no template props)
		const journalCalls = mockedAppendBlockInPage.mock.calls.filter(
			(c) => c[1] === 'Mar 23rd, 2026',
		);
		expect(journalCalls.length).toBeGreaterThanOrEqual(1);
		// None of the journal calls should contain source:: or clipped-at::
		for (const call of journalCalls) {
			expect(call[2]).not.toContain('source::');
			expect(call[2]).not.toContain('clipped-at::');
		}

		expect(mockedInsertBatchBlock).toHaveBeenCalledWith(
			expect.anything(),
			'meta-uuid',
			blocks,
			{ sibling: false },
		);
	});
});

describe('checkDuplicate error handling', () => {
	test('does not crash when API throws, returns exists: false', async () => {
		mockedQueryByProperty.mockRejectedValue(new Error('network error'));

		const result = await checkDuplicate('https://example.com/error');
		expect(result).toEqual({ exists: false });
	});
});

describe('appendToClipLog null guard', () => {
	test('null anchor from appendBlockInPage returns gracefully, no crash', async () => {
		mockedMarkdownToBlocks.mockReturnValue([]);
		mockedCreatePage.mockResolvedValue({ name: 'Log Null Test', uuid: 'p-uuid' });
		// First call for clip log returns null (simulating appendBlockInPage failure)
		mockedAppendBlockInPage.mockResolvedValue(null as any);

		// Should not throw — appendToClipLog handles null gracefully
		await saveToLogseq('', 'Log Null Test', [], 'create', 'https://example.com/log-null');

		// insertBatchBlock should NOT be called for log props since anchor was null
		const logInsertCalls = mockedInsertBatchBlock.mock.calls.filter(
			(c) => {
				const blocks = c[2] as any[];
				return blocks.some((b: any) => b.content?.includes('source::'));
			},
		);
		expect(logInsertCalls).toHaveLength(0);
	});
});
