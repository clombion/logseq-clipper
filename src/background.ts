import browser from 'webextension-polyfill';
import type { Template } from './types/types';
import { isBlankPage, isValidUrl, updateCurrentActiveTab } from './utils/active-tab-manager';
import { detectBrowser } from './utils/browser-detection';
import { debounce } from './utils/debounce';
import { debugLog } from './utils/debug';
import type { TextHighlightData } from './utils/highlighter';
import { collectPromptVariables, replacePromptVariablesInText, sendToLLM } from './utils/interpreter';
import { checkDuplicate, saveToLogseq } from './utils/logseq-note-creator';
import { buildVariables } from './utils/shared';
import { generalSettings, loadSettings } from './utils/storage-utils';
import { compileTemplate } from './utils/template-compiler';
import { findMatchingTemplate } from './utils/triggers';

const YOUTUBE_EMBED_RULE_ID = 9001;

// Firefox: always-active webRequest listener to rewrite Referer on YouTube embeds.
// Chrome MV3 doesn't support blocking webRequest, so this is a no-op there.
// Safari can't modify headers at all; reader.ts shows a thumbnail fallback instead.
if (browser.webRequest?.onBeforeSendHeaders) {
	browser.webRequest.onBeforeSendHeaders.addListener(
		(details) => {
			const headers = (details.requestHeaders || []).filter((h) => h.name.toLowerCase() !== 'referer');
			headers.push({ name: 'Referer', value: 'https://logseq.com/' });
			return { requestHeaders: headers };
		},
		{
			urls: ['*://*.youtube.com/embed/*'],
			types: ['sub_frame' as browser.WebRequest.ResourceType],
		},
		['blocking', 'requestHeaders'],
	);
}

// Chrome: declarativeNetRequest to rewrite Referer on YouTube embeds.
async function enableYouTubeEmbedRule(tabId: number): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID],
		addRules: [
			{
				id: YOUTUBE_EMBED_RULE_ID,
				priority: 1,
				action: {
					// @ts-expect-error Chrome declarativeNetRequest type incomplete
					type: 'modifyHeaders',
					requestHeaders: [
						{
							header: 'Referer',
							// @ts-expect-error Chrome declarativeNetRequest type incomplete
							operation: 'set',
							value: 'https://logseq.com/',
						},
					],
				},
				condition: {
					urlFilter: '||youtube.com/embed/',
					// @ts-expect-error Chrome declarativeNetRequest type incomplete
					resourceTypes: ['sub_frame'],
					tabIds: [tabId],
				},
			},
		],
	});
}

async function disableYouTubeEmbedRule(): Promise<void> {
	await chrome.declarativeNetRequest.updateSessionRules({
		removeRuleIds: [YOUTUBE_EMBED_RULE_ID],
	});
}

const sidePanelOpenWindows: Set<number> = new Set();
const highlighterModeState: { [tabId: number]: boolean } = {};
let _hasHighlights = false;
let isContextMenuCreating = false;
const popupPorts: { [tabId: number]: browser.Runtime.Port } = {};

async function ensureContentScriptLoadedInBackground(tabId: number): Promise<void> {
	try {
		// First, get the tab information
		const tab = await browser.tabs.get(tabId);

		// Check if the URL is valid before proceeding
		if (!tab.url || !isValidUrl(tab.url)) {
			debugLog('Background', `Skipping content script injection for invalid URL: ${tab.url}`);
			throw new Error(`Cannot inject content script into invalid URL: ${tab.url}`);
		}

		// Attempt to send a message to the content script
		await browser.tabs.sendMessage(tabId, { action: 'ping' });
		debugLog('Background', 'Content script ping succeeded');
	} catch (error) {
		// If the error is about invalid URL, re-throw it
		if (error instanceof Error && error.message.includes('invalid URL')) {
			throw error;
		}

		// If the message fails, the content script is not loaded, so inject it
		debugLog('Background', 'Ping failed, injecting content script...', error);
		try {
			// Try using the scripting API (Chrome)
			if (browser.scripting) {
				debugLog('Background', 'Using scripting API');
				await browser.scripting.executeScript({
					target: { tabId: tabId },
					files: ['content.js'],
				});
			} else {
				debugLog('Background', 'Using tabs.executeScript fallback');
				// Fallback to tabs.executeScript (Firefox)
				await browser.tabs.executeScript(tabId, {
					file: 'content.js',
				});
			}
			debugLog('Background', 'Injection completed, waiting for init...');

			// Poll until the content script responds, rather than a fixed delay
			let ready = false;
			for (let i = 0; i < 8; i++) {
				await new Promise((resolve) => setTimeout(resolve, 50));
				try {
					await browser.tabs.sendMessage(tabId, { action: 'ping' });
					ready = true;
					break;
				} catch {
					// Not ready yet
				}
			}
			if (!ready) {
				throw new Error('Content script did not respond after injection');
			}
			debugLog('Background', 'Post-injection ping succeeded');
		} catch (injectError) {
			console.error('[Logseq Clipper] Injection or post-injection ping failed:', injectError);
			throw injectError;
		}
	}
}

