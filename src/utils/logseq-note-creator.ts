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
	try {
		const config = getApiConfig();
		const results = await queryByProperty(config, 'source', url);

		if (results && results.length > 0) {
			const first = results[0];
			const pageTitle = first.name ?? first['original-name'] ?? first.originalName;
			if (!pageTitle) {
				return { exists: false };
			}
			return {
				exists: true,
				pageTitle,
				clippedAt: first.properties?.['clipped-at'] ?? first.properties?.clippedAt,
			};
		}

		return { exists: false };
	} catch {
		return { exists: false };
	}
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
			await createPage(config, noteName, propsObj, {
				createFirstBlock: true,
				redirect: false,
			});
			const tree = await getPageBlocksTree(config, noteName);
			if (tree.length > 0 && blocks.length > 0) {
				try {
					await insertBatchBlock(config, tree[0].uuid, blocks);
				} catch (error) {
					// Rollback: try to delete the page we just created
					try {
						for (const block of tree) {
							await removeBlock(config, block.uuid);
						}
					} catch { /* best effort cleanup */ }
					throw error;
				}
			}
			break;
		}
		case 'append-specific': {
			if (blocks.length > 0) {
				const anchor = await appendBlockInPage(config, noteName, blocks[0].content);
				const remaining = blocks.slice(1);
				const children = blocks[0].children ?? [];
				if (remaining.length > 0) {
					await insertBatchBlock(config, anchor.uuid, remaining, { sibling: true });
				}
				if (children.length > 0) {
					await insertBatchBlock(config, anchor.uuid, children);
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
				const remaining = blocks.slice(1);
				const children = blocks[0].children ?? [];
				if (remaining.length > 0) {
					await insertBatchBlock(config, anchor.uuid, remaining, { sibling: true });
				}
				if (children.length > 0) {
					await insertBatchBlock(config, anchor.uuid, children);
				}
			} else {
				await appendBlockInPage(config, journalPage, noteContent);
			}
			break;
		}
		case 'prepend-specific': {
			if (blocks.length > 0) {
				const anchor = await prependBlockInPage(config, noteName, blocks[0].content);
				const remaining = blocks.slice(1);
				const children = blocks[0].children ?? [];
				if (remaining.length > 0) {
					await insertBatchBlock(config, anchor.uuid, remaining, { sibling: true });
				}
				if (children.length > 0) {
					await insertBatchBlock(config, anchor.uuid, children);
				}
			} else {
				await prependBlockInPage(config, noteName, noteContent);
			}
			break;
		}
		case 'prepend-daily': {
			const journalPage = getTodayJournalPageName();
			if (blocks.length > 0) {
				const anchor = await prependBlockInPage(config, journalPage, blocks[0].content);
				const remaining = blocks.slice(1);
				const children = blocks[0].children ?? [];
				if (remaining.length > 0) {
					await insertBatchBlock(config, anchor.uuid, remaining, { sibling: true });
				}
				if (children.length > 0) {
					await insertBatchBlock(config, anchor.uuid, children);
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
	const blocks = markdownToBlocks(noteContent);

	// Insert new content first, then delete old blocks (insert-before-delete)
	if (tree.length > 0 && blocks.length > 0) {
		await insertBatchBlock(config, tree[0].uuid, blocks);
	}

	// Only after successful insert, remove old content blocks (skip the first/properties block)
	for (let i = 1; i < tree.length; i++) {
		await removeBlock(config, tree[i].uuid);
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
					mergeValidatedSettings(jsonMatch[1]);
				}
				break;
			}
			// Check children too
			if (block.children) {
				for (const child of block.children) {
					if (child.content?.includes('## Settings')) {
						const jsonMatch = child.content.match(/```json\n([\s\S]*?)\n```/);
						if (jsonMatch) {
							mergeValidatedSettings(jsonMatch[1]);
						}
						break;
					}
				}
			}
		}
	}
}

// --- Internal functions ---

function mergeValidatedSettings(jsonString: string): void {
	try {
		const parsed = JSON.parse(jsonString);
		if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
			const allowedKeys = Object.keys(generalSettings);
			const validated: Record<string, any> = {};
			for (const key of allowedKeys) {
				if (key in parsed) {
					validated[key] = parsed[key];
				}
			}
			Object.assign(generalSettings, validated);
		}
	} catch {
		console.error('Failed to parse settings from Logseq page');
	}
}

export function getTodayJournalPageName(): string {
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
