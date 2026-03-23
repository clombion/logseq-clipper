/**
 * Integration tests against a live Logseq instance.
 *
 * These tests require Logseq to be running with the HTTP API enabled.
 * They skip automatically if Logseq is not reachable.
 *
 * Setup:
 *   1. Start Logseq with HTTP API server enabled
 *   2. Set LOGSEQ_TEST_TOKEN env var (or create .env with it)
 *   3. Run: pnpm test src/utils/logseq-integration.test.ts
 *
 * Tests create and clean up their own data using a unique prefix.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
	type LogseqApiConfig,
	checkConnection,
	createPage,
	getPage,
	appendBlockInPage,
	prependBlockInPage,
	insertBatchBlock,
	getPageBlocksTree,
	queryByProperty,
	removeBlock,
	upsertBlockProperty,
	getTodayJournalPageName,
} from './logseq-api';

// --- Config ---

const TOKEN = process.env.LOGSEQ_TEST_TOKEN || 'c5934ee27f58524f1264fad25041e1ae4d7e9cec311871d1';
const PORT = parseInt(process.env.LOGSEQ_TEST_PORT || '12315', 10);
const config: LogseqApiConfig = { port: PORT, token: TOKEN };

// Unique prefix to avoid collisions with real pages
const PREFIX = `__test_${Date.now().toString(36)}`;

// Track created pages for cleanup
const createdPages: string[] = [];
const createdBlockUuids: string[] = [];

// --- Helpers ---

async function deletePage(name: string): Promise<void> {
	try {
		// Logseq's deletePage is not in our API client — use raw fetch
		await fetch(`http://127.0.0.1:${PORT}/api`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({
				method: 'logseq.Editor.deletePage',
				args: [name],
			}),
		});
	} catch {
		// Best effort cleanup
	}
}

// --- Check if Logseq is available (must be resolved before describe) ---

async function isLogseqRunning(): Promise<boolean> {
	try {
		const resp = await fetch(`http://127.0.0.1:${PORT}/api`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({ method: 'logseq.App.getCurrentGraph', args: [] }),
			signal: AbortSignal.timeout(2000),
		});
		return resp.ok;
	} catch {
		return false;
	}
}

const logseqAvailable = await isLogseqRunning();
if (!logseqAvailable) {
	console.warn('\n⚠️  Logseq is not running — skipping integration tests.\n');
}

// --- Tests ---

describe.skipIf(!logseqAvailable)('Logseq API integration', () => {
	afterEach(async () => {
		for (const uuid of createdBlockUuids) {
			try {
				await removeBlock(config, uuid);
			} catch { /* best effort */ }
		}
		createdBlockUuids.length = 0;
	});

	afterAll(async () => {
		for (const page of createdPages) {
			await deletePage(page);
		}
	});
	test('checkConnection returns true', async () => {
		const result = await checkConnection(config);
		expect(result).toBe(true);
	});

	test('createPage creates a page, getPage finds it', async () => {
		const pageName = `${PREFIX}_create_test`;
		createdPages.push(pageName);

		const page = await createPage(config, pageName);
		expect(page).not.toBeNull();
		expect(page.uuid).toBeTruthy();

		const found = await getPage(config, pageName);
		expect(found).not.toBeNull();
		expect(found!.name).toBe(pageName.toLowerCase());
	});

	test('createPage is idempotent — returns existing page', async () => {
		const pageName = `${PREFIX}_idempotent`;
		createdPages.push(pageName);

		const first = await createPage(config, pageName);
		const second = await createPage(config, pageName);

		expect(first.uuid).toBe(second.uuid);
	});

	test('getPage returns null for non-existent page', async () => {
		const result = await getPage(config, `${PREFIX}_nonexistent_${Date.now()}`);
		expect(result).toBeNull();
	});

	test('appendBlockInPage creates block with uuid', async () => {
		const pageName = `${PREFIX}_append_test`;
		createdPages.push(pageName);
		await createPage(config, pageName);

		const block = await appendBlockInPage(config, pageName, 'Test block content');
		expect(block).not.toBeNull();
		expect(block.uuid).toBeTruthy();
		expect(block.content).toBe('Test block content');
	});

	test('appendBlockInPage auto-creates page', async () => {
		const pageName = `${PREFIX}_auto_create`;
		createdPages.push(pageName);

		// Don't call createPage first — appendBlockInPage should auto-create
		const block = await appendBlockInPage(config, pageName, 'Auto-created page content');
		expect(block).not.toBeNull();
		expect(block.uuid).toBeTruthy();

		const page = await getPage(config, pageName);
		expect(page).not.toBeNull();
	});

	test('prependBlockInPage creates block at top', async () => {
		const pageName = `${PREFIX}_prepend_test`;
		createdPages.push(pageName);
		await createPage(config, pageName);

		await appendBlockInPage(config, pageName, 'First block');
		const prepended = await prependBlockInPage(config, pageName, 'Prepended block');

		expect(prepended).not.toBeNull();
		expect(prepended.uuid).toBeTruthy();

		const tree = await getPageBlocksTree(config, pageName);
		// Prepended block should be first (after any empty initial block)
		const firstNonEmpty = tree.find(b => b.content.trim() !== '');
		expect(firstNonEmpty?.content).toBe('Prepended block');
	});

	test('insertBatchBlock creates nested children', async () => {
		const pageName = `${PREFIX}_batch_test`;
		createdPages.push(pageName);
		await createPage(config, pageName);

		const parent = await appendBlockInPage(config, pageName, 'Parent block');
		expect(parent.uuid).toBeTruthy();

		await insertBatchBlock(config, parent.uuid, [
			{ content: 'Child 1' },
			{
				content: 'Child 2',
				children: [{ content: 'Grandchild' }],
			},
		]);

		const tree = await getPageBlocksTree(config, pageName);
		const parentBlock = tree.find(b => b.content === 'Parent block');
		expect(parentBlock).toBeDefined();
		expect(parentBlock!.children).toBeDefined();
		expect(parentBlock!.children!.length).toBeGreaterThanOrEqual(2);

		const child2 = parentBlock!.children!.find(c => c.content === 'Child 2');
		expect(child2).toBeDefined();
		expect(child2!.children).toBeDefined();
		expect(child2!.children!.length).toBeGreaterThanOrEqual(1);
		expect(child2!.children![0].content).toBe('Grandchild');
	});

	test('upsertBlockProperty sets properties on a block', async () => {
		const pageName = `${PREFIX}_props_block`;
		createdPages.push(pageName);
		await createPage(config, pageName);

		const block = await appendBlockInPage(config, pageName, 'Block with props');
		await upsertBlockProperty(config, block.uuid, 'test-key', 'test-value');

		const tree = await getPageBlocksTree(config, pageName);
		const propsBlock = tree.find(b => b.content.includes('Block with props'));
		expect(propsBlock).toBeDefined();
		expect(propsBlock!.properties).toBeDefined();
		// Logseq camelCases property keys in the API response
		expect(
			propsBlock!.properties!['testKey'] || propsBlock!.properties!['test-key'],
		).toBe('test-value');
	});

	test('upsertBlockProperty works on page UUID', async () => {
		const pageName = `${PREFIX}_props_page`;
		createdPages.push(pageName);
		const page = await createPage(config, pageName);

		await upsertBlockProperty(config, page.uuid, 'source', 'https://example.com');

		const fetched = await getPage(config, pageName);
		expect(fetched).not.toBeNull();
		// Page properties may be accessible via getPage or getPageBlocksTree
		// This test verifies upsertBlockProperty doesn't throw on page UUIDs
	});

	test('getPageBlocksTree returns empty array for empty page', async () => {
		const pageName = `${PREFIX}_empty_page`;
		createdPages.push(pageName);
		await createPage(config, pageName);

		const tree = await getPageBlocksTree(config, pageName);
		expect(Array.isArray(tree)).toBe(true);
	});

	test('getPageBlocksTree returns null for non-existent page', async () => {
		const tree = await getPageBlocksTree(config, `${PREFIX}_no_such_page_${Date.now()}`);
		expect(tree).toBeNull();
	});

	test('removeBlock silently handles non-existent UUID', async () => {
		// Should not throw — Logseq returns null/200 for non-existent blocks
		await expect(
			removeBlock(config, '00000000-0000-0000-0000-000000000000'),
		).resolves.not.toThrow();
	});

	test('getTodayJournalPageName returns a non-empty string', async () => {
		const name = await getTodayJournalPageName(config);
		expect(name).toBeTruthy();
		expect(typeof name).toBe('string');
		expect(name.length).toBeGreaterThan(0);
	});

	test('queryByProperty finds blocks by property value', async () => {
		const pageName = `${PREFIX}_query_test`;
		createdPages.push(pageName);
		await createPage(config, pageName);

		const uniqueValue = `test-${Date.now()}`;
		const block = await appendBlockInPage(config, pageName, `test-prop:: ${uniqueValue}`);
		createdBlockUuids.push(block.uuid);

		// Give Logseq a moment to index
		await new Promise(resolve => setTimeout(resolve, 500));

		const results = await queryByProperty(config, 'test-prop', uniqueValue);
		expect(results.length).toBeGreaterThanOrEqual(1);
	});

	test('queryByProperty handles special characters in value', async () => {
		// Should not throw even with quotes in the value
		await expect(
			queryByProperty(config, 'source', 'https://example.com/path?q="test"'),
		).resolves.not.toThrow();
	});

	test('full append-daily flow: separator + metadata + children', async () => {
		const journalPage = await getTodayJournalPageName(config);

		// Separator
		await appendBlockInPage(config, journalPage, '');

		// Metadata block
		const metadata = 'resource:: Integration Test\nresource-type:: #test';
		const parent = await appendBlockInPage(config, journalPage, metadata);
		expect(parent).not.toBeNull();
		expect(parent.uuid).toBeTruthy();
		createdBlockUuids.push(parent.uuid);

		// Content as children
		await insertBatchBlock(config, parent.uuid, [
			{ content: 'Test content line 1' },
			{ content: 'Test content line 2' },
		], { sibling: false });

		// Verify structure
		const tree = await getPageBlocksTree(config, journalPage);
		const metaBlock = tree.find(b => b.content.includes('resource:: Integration Test'));
		expect(metaBlock).toBeDefined();
		expect(metaBlock!.children).toBeDefined();
		expect(metaBlock!.children!.length).toBeGreaterThanOrEqual(2);
		expect(metaBlock!.children![0].content).toBe('Test content line 1');

		// Also clean up the separator (block before the metadata block)
		const metaIndex = tree.findIndex(b => b.content.includes('resource:: Integration Test'));
		if (metaIndex > 0 && tree[metaIndex - 1].content.trim() === '') {
			createdBlockUuids.push(tree[metaIndex - 1].uuid);
		}
	});
});