function getHighlighterModeForTab(tabId: number): boolean {
	return highlighterModeState[tabId] ?? false;
}

async function initialize() {
	try {
		// Set up tab listeners
		await setupTabListeners();

		browser.tabs.onRemoved.addListener((tabId) => {
			delete highlighterModeState[tabId];
		});

		// Initialize context menu
		await debouncedUpdateContextMenu(-1);

		debugLog('Background', 'Background script initialized successfully');
	} catch (error) {
		console.error('Error initializing background script:', error);
	}
}

// Check if a popup is open for a given tab
function isPopupOpen(tabId: number): boolean {
	return Object.hasOwn(popupPorts, tabId);
}

browser.runtime.onConnect.addListener((port) => {
	if (port.name === 'popup') {
		const tabId = port.sender?.tab?.id;
		if (tabId) {
			popupPorts[tabId] = port;
			port.onDisconnect.addListener(() => {
				delete popupPorts[tabId];
			});
		}
	}
});

// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
async function sendMessageToPopup(tabId: number, message: any): Promise<void> {
	if (isPopupOpen(tabId)) {
		try {
			await popupPorts[tabId]?.postMessage(message);
		} catch (error) {
			console.warn(`Error sending message to popup for tab ${tabId}:`, error);
		}
	}
}

browser.runtime.onMessage.addListener(
	(
		request: unknown,
		sender: browser.Runtime.MessageSender,
		// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
		sendResponse: (response?: any) => void,
	): true | undefined => {
		if (typeof request === 'object' && request !== null) {
			const typedRequest = request as {
				action: string;
				isActive?: boolean;
				hasHighlights?: boolean;
				tabId?: number;
				text?: string;
				message?: { action: string; [key: string]: unknown };
				// Batch clip fields
				clips?: Array<{ tabId: number; templateId: string }>;
				templates?: Template[];
			};

			if (typedRequest.action === 'copy-to-clipboard' && typedRequest.text) {
				// Use content script to copy to clipboard
				browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
					const currentTab = tabs[0];
					if (currentTab?.id) {
						try {
							const response = await browser.tabs.sendMessage(currentTab.id, {
								action: 'copy-text-to-clipboard',
								text: typedRequest.text,
							});
							const result = response as { success?: boolean } | undefined;
							if (result?.success) {
								sendResponse({ success: true });
							} else {
								sendResponse({ success: false, error: 'Failed to copy from content script' });
							}
						} catch (err) {
							sendResponse({ success: false, error: (err as Error).message });
						}
					} else {
						sendResponse({ success: false, error: 'No active tab found' });
					}
				});
				return true;
			}

			if (typedRequest.action === 'extractContent' && sender.tab && sender.tab.id) {
				browser.tabs.sendMessage(sender.tab.id, request).then(sendResponse);
				return true;
			}

			if (typedRequest.action === 'ensureContentScriptLoaded') {
				const tabId = typedRequest.tabId || sender.tab?.id;
				if (tabId) {
					ensureContentScriptLoadedInBackground(tabId)
						.then(() => sendResponse({ success: true }))
						.catch((error) =>
							sendResponse({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							}),
						);
					return true;
				} else {
					sendResponse({ success: false, error: 'No tab ID provided' });
					return true;
				}
			}

			if (typedRequest.action === 'enableYouTubeEmbedRule') {
				const tabId = sender.tab?.id;
				if (tabId) {
					enableYouTubeEmbedRule(tabId)
						.then(() => {
							sendResponse({ success: true });
						})
						.catch(() => {
							sendResponse({ success: true });
						});
				} else {
					sendResponse({ success: true });
				}
				return true;
			}

			if (typedRequest.action === 'disableYouTubeEmbedRule') {
				disableYouTubeEmbedRule()
					.then(() => {
						sendResponse({ success: true });
					})
					.catch(() => {
						sendResponse({ success: true });
					});
				return true;
			}

			if (typedRequest.action === 'sidePanelOpened') {
				if (sender.tab?.windowId) {
					sidePanelOpenWindows.add(sender.tab.windowId);
					updateCurrentActiveTab(sender.tab.windowId);
				}
			}

			if (typedRequest.action === 'sidePanelClosed') {
				if (sender.tab?.windowId) {
					sidePanelOpenWindows.delete(sender.tab.windowId);
				}
			}

			if (typedRequest.action === 'highlighterModeChanged' && sender.tab && typedRequest.isActive !== undefined) {
				const tabId = sender.tab.id;
				if (tabId) {
					highlighterModeState[tabId] = typedRequest.isActive;
					sendMessageToPopup(tabId, { action: 'updatePopupHighlighterUI', isActive: typedRequest.isActive });
					debouncedUpdateContextMenu(tabId);
				}
			}

			if (typedRequest.action === 'highlightsCleared' && sender.tab?.id != null) {
				_hasHighlights = false;
				debouncedUpdateContextMenu(sender.tab.id);
			}

			if (
				typedRequest.action === 'updateHasHighlights' &&
				sender.tab?.id != null &&
				typedRequest.hasHighlights !== undefined
			) {
				_hasHighlights = typedRequest.hasHighlights;
				debouncedUpdateContextMenu(sender.tab.id);
			}

			if (typedRequest.action === 'getHighlighterMode') {
				const tabId = typedRequest.tabId || sender.tab?.id;
				if (tabId) {
					sendResponse({ isActive: getHighlighterModeForTab(tabId) });
				} else {
					sendResponse({ isActive: false });
				}
				return true;
			}

			if (typedRequest.action === 'toggleHighlighterMode' && typedRequest.tabId) {
				toggleHighlighterMode(typedRequest.tabId)
					.then((newMode) => sendResponse({ success: true, isActive: newMode }))
					.catch((error) => sendResponse({ success: false, error: error.message }));
				return true;
			}

			if (typedRequest.action === 'openPopup') {
				browser.action
					.openPopup()
					.then(() => {
						sendResponse({ success: true });
					})
					.catch((error: unknown) => {
						console.error('Error opening popup in background script:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
				return true;
			}

			if (typedRequest.action === 'toggleReaderMode' && typedRequest.tabId) {
				const readerTabId = typedRequest.tabId;
				injectReaderScript(readerTabId).then(() => {
					browser.tabs.sendMessage(readerTabId, { action: 'toggleReaderMode' }).then(sendResponse);
				});
				return true;
			}

			if (typedRequest.action === 'getActiveTabAndToggleIframe') {
				browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
					const currentTab = tabs[0];
					if (currentTab?.id) {
						try {
							// Check if the URL is valid before trying to inject content script
							if (!currentTab.url || !isValidUrl(currentTab.url) || isBlankPage(currentTab.url)) {
								sendResponse({ success: false, error: 'Cannot open iframe on this page' });
								return;
							}

							// Ensure content script is loaded first
							await ensureContentScriptLoadedInBackground(currentTab.id);
							await browser.tabs.sendMessage(currentTab.id, { action: 'toggle-iframe' });
							sendResponse({ success: true });
						} catch (error) {
							console.error('Error sending toggle-iframe message:', error);
							sendResponse({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							});
						}
					} else {
						sendResponse({ success: false, error: 'No active tab found' });
					}
				});
				return true;
			}

			if (typedRequest.action === 'getActiveTab') {
				browser.tabs.query({ active: true, currentWindow: true }).then(async (tabs) => {
					let currentTab = tabs[0];
					// Fallback for when currentWindow has no tabs (e.g., debugging popup in DevTools)
					if (!currentTab || !currentTab.id) {
						const allActiveTabs = await browser.tabs.query({ active: true });
						currentTab =
							allActiveTabs.find(
								(tab) =>
									tab.id &&
									tab.url &&
									!tab.url.startsWith('chrome-extension://') &&
									!tab.url.startsWith('moz-extension://'),
							) || allActiveTabs[0];
					}
					if (currentTab?.id) {
						sendResponse({ tabId: currentTab.id });
					} else {
						sendResponse({ error: 'No active tab found' });
					}
				});
				return true;
			}

			if (typedRequest.action === 'openOptionsPage') {
				try {
					if (typeof browser.runtime.openOptionsPage === 'function') {
						// Chrome way
						browser.runtime.openOptionsPage();
					} else {
						// Firefox way
						browser.tabs.create({
							url: browser.runtime.getURL('settings.html'),
						});
					}
					sendResponse({ success: true });
				} catch (error) {
					console.error('Error opening options page:', error);
					sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
				}
				return true;
			}

			if (typedRequest.action === 'getTabInfo') {
				browser.tabs
					.get(typedRequest.tabId as number)
					.then((tab) => {
						sendResponse({
							success: true,
							tab: {
								id: tab.id,
								url: tab.url,
							},
						});
					})
					.catch((error) => {
						console.error('Error getting tab info:', error);
						sendResponse({
							success: false,
							error: error instanceof Error ? error.message : String(error),
						});
					});
				return true;
			}

			if (typedRequest.action === 'sendMessageToTab') {
				const { tabId, message } = typedRequest;
				if (tabId && message) {
					// Ensure content script is loaded before sending message.
					// Use a timeout to prevent the service worker from lingering
					// if the content script never responds (avoids Zen/Firefox crash
					// during service worker idle termination with dangling references).
					const timeoutPromise = new Promise<never>((_, reject) =>
						setTimeout(() => reject(new Error('Tab message timed out after 30s')), 30_000),
					);
					Promise.race([
						ensureContentScriptLoadedInBackground(tabId).then(() => {
							debugLog('Background', 'Sending message to tab:', message.action);
							return browser.tabs.sendMessage(tabId, message);
						}),
						timeoutPromise,
					])
						.then((response) => {
							const resp = response as { content?: unknown } | undefined;
							debugLog('Background', 'Tab response:', resp ? `has content=${!!resp.content}` : response);
							sendResponse(response);
						})
						.catch((error) => {
							console.error('[Logseq Clipper] Error sending message to tab:', error);
							sendResponse({
								success: false,
								error: error instanceof Error ? error.message : String(error),
							});
						});
					return true;
				} else {
					sendResponse({
						success: false,
						error: 'Missing tabId or message',
					});
					return true;
				}
			}

			// --- Batch Tab Clip handlers ---

			if (typedRequest.action === 'getClippableTabs') {
				getClippableTabs()
					.then(({ tabs, groupName }) => sendResponse({ success: true, tabs, groupName }))
					.catch((error) =>
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) }),
					);
				return true;
			}

			if (typedRequest.action === 'executeBatchClip') {
				const clips = typedRequest.clips ?? [];
				const templates = typedRequest.templates ?? [];
				executeBatchClip(clips, templates).catch((error) => {
					debugLog('BatchClip', 'Batch clip failed:', error);
				});
				sendResponse({ success: true });
				return true;
			}

			if (typedRequest.action === 'getBatchClipStatus') {
				sendResponse({ success: true, state: batchState });
				return true;
			}

			if (typedRequest.action === 'cancelBatchClip') {
				batchState.status = 'cancelled';
				sendResponse({ success: true });
				return true;
			}

			if (typedRequest.action === 'closeClippedTabs') {
				const tabIds = batchState.results
					.filter((r) => r.status === 'done' || r.status === 'duplicate')
					.map((r) => r.tabId);
				if (tabIds.length > 0) {
					browser.tabs.remove(tabIds).catch((error) => {
						debugLog('BatchClip', 'Failed to close tabs:', error);
					});
				}
				batchState = { status: 'idle', results: [], current: 0, total: 0 };
				sendResponse({ success: true });
				return true;
			}

			if (typedRequest.action === 'dismissBatchClip') {
				batchState = { status: 'idle', results: [], current: 0, total: 0 };
				sendResponse({ success: true });
				return true;
			}

			// For other actions that use sendResponse
			if (
				typedRequest.action === 'extractContent' ||
				typedRequest.action === 'ensureContentScriptLoaded' ||
				typedRequest.action === 'getHighlighterMode' ||
				typedRequest.action === 'toggleHighlighterMode'
			) {
				return true;
			}
		}
		return undefined;
	},
);

