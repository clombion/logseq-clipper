import {
	type LogseqApiConfig,
	type IBatchBlock,
	type LogseqBlock,
	createPage,
	getPage,
	appendBlockInPage,
	prependBlockInPage,
	insertBatchBlock,
	getPageBlocksTree,
	queryByProperty,
	removeBlock,
	upsertBlockProperty,
	getTodayJournalPageName as fetchTodayJournalPage,
} from './logseq-api';
import { markdownToBlocks } from './markdown-to-blocks';
import { generalSettings } from './storage-utils';
import { debugLog } from './debug';
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
	destinationPage?: string;
	clippedAt?: string;
}> {
	try {
		const config = getApiConfig();
		const results = await queryByProperty(config, 'source', url);

		if (results && results.length > 0) {
			// Find the log entry that has source matching this URL
			const logEntry = results.find(
				(r) => r.properties?.source === url || r.properties?.['source'] === url,
			);
			if (!logEntry) {
				return { exists: false };
			}

			const pageTitle = logEntry.content?.match(/\[\[(.+?)\]\]/)?.[1];
			const destinationPage =
				logEntry.properties?.['destination-page'] ??
				logEntry.properties?.destinationPage ??
				pageTitle;
			const clippedAt =
				logEntry.properties?.['clipped-at'] ?? logEntry.properties?.clippedAt;

			if (!pageTitle && !destinationPage) {
				return { exists: false };
			}

			// Verify the clip still exists on the destination page
			if (destinationPage) {
				const page = await getPage(config, destinationPage);
				if (!page) {
					debugLog('Dedup', `Log entry found for ${url} but destination page '${destinationPage}' no longer exists`);
					return { exists: false };
				}
			}

			return {
				exists: true,
				pageTitle: pageTitle || destinationPage,
				destinationPage,
				clippedAt,
			};
		}

		return { exists: false };
	} catch (error) {
		console.warn('Dedup check failed, proceeding without dedup:', error);
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
	const clipId = Date.now().toString(36);

	// Only include properties from the template — no injected keys.
	// source and clipped-at go in the clip log, not the metadata block.
	const propsObj: Record<string, string> = {};
	for (const prop of properties) {
		propsObj[prop.name] = String(prop.value);
	}

	const blocks = markdownToBlocks(noteContent);
	const contentHash = await computeContentHash(noteContent);

	// Build metadata block content: properties as key:: value lines
	const metadataContent = Object.entries(propsObj)
		.filter(([, value]) => value.trim() !== '')
		.map(([key, value]) => `${key}:: ${value}`)
		.join('\n');

	debugLog('Save', `[${clipId}] behavior=${behavior} page='${noteName}' blocks=${blocks.length} props=${Object.keys(propsObj).length}`);

	// Helper: insert content blocks as children of a parent block
	const insertContentAsChildren = async (parentUuid: string) => {
		if (blocks.length > 0) {
			await insertBatchBlock(config, parentUuid, blocks, { sibling: false });
			debugLog('Save', `[${clipId}] inserted ${blocks.length} content blocks as children of ${parentUuid}`);
		}
	};

	// Track the actual destination page for the clip log
	let destinationPage = noteName;

	switch (behavior) {
		case 'create': {
			debugLog('Save', `[${clipId}] creating page '${noteName}'`);
			const page = await createPage(config, noteName, { redirect: false });
			if (!page?.uuid) {
				throw new Error(`Failed to create page '${noteName}'`);
			}

			// Apply properties via upsertBlockProperty on the page entity
			debugLog('Save', `[${clipId}] setting ${Object.keys(propsObj).length} properties on page`);
			for (const [key, value] of Object.entries(propsObj)) {
				await upsertBlockProperty(config, page.uuid, key, value);
			}

			// Insert content blocks directly on the page
			if (blocks.length > 0) {
				const anchor = await appendBlockInPage(config, noteName, blocks[0].content);
				if (!anchor?.uuid) {
					throw new Error(`Failed to create block on page '${noteName}'`);
				}
				debugLog('Save', `[${clipId}] anchor block ${anchor.uuid}`);
				const children = blocks[0].children ?? [];
				if (children.length > 0) {
					await insertBatchBlock(config, anchor.uuid, children);
				}
				const remaining = blocks.slice(1);
				if (remaining.length > 0) {
					await insertBatchBlock(config, anchor.uuid, remaining, { sibling: true });
				}
			}
			destinationPage = noteName;
			break;
		}
		case 'append-specific': {
			await appendBlockInPage(config, noteName, ''); // visual separator
			const anchor = await appendBlockInPage(config, noteName, metadataContent);
			if (!anchor?.uuid) {
				throw new Error(`Failed to append block to page '${noteName}'`);
			}
			debugLog('Save', `[${clipId}] metadata block ${anchor.uuid} on '${noteName}'`);
			await insertContentAsChildren(anchor.uuid);
			destinationPage = noteName;
			break;
		}
		case 'append-daily': {
			const journalPage = await fetchTodayJournalPage(config);
			await appendBlockInPage(config, journalPage, ''); // visual separator
			const anchor = await appendBlockInPage(config, journalPage, metadataContent);
			if (!anchor?.uuid) {
				throw new Error(`Failed to append block to daily journal page`);
			}
			debugLog('Save', `[${clipId}] metadata block ${anchor.uuid} on journal '${journalPage}'`);
			await insertContentAsChildren(anchor.uuid);
			destinationPage = journalPage;
			break;
		}
		case 'prepend-specific': {
			const anchor = await prependBlockInPage(config, noteName, metadataContent);
			if (!anchor?.uuid) {
				throw new Error(`Failed to prepend block to page '${noteName}'`);
			}
			debugLog('Save', `[${clipId}] metadata block ${anchor.uuid} on '${noteName}'`);
			await insertContentAsChildren(anchor.uuid);
			destinationPage = noteName;
			break;
		}
		case 'prepend-daily': {
			const journalPage = await fetchTodayJournalPage(config);
			const anchor = await prependBlockInPage(config, journalPage, metadataContent);
			if (!anchor?.uuid) {
				throw new Error(`Failed to prepend block to daily journal page`);
			}
			debugLog('Save', `[${clipId}] metadata block ${anchor.uuid} on journal '${journalPage}'`);
			await insertContentAsChildren(anchor.uuid);
			destinationPage = journalPage;
			break;
		}
	}

	try {
		await appendToClipLog(noteName, sourceUrl, contentHash, destinationPage);
	} catch (logError) {
		debugLog('Save', `[${clipId}] clip log failed (save succeeded):`, logError);
	}
}

export async function updateExistingClip(
	pageTitle: string,
	noteContent: string,
	properties: Property[],
	sourceUrl: string,
): Promise<void> {
	const config = getApiConfig();
	const clipId = Date.now().toString(36);

	debugLog('Save', `[${clipId}] updating existing clip '${pageTitle}'`);

	const page = await getPage(config, pageTitle);
	if (!page?.uuid) {
		throw new Error(`Page '${pageTitle}' not found`);
	}

	// Update properties from template only
	const propsObj: Record<string, string> = {};
	for (const prop of properties) {
		propsObj[prop.name] = String(prop.value);
	}
	debugLog('Save', `[${clipId}] updating ${Object.keys(propsObj).length} properties`);
	for (const [key, value] of Object.entries(propsObj)) {
		await upsertBlockProperty(config, page.uuid, key, value);
	}

	// Snapshot old content blocks BEFORE inserting new ones
	const oldBlocks = await getPageBlocksTree(config, pageTitle) ?? [];
	debugLog('Save', `[${clipId}] old blocks: ${oldBlocks.length}, inserting new content`);

	// Insert new content
	const blocks = markdownToBlocks(noteContent);
	if (blocks.length > 0) {
		const anchor = await appendBlockInPage(config, pageTitle, blocks[0].content);
		if (!anchor?.uuid) {
			throw new Error(`Failed to insert new content on page '${pageTitle}'`);
		}
		const children = blocks[0].children ?? [];
		if (children.length > 0) {
			await insertBatchBlock(config, anchor.uuid, children);
		}
		const remaining = blocks.slice(1);
		if (remaining.length > 0) {
			await insertBatchBlock(config, anchor.uuid, remaining, { sibling: true });
		}
	}

	// Delete ALL old blocks (properties are on page entity via upsertBlockProperty)
	debugLog('Save', `[${clipId}] deleting ${oldBlocks.length} old blocks`);
	for (const block of oldBlocks) {
		await removeBlock(config, block.uuid);
	}

	const contentHash = await computeContentHash(noteContent);
	try {
		await appendToClipLog(pageTitle, sourceUrl, contentHash, pageTitle, pageTitle);
	} catch (logError) {
		debugLog('Save', `[${clipId}] clip log failed (save succeeded):`, logError);
	}
}

// TODO: Not yet called from production code. Intended to be invoked on popup
// startup (read) and settings change (write) to sync config across browsers
// via the [[Web Clips Log]] page. See design decision #6 in the plan.
export async function syncSettings(direction: 'read' | 'write'): Promise<void> {
	const config = getApiConfig();
	const logPage = generalSettings.logseqLogPage || 'Web Clips Log';

	if (direction === 'write') {
		const settingsJson = JSON.stringify(generalSettings, null, 2);
		const content = `## Settings\n\`\`\`json\n${settingsJson}\n\`\`\``;
		const result = await appendBlockInPage(config, logPage, content);
		if (!result) {
			debugLog('Settings', 'Failed to write settings to Logseq');
			return;
		}
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


async function appendToClipLog(
	title: string,
	url: string,
	contentHash: string,
	destinationPage: string,
	replaces?: string,
): Promise<void> {
	const config = getApiConfig();
	const logPage = generalSettings.logseqLogPage || 'Web Clips Log';

	const logBlockProps: Record<string, string> = {
		source: url,
		'clipped-at': new Date().toISOString(),
		'content-hash': contentHash,
		'destination-page': destinationPage,
	};
	if (replaces) {
		logBlockProps['replaces'] = replaces;
	}

	const displayTitle = title || destinationPage;
	const logBlock: IBatchBlock = {
		content: `[[${displayTitle}]]`,
		properties: logBlockProps,
	};

	const anchor = await appendBlockInPage(config, logPage, logBlock.content);
	if (!anchor?.uuid) {
		debugLog('Save', 'Failed to create clip log entry — appendBlockInPage returned null');
		return; // Don't crash the save flow for a log failure
	}
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
