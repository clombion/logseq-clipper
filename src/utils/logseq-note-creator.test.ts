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
	appendBlockInPage,
	prependBlockInPage,
	insertBatchBlock,
	getPageBlocksTree,
	queryByProperty,
	removeBlock,
} from './logseq-api';
import { markdownToBlocks } from './markdown-to-blocks';
import {
	checkDuplicate,
	saveToLogseq,
	updateExistingClip,
	computeContentHash,
} from './logseq-note-creator';

const mockedQueryByProperty = vi.mocked(queryByProperty);
const mockedCreatePage = vi.mocked(createPage);
const mockedAppendBlockInPage = vi.mocked(appendBlockInPage);
const mockedPrependBlockInPage = vi.mocked(prependBlockInPage);
const mockedInsertBatchBlock = vi.mocked(insertBatchBlock);
const mockedGetPageBlocksTree = vi.mocked(getPageBlocksTree);
const mockedRemoveBlock = vi.mocked(removeBlock);
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
				name: 'My Article',
				uuid: 'page-1',
				properties: { 'clipped-at': '2025-01-01T00:00:00.000Z' },
			},
		]);

		const result = await checkDuplicate('https://example.com/article');

		expect(result.exists).toBe(true);
		expect(result.pageTitle).toBe('My Article');
		expect(result.clippedAt).toBe('2025-01-01T00:00:00.000Z');
		expect(mockedQueryByProperty).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'source',
			'https://example.com/article',
		);
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
	test('create behavior calls createPage with properties, then insertBatchBlock', async () => {
		const blocks = [
			{ content: 'Hello world' },
			{ content: 'Second block' },
		];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedCreatePage.mockResolvedValue({ name: 'Test Note', uuid: 'page-uuid' });
		mockedGetPageBlocksTree.mockResolvedValue([
			{ uuid: 'first-block-uuid', content: '' },
		]);

		await saveToLogseq(
			'Hello world\n\nSecond block',
			'Test Note',
			[{ name: 'tags', value: 'test' }],
			'create',
			'https://example.com',
		);

		// createPage called with properties including source and clipped-at
		expect(mockedCreatePage).toHaveBeenCalledTimes(1);
		const createArgs = mockedCreatePage.mock.calls[0];
		expect(createArgs[1]).toBe('Test Note');
		expect(createArgs[2]).toMatchObject({
			tags: 'test',
			source: 'https://example.com',
		});
		expect(createArgs[2]).toHaveProperty('clipped-at');

		// insertBatchBlock called with first block UUID
		expect(mockedInsertBatchBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'first-block-uuid',
			blocks,
		);
	});

	test('append-specific calls appendBlockInPage', async () => {
		const blocks = [{ content: 'Appended content' }];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedAppendBlockInPage.mockResolvedValue({ uuid: 'appended-uuid', content: 'Appended content' });

		await saveToLogseq(
			'Appended content',
			'Existing Page',
			[],
			'append-specific',
			'https://example.com/append',
		);

		// appendBlockInPage called (at least for content + log)
		const appendCalls = mockedAppendBlockInPage.mock.calls;
		const contentCall = appendCalls.find((c) => c[1] === 'Existing Page');
		expect(contentCall).toBeDefined();
		expect(contentCall![2]).toBe('Appended content');
	});

	test('always calls appendToClipLog (log entry created)', async () => {
		mockedMarkdownToBlocks.mockReturnValue([{ content: 'test' }]);
		mockedCreatePage.mockResolvedValue({ name: 'Log Test', uuid: 'p-uuid' });
		mockedGetPageBlocksTree.mockResolvedValue([{ uuid: 'fb-uuid', content: '' }]);

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

	test('properties include source and clipped-at', async () => {
		mockedMarkdownToBlocks.mockReturnValue([]);
		mockedCreatePage.mockResolvedValue({ name: 'Props Test', uuid: 'p-uuid' });
		mockedGetPageBlocksTree.mockResolvedValue([]);

		await saveToLogseq(
			'',
			'Props Test',
			[{ name: 'author', value: 'Alice' }],
			'create',
			'https://example.com/props',
		);

		const propsArg = mockedCreatePage.mock.calls[0][2] as Record<string, string>;
		expect(propsArg['source']).toBe('https://example.com/props');
		expect(propsArg['clipped-at']).toBeDefined();
		expect(propsArg['author']).toBe('Alice');
	});

	test('prepend-specific calls prependBlockInPage', async () => {
		const blocks = [{ content: 'Prepended content' }];
		mockedMarkdownToBlocks.mockReturnValue(blocks);
		mockedPrependBlockInPage.mockResolvedValue({ uuid: 'prepend-uuid', content: 'Prepended content' });

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
		expect(prependCall![2]).toBe('Prepended content');
	});
});

describe('updateExistingClip', () => {
	test('removes old blocks, inserts new ones, appends log with replaces', async () => {
		mockedGetPageBlocksTree.mockResolvedValue([
			{ uuid: 'props-block', content: 'properties block' },
			{ uuid: 'old-block-1', content: 'old content 1' },
			{ uuid: 'old-block-2', content: 'old content 2' },
		]);
		const newBlocks = [{ content: 'Updated content' }];
		mockedMarkdownToBlocks.mockReturnValue(newBlocks);

		await updateExistingClip(
			'Existing Article',
			'Updated content',
			[{ name: 'tags', value: 'updated' }],
			'https://example.com/existing',
		);

		// Old content blocks removed (not the first/properties block)
		expect(mockedRemoveBlock).toHaveBeenCalledTimes(2);
		expect(mockedRemoveBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'old-block-1',
		);
		expect(mockedRemoveBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'old-block-2',
		);

		// New blocks inserted under the properties block
		expect(mockedInsertBatchBlock).toHaveBeenCalledWith(
			{ port: 12315, token: 'test-token' },
			'props-block',
			newBlocks,
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