// --- Batch Tab Clip Engine ---

interface BatchClipResult {
	tabId: number;
	title: string;
	status: 'pending' | 'clipping' | 'done' | 'failed' | 'duplicate';
	error?: string;
}

interface BatchClipState {
	status: 'idle' | 'clipping' | 'complete' | 'cancelled';
	results: BatchClipResult[];
	current: number;
	total: number;
}

let batchState: BatchClipState = { status: 'idle', results: [], current: 0, total: 0 };

const INTERNAL_URL_PREFIXES = ['chrome://', 'about:', 'moz-extension://', 'chrome-extension://', 'edge://'];

function isClippableTab(tab: browser.Tabs.Tab): boolean {
	if (tab.pinned) return false;
	if (!tab.url) return false;
	if (isBlankPage(tab.url)) return false;
	return !INTERNAL_URL_PREFIXES.some((prefix) => tab.url?.startsWith(prefix));
}

async function getClippableTabs(): Promise<{
	tabs: Array<{ id: number; title: string; url: string; favIconUrl: string; matchedTemplateId: string }>;
	groupName: string | null;
}> {
	await loadSettings();
	const allTabs = await browser.tabs.query({ currentWindow: true });

	// If the active tab is in a tab group, only show that group's tabs.
	// Chrome: groupId is a number (-1 = ungrouped). Firefox: groupId is undefined.
	const activeTab = allTabs.find((t) => t.active);
	// biome-ignore lint/suspicious/noExplicitAny: Chrome-only groupId not in webextension-polyfill types
	const activeGroupId = (activeTab as any)?.groupId;
	const hasGroup = typeof activeGroupId === 'number' && activeGroupId !== -1;

	let filteredTabs = allTabs;
	let groupName: string | null = null;

	if (hasGroup) {
		// biome-ignore lint/suspicious/noExplicitAny: Chrome-only groupId not in webextension-polyfill types
		filteredTabs = allTabs.filter((t) => (t as any).groupId === activeGroupId);
		// Try to get the group name (Chrome-only API)
		try {
			// biome-ignore lint/suspicious/noExplicitAny: Chrome-only tabGroups API
			const group = await (chrome as any).tabGroups?.get(activeGroupId);
			groupName = group?.title || null;
		} catch {
			// Firefox or API unavailable — no group name
		}
	}

	const clippable = filteredTabs.filter(isClippableTab);

	const result = [];
	for (const tab of clippable) {
		if (!tab.id || !tab.url) continue;
		const matched = await findMatchingTemplate(tab.url, () => Promise.resolve(null));
		result.push({
			id: tab.id,
			title: tab.title ?? 'Untitled',
			url: tab.url,
			favIconUrl: tab.favIconUrl ?? '',
			matchedTemplateId: matched?.id ?? '',
		});
	}
	return { tabs: result, groupName };
}

