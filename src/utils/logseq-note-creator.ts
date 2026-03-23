import {
	type LogseqApiConfig,
	type IBatchBlock,
	type LogseqBlock,
	createPage,
	appendBlockInPage,
	prependBlockInPage,
	insertBatchBlock,
	getPageBlocksTree,
	queryByProperty,
	removeBlock,
} from './logseq-api';
import { markdownToBlocks } from './markdown-to-blocks';
import { generalSettings } from './storage-utils';
import { type Property, type Template } from '../types/types';

function getApiConfig(): LogseqApiConfig {
	return {
		port: generalSettings.logseqApiPort,
		token: generalSettings.logseqApiToken,
	};
}

export async function checkDuplicate(url: string): Promise<{
	exists: boolean;
	pageTitle?: string;
	clippedAt?: string;
}> {
	const config = getApiConfig();
	const results = await queryByProperty(config, 'source', url);

	if (results && results.length > 0) {
		const first = results[0];
		return {
			exists: true,
			pageTitle: first.name ?? first['original-name'] ?? first.originalName,
			clippedAt: first.properties?.['clipped-at'] ?? first.properties?.clippedAt,
		};
	}

	return { exists: false };
}

export async function saveToLogseq(
	noteContent: string,
	noteName: string,
	properties: Property[],
	behavior: Template['behavior'],
	sourceUrl: string,
): Promise<void> {
	const config = getApiConfig();
	const now = new Date().toISOString();

	const propsObj: Record<string, string> = {};
	for (const prop of properties) {
		propsObj[prop.name] = prop.value;
	}
	propsObj['source'] = sourceUrl;
	propsObj['clipped-at'] = now;

	const blocks = markdownToBlocks(noteContent);
	const contentHash = await computeContentHash(noteContent);

	switch (behavior) {
		case 'create': {
			const page = await createPage(config, noteName, propsObj, {
				createFirstBlock: true,
				redirect: false,
			});
			const tree = await getPageBlocksTree(config, noteName);
			if (tree.length > 0 && blocks.length > 0) {
				await insertBatchBlock(config, tree[0].uuid, blocks);
			}
			break;
		}
		case 'append-specific': {
			if (blocks.length > 0) {
				const anchor = await appendBlockInPage(config, noteName, blocks[0].content);
				if (blocks[0].children && blocks[0].children.length > 0) {
					await insertBatchBlock(config, anchor.uuid, blocks[0].children);
				}
				for (let i = 1; i < blocks.length; i++) {
					const blk = await appendBlockInPage(config, noteName, blocks[i].content);
					if (blocks[i].children && blocks[i].children.length > 0) {
						await insertBatchBlock(config, blk.uuid, blocks[i].children);
					}
				}
			} else {
				await appendBlockInPage(config, noteName, noteContent);
			}
			break;
		}
		case 'append-daily': {
			const journalPage = getTodayJournalPageName();
			if (blocks.length > 0) {
				const anchor = await appendBlockInPage(config, journalPage, blocks[0].content);
				if (blocks[0].children && blocks[0].children.length > 0) {
					await insertBatchBlock(config, anchor.uuid, blocks[0].children);
				}
				for (let i = 1; i < blocks.length; i++) {
					const blk = await appendBlockInPage(config, journalPage, blocks[i].content);
					if (blocks[i].children && blocks[i].children.length > 0) {
						await insertBatchBlock(config, blk.uuid, blocks[i].children);
					}
				}
			} else {
				await appendBlockInPage(config, journalPage, noteContent);
			}
			break;
		}
		case 'prepend-specific': {
			if (blocks.length > 0) {
				// Prepend in reverse order so final order is correct
				for (let i = blocks.length - 1; i >= 0; i--) {
					const blk = await prependBlockInPage(config, noteName, blocks[i].content);
					if (blocks[i].children && blocks[i].children.length > 0) {
						await insertBatchBlock(config, blk.uuid, blocks[i].children);
					}
				}
			} else {
				await prependBlockInPage(config, noteName, noteContent);
			}
			break;
		}
		case 'prepend-daily': {
			const journalPage = getTodayJournalPageName();
			if (blocks.length > 0) {
				for (let i = blocks.length - 1; i >= 0; i--) {
					const blk = await prependBlockInPage(config, journalPage, blocks[i].content);
					if (blocks[i].children && blocks[i].children.length > 0) {
						await insertBatchBlock(config, blk.uuid, blocks[i].children);
					}
				}
			} else {
				await prependBlockInPage(config, journalPage, noteContent);
			}
			break;
		}
	}

	await appendToClipLog(noteName, sourceUrl, contentHash);
}