async function executeBatchClip(
	clips: Array<{ tabId: number; templateId: string }>,
	templates: Template[],
): Promise<void> {
	batchState = {
		status: 'clipping',
		results: clips.map((c) => ({
			tabId: c.tabId,
			title: '',
			status: 'pending' as const,
		})),
		current: 0,
		total: clips.length,
	};

	for (let i = 0; i < clips.length; i++) {
		if (batchState.status === 'cancelled') break;

		const clip = clips[i]!;
		const resultEntry = batchState.results[i]!;
		resultEntry.status = 'clipping';
		batchState.current = i + 1;

		// Broadcast progress
		broadcastBatchProgress();

		try {
			// Get tab info for title
			const tabInfo = await browser.tabs.get(clip.tabId).catch(() => null);
			if (!tabInfo) {
				resultEntry.status = 'failed';
				resultEntry.error = 'Tab closed';
				resultEntry.title = 'Unknown';
				continue;
			}
			resultEntry.title = tabInfo.title ?? 'Untitled';
			const url = tabInfo.url ?? '';

			// Find template
			const template = templates.find((t) => t.id === clip.templateId);
			if (!template) {
				resultEntry.status = 'failed';
				resultEntry.error = 'Template not found';
				continue;
			}

			// Ensure content script loaded
			await ensureContentScriptLoadedInBackground(clip.tabId);

			// Extract page content
			// biome-ignore lint/suspicious/noExplicitAny: content script returns untyped response
			const contentResponse: any = await browser.tabs.sendMessage(clip.tabId, { action: 'getPageContent' });
			if (!contentResponse) {
				resultEntry.status = 'failed';
				resultEntry.error = 'Content extraction failed';
				continue;
			}

			// Check duplicate
			const dup = await checkDuplicate(url);
			if (dup.exists) {
				resultEntry.status = 'duplicate';
				continue;
			}

			// Build variables
			const variables = buildVariables({
				title: contentResponse.title ?? tabInfo.title ?? '',
				author: contentResponse.author ?? '',
				content: contentResponse.content ?? '',
				contentHtml: contentResponse.contentHtml ?? contentResponse.content ?? '',
				url,
				fullHtml: contentResponse.fullHtml ?? '',
				description: contentResponse.description ?? '',
				favicon: contentResponse.favicon ?? tabInfo.favIconUrl ?? '',
				image: contentResponse.image ?? '',
				published: contentResponse.published ?? '',
				site: contentResponse.site ?? contentResponse.domain ?? '',
				language: contentResponse.language ?? '',
				wordCount: contentResponse.wordCount ?? 0,
				schemaOrgData: contentResponse.schemaOrgData ?? null,
				metaTags: contentResponse.metaTags ?? [],
				extractedContent: contentResponse.extractedContent ?? {},
			});

			// Compile template fields
			const [noteContent, noteName, _path] = await Promise.all([
				template.noteContentFormat
					? compileTemplate(clip.tabId, template.noteContentFormat, variables, url)
					: '',
				compileTemplate(clip.tabId, template.noteNameFormat, variables, url),
				compileTemplate(clip.tabId, template.path, variables, url),
			]);

			// Compile properties
			const compiledProperties = await Promise.all(
				template.properties.map(async (prop) => ({
					name: prop.name,
					value: await compileTemplate(clip.tabId, prop.value, variables, url),
				})),
			);

			// Handle LLM if template has prompt variables
			let finalContent = noteContent;
			let finalNoteName = noteName;
			const promptVariables = collectPromptVariables(template);
			if (promptVariables.length > 0 && generalSettings.interpreterEnabled) {
				const selectedModelId = generalSettings.interpreterModel;
				const modelConfig = generalSettings.models.find((m) => m.id === selectedModelId);
				if (modelConfig) {
					const { promptResponses } = await sendToLLM(
						template.context || generalSettings.defaultPromptContext || '',
						variables.content ?? '',
						promptVariables,
						modelConfig,
					);
					finalContent = replacePromptVariablesInText(finalContent, promptVariables, promptResponses);
					finalNoteName = replacePromptVariablesInText(finalNoteName, promptVariables, promptResponses);
				}
			}

			// Determine behavior
			const behavior = template.behavior;
			const isDailyNote = behavior === 'append-daily' || behavior === 'prepend-daily';
			const effectiveNoteName = isDailyNote ? '' : finalNoteName;

			// Save to Logseq
			await saveToLogseq(finalContent, effectiveNoteName, compiledProperties, behavior, url);

			resultEntry.status = 'done';
		} catch (error) {
			resultEntry.status = 'failed';
			resultEntry.error = error instanceof Error ? error.message : String(error);
			debugLog('BatchClip', `Tab ${clip.tabId} failed:`, error);
		}
	}

	if (batchState.status !== 'cancelled') {
		batchState.status = 'complete';
	}
	broadcastBatchProgress();
}

function broadcastBatchProgress(): void {
	browser.runtime
		.sendMessage({
			action: 'batchClipProgress',
			state: batchState,
		})
		.catch(() => {
			// Popup may be closed — that's fine
		});
}

browser.commands.onCommand.addListener(async (command, tab) => {
	if (command === 'quick_clip') {
		browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
			if (tabs[0]?.id) {
				browser.action.openPopup();
				setTimeout(() => {
					browser.runtime
						.sendMessage({ action: 'triggerQuickClip' })
						.catch((error) => console.error('Failed to send quick clip message:', error));
				}, 500);
			}
		});
	}
	if (command === 'toggle_highlighter' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		toggleHighlighterMode(tab.id);
	}
	if (command === 'copy_to_clipboard' && tab && tab.id) {
		await browser.tabs.sendMessage(tab.id, { action: 'copyToClipboard' });
	}
	if (command === 'toggle_reader' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: 'toggleReaderMode' });
	}
});

const debouncedUpdateContextMenu = debounce(async (tabId: number) => {
	if (isContextMenuCreating) {
		return;
	}
	isContextMenuCreating = true;

	try {
		await browser.contextMenus.removeAll();

		let currentTabId = tabId;
		if (currentTabId === -1) {
			const tabs = await browser.tabs.query({ active: true, currentWindow: true });
			if (tabs.length > 0) {
				currentTabId = tabs[0]?.id ?? -1;
			}
		}

		const isHighlighterMode = getHighlighterModeForTab(currentTabId);

		const menuItems: {
			id: string;
			title: string;
			contexts: browser.Menus.ContextType[];
		}[] = [
			{
				id: 'open-logseq-clipper',
				title: 'Save this page',
				contexts: ['page', 'selection', 'image', 'video', 'audio'],
			},
			{
				id: 'copy-markdown-to-clipboard',
				title: browser.i18n.getMessage('copyToClipboard'),
				contexts: ['page', 'selection'],
			},
			{
				id: 'toggle-reader',
				title: browser.i18n.getMessage('commandToggleReader'),
				contexts: ['page', 'selection'],
			},
			{
				id: isHighlighterMode ? 'exit-highlighter' : 'enter-highlighter',
				title: isHighlighterMode ? 'Exit highlighter' : 'Highlight this page',
				contexts: ['page', 'image', 'video', 'audio'],
			},
			{
				id: 'highlight-selection',
				title: 'Add to highlights',
				contexts: ['selection'],
			},
			{
				id: 'highlight-element',
				title: 'Add to highlights',
				contexts: ['image', 'video', 'audio'],
			},
			{
				id: 'open-embedded',
				title: browser.i18n.getMessage('openEmbedded'),
				contexts: ['page', 'selection'],
			},
		];

		const browserType = await detectBrowser();
		if (browserType === 'chrome') {
			menuItems.push({
				id: 'open-side-panel',
				title: browser.i18n.getMessage('openSidePanel'),
				contexts: ['page', 'selection'],
			});
		}

		for (const item of menuItems) {
			await browser.contextMenus.create(item);
		}
	} catch (error) {
		console.error('Error updating context menu:', error);
	} finally {
		isContextMenuCreating = false;
	}
}, 100); // 100ms debounce time