export async function updateExistingClip(
	pageTitle: string,
	noteContent: string,
	properties: Property[],
	sourceUrl: string,
): Promise<void> {
	const config = getApiConfig();

	const tree = await getPageBlocksTree(config, pageTitle);

	// Remove all existing content blocks (skip the first/properties block)
	for (let i = 1; i < tree.length; i++) {
		await removeBlock(config, tree[i].uuid);
	}

	const blocks = markdownToBlocks(noteContent);
	if (tree.length > 0 && blocks.length > 0) {
		await insertBatchBlock(config, tree[0].uuid, blocks);
	}

	const contentHash = await computeContentHash(noteContent);
	await appendToClipLog(pageTitle, sourceUrl, contentHash, pageTitle);
}

export async function syncSettings(direction: 'read' | 'write'): Promise<void> {
	const config = getApiConfig();
	const logPage = generalSettings.logseqLogPage || 'Web Clips Log';

	if (direction === 'write') {
		const settingsJson = JSON.stringify(generalSettings, null, 2);
		const content = `## Settings\n\`\`\`json\n${settingsJson}\n\`\`\``;
		await appendBlockInPage(config, logPage, content);
	} else {
		const tree = await getPageBlocksTree(config, logPage);
		for (const block of tree) {
			if (block.content?.includes('## Settings')) {
				const jsonMatch = block.content.match(/```json\n([\s\S]*?)\n```/);
				if (jsonMatch) {
					const parsed = JSON.parse(jsonMatch[1]);
					Object.assign(generalSettings, parsed);
				}
				break;
			}
			// Check children too
			if (block.children) {
				for (const child of block.children) {
					if (child.content?.includes('## Settings')) {
						const jsonMatch = child.content.match(/```json\n([\s\S]*?)\n```/);
						if (jsonMatch) {
							const parsed = JSON.parse(jsonMatch[1]);
							Object.assign(generalSettings, parsed);
						}
						break;
					}
				}
			}
		}
	}
}

// --- Internal functions ---

function getTodayJournalPageName(): string {
	const now = new Date();
	const yyyy = now.getFullYear();
	const mm = String(now.getMonth() + 1).padStart(2, '0');
	const dd = String(now.getDate()).padStart(2, '0');
	return `${yyyy}_${mm}_${dd}`;
}

async function appendToClipLog(
	title: string,
	url: string,
	contentHash: string,
	replaces?: string,
): Promise<void> {
	const config = getApiConfig();
	const logPage = generalSettings.logseqLogPage || 'Web Clips Log';

	const logBlockProps: Record<string, string> = {
		source: url,
		'clipped-at': new Date().toISOString(),
		'content-hash': contentHash,
	};
	if (replaces) {
		logBlockProps['replaces'] = replaces;
	}

	const logBlock: IBatchBlock = {
		content: `[[${title}]]`,
		properties: logBlockProps,
	};

	const anchor = await appendBlockInPage(config, logPage, logBlock.content);
	if (logBlock.properties) {
		// Properties are set by inserting a child block with property syntax
		// or by using the block's properties directly via insertBatchBlock
		const propChildren: IBatchBlock[] = Object.entries(logBlock.properties).map(
			([key, value]) => ({ content: `${key}:: ${value}` })
		);
		if (propChildren.length > 0) {
			await insertBatchBlock(config, anchor.uuid, propChildren);
		}
	}
}

export async function computeContentHash(content: string): Promise<string> {
	const encoder = new TextEncoder();
	const data = encoder.encode(content);
	const hashBuffer = await crypto.subtle.digest('SHA-256', data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}