browser.contextMenus.onClicked.addListener(async (info, tab) => {
	if (info.menuItemId === 'open-logseq-clipper') {
		browser.action.openPopup();
	} else if (info.menuItemId === 'enter-highlighter' && tab && tab.id) {
		await setHighlighterMode(tab.id, true);
	} else if (info.menuItemId === 'exit-highlighter' && tab && tab.id) {
		await setHighlighterMode(tab.id, false);
	} else if (info.menuItemId === 'highlight-selection' && tab && tab.id) {
		await highlightSelection(tab.id, info);
	} else if (info.menuItemId === 'highlight-element' && tab && tab.id) {
		await highlightElement(tab.id, info);
	} else if (info.menuItemId === 'toggle-reader' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await injectReaderScript(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: 'toggleReaderMode' });
	} else if (info.menuItemId === 'open-embedded' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: 'toggle-iframe' });
	} else if (info.menuItemId === 'open-side-panel' && tab && tab.id && tab.windowId) {
		chrome.sidePanel.open({ tabId: tab.id });
		sidePanelOpenWindows.add(tab.windowId);
		await ensureContentScriptLoadedInBackground(tab.id);
	} else if (info.menuItemId === 'copy-markdown-to-clipboard' && tab && tab.id) {
		await ensureContentScriptLoadedInBackground(tab.id);
		await browser.tabs.sendMessage(tab.id, { action: 'copyMarkdownToClipboard' });
	}
});

browser.runtime.onInstalled.addListener(async (details) => {
	debouncedUpdateContextMenu(-1); // Use a dummy tabId for initial creation

	// On fresh install, open setup page if API token is not configured
	if (details.reason === 'install') {
		const data = await browser.storage.local.get('setupComplete');
		if (!data.setupComplete) {
			browser.tabs.create({
				url: browser.runtime.getURL('setup.html'),
			});
		}
	}
});

async function isSidePanelOpen(windowId: number): Promise<boolean> {
	return sidePanelOpenWindows.has(windowId);
}

async function setupTabListeners() {
	const browserType = await detectBrowser();
	if (['chrome', 'brave', 'edge'].includes(browserType)) {
		browser.tabs.onActivated.addListener(handleTabChange);
		browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
			if (changeInfo.status === 'complete') {
				handleTabChange({ tabId, windowId: tab.windowId });
			}
		});
	}
}

const debouncedPaintHighlights = debounce(async (tabId: number) => {
	if (!getHighlighterModeForTab(tabId)) {
		await setHighlighterMode(tabId, false);
	}
	await paintHighlights(tabId);
}, 250);

async function handleTabChange(activeInfo: { tabId: number; windowId?: number }) {
	if (activeInfo.windowId && (await isSidePanelOpen(activeInfo.windowId))) {
		updateCurrentActiveTab(activeInfo.windowId);
		await debouncedPaintHighlights(activeInfo.tabId);
	}
}

async function paintHighlights(tabId: number) {
	try {
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url || !isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		await ensureContentScriptLoadedInBackground(tabId);
		await browser.tabs.sendMessage(tabId, { action: 'paintHighlights' });
	} catch (error) {
		console.error('Error painting highlights:', error);
	}
}

async function setHighlighterMode(tabId: number, activate: boolean) {
	try {
		// First, check if the tab exists
		const tab = await browser.tabs.get(tabId);
		if (!tab || !tab.url) {
			return;
		}

		// Check if the URL is valid and not a blank page
		if (!isValidUrl(tab.url) || isBlankPage(tab.url)) {
			return;
		}

		// Then, ensure the content script is loaded
		await ensureContentScriptLoadedInBackground(tabId);

		// Now try to send the message
		highlighterModeState[tabId] = activate;
		await browser.tabs.sendMessage(tabId, { action: 'setHighlighterMode', isActive: activate });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: 'updatePopupHighlighterUI', isActive: activate });
	} catch (error) {
		console.error('Error setting highlighter mode:', error);
		// If there's an error, assume highlighter mode should be off
		highlighterModeState[tabId] = false;
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: 'updatePopupHighlighterUI', isActive: false });
	}
}

async function toggleHighlighterMode(tabId: number): Promise<boolean> {
	try {
		const currentMode = getHighlighterModeForTab(tabId);
		const newMode = !currentMode;
		highlighterModeState[tabId] = newMode;
		await browser.tabs.sendMessage(tabId, { action: 'setHighlighterMode', isActive: newMode });
		debouncedUpdateContextMenu(tabId);
		await sendMessageToPopup(tabId, { action: 'updatePopupHighlighterUI', isActive: newMode });
		return newMode;
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		throw error;
	}
}

async function highlightSelection(tabId: number, info: browser.Menus.OnClickData) {
	highlighterModeState[tabId] = true;

	const highlightData: Partial<TextHighlightData> = {
		id: Date.now().toString(),
		type: 'text',
		content: info.selectionText || '',
	};

	await browser.tabs.sendMessage(tabId, {
		action: 'highlightSelection',
		isActive: true,
		highlightData,
	});
	_hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function highlightElement(tabId: number, info: browser.Menus.OnClickData) {
	highlighterModeState[tabId] = true;

	await browser.tabs.sendMessage(tabId, {
		action: 'highlightElement',
		isActive: true,
		targetElementInfo: {
			mediaType: info.mediaType === 'image' ? 'img' : info.mediaType,
			srcUrl: info.srcUrl,
			pageUrl: info.pageUrl,
		},
	});
	_hasHighlights = true;
	debouncedUpdateContextMenu(tabId);
}

async function injectReaderScript(tabId: number) {
	try {
		await browser.scripting.insertCSS({
			target: { tabId },
			files: ['reader.css'],
		});

		// Inject scripts in sequence for all browsers
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['browser-polyfill.min.js'],
		});
		await browser.scripting.executeScript({
			target: { tabId },
			files: ['reader-script.js'],
		});

		return true;
	} catch (error) {
		console.error('Error injecting reader script:', error);
		return false;
	}
}

// Initialize the extension
initialize().catch((error) => {
	console.error('Failed to initialize background script:', error);
});
