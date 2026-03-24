import { getPropertyTypeIcon, initializeIcons } from '../icons/icons';
import { initializeVariablesPanel, showVariables, updateVariablesPanel } from '../managers/inspect-variables';
import { loadTemplates } from '../managers/template-manager';
import type { Property, SchemaOrgData, Template } from '../types/types';
import { isBlankPage, isValidUrl } from '../utils/active-tab-manager';
import { addBrowserClassToHtml, detectBrowser } from '../utils/browser-detection';
import browser from '../utils/browser-polyfill';
import { extractPageContent, initializePageContent } from '../utils/content-extractor';
import { debounce } from '../utils/debounce';
import { debugLog } from '../utils/debug';
import { createElementWithClass } from '../utils/dom-utils';
import { saveFile } from '../utils/file-utils';
import { getMessage, setupLanguageAndDirection, translatePage } from '../utils/i18n';
import {
	collectPromptVariables,
	getActiveInterpreterPromise,
	handleInterpreterUI,
	initializeInterpreter,
} from '../utils/interpreter';
import { LogseqApiError, LogseqAuthError, LogseqConnectionError } from '../utils/logseq-api';
import { checkDuplicate, saveToLogseq, updateExistingClip } from '../utils/logseq-note-creator';
import { memoizeWithExpiration } from '../utils/memoize';
import { formatPropertyValue, generateFrontmatter } from '../utils/shared';
import {
	generalSettings,
	getLocalStorage,
	incrementStat,
	loadSettings,
	type Settings,
	setLocalStorage,
} from '../utils/storage-utils';
import { sanitizeFileName, unescapeValue } from '../utils/string-utils';
import { compileTemplate } from '../utils/template-compiler';
import { findMatchingTemplate, initializeTriggers } from '../utils/triggers';
import { adjustNoteNameHeight } from '../utils/ui-utils';

interface ReaderModeResponse {
	success: boolean;
	isActive: boolean;
}

let loadedSettings: Settings;
let currentTemplate: Template | null = null;
let templates: Template[] = [];
let currentVariables: { [key: string]: string } = {};
let currentTabId: number | undefined;
// vault selection removed — vaults no longer exist in Settings

const isSidePanel = window.location.pathname.includes('side-panel.html');
const urlParams = new URLSearchParams(window.location.search);
const isIframe = urlParams.get('context') === 'iframe';

// Memoize compileTemplate with a short expiration and URL-sensitive key
const memoizedCompileTemplate = memoizeWithExpiration(
	async (tabId: number, template: string, variables: { [key: string]: string }, currentUrl: string) => {
		return compileTemplate(tabId, template, variables, currentUrl);
	},
	{
		expirationMs: 5000,
		keyFn: (tabId: number, template: string, _variables: { [key: string]: string }, currentUrl: string) =>
			`${tabId}-${template}-${currentUrl}`,
	},
);

function buildFrontmatter(properties: Property[]): string {
	const typeMap: Record<string, string> = {};
	for (const pt of generalSettings.propertyTypes) {
		typeMap[pt.name] = pt.type;
	}
	return generateFrontmatter(properties, typeMap);
}

function getPropertiesFromDOM(): Property[] {
	return Array.from(document.querySelectorAll('.metadata-property input')).map((input) => {
		const inputElement = input as HTMLInputElement;
		return {
			id: inputElement.dataset.id || Date.now().toString() + Math.random().toString(36).slice(2, 11),
			name: inputElement.id,
			value: inputElement.type === 'checkbox' ? inputElement.checked : inputElement.value,
		};
	}) as Property[];
}

// Helper function to get tab info from background script
async function getTabInfo(tabId: number): Promise<{ id: number; url: string }> {
	const response = (await browser.runtime.sendMessage({ action: 'getTabInfo', tabId })) as {
		success?: boolean;
		tab?: { id: number; url: string };
		error?: string;
	};
	if (!response || !response.success || !response.tab) {
		throw new Error(response?.error || 'Failed to get tab info');
	}
	return response.tab;
}

// Helper function to get current tab URL and title for stats
async function getCurrentTabInfo(): Promise<{ url: string; title?: string }> {
	if (!currentTabId) {
		return { url: '' };
	}

	try {
		const tab = await getTabInfo(currentTabId);
		// Try to get the title from the extracted content if available
		const extractedData = await memoizedExtractPageContent(currentTabId);
		return {
			url: tab.url,
			title: extractedData?.title || document.title,
		};
	} catch (error) {
		console.warn('Failed to get current tab info for stats:', error);
		return { url: '' };
	}
}

// Memoize extractPageContent with URL-sensitive key
const memoizedExtractPageContent = memoizeWithExpiration(
	async (tabId: number) => {
		await getTabInfo(tabId);
		return extractPageContent(tabId);
	},
	{
		expirationMs: 5000,
		keyFn: async (tabId: number) => {
			const tab = await getTabInfo(tabId);
			return `${tabId}-${tab.url}`;
		},
	},
);

// Width is used to update the note name field height
let previousWidth = window.innerWidth;

function setPopupDimensions() {
	// Get the actual height of the popup after the browser has determined its maximum
	const actualHeight = document.documentElement.offsetHeight;

	// Calculate the viewport height and width
	const viewportHeight = window.innerHeight;
	const viewportWidth = window.innerWidth;

	// Use the smaller of the two heights
	const finalHeight = Math.min(actualHeight, viewportHeight);

	// Set the --popup-height CSS variable to the final height
	document.documentElement.style.setProperty('--chromium-popup-height', `${finalHeight}px`);

	// Check if the width has changed
	if (viewportWidth !== previousWidth) {
		previousWidth = viewportWidth;

		// Adjust the note name field height
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
		if (noteNameField) {
			adjustNoteNameHeight(noteNameField);
		}
	}
}

const debouncedSetPopupDimensions = debounce(setPopupDimensions, 100); // 100ms delay

async function initializeExtension(tabId: number) {
	try {
		// Initialize translations
		await translatePage();

		// Setup language and RTL support
		await setupLanguageAndDirection();

		// First, add the browser class to allow browser-specific styles to apply
		await addBrowserClassToHtml();

		// Set an initial large height to allow the browser to determine the maximum height
		// This is necessary for browsers that allow scaling the popup via page zoom
		document.documentElement.style.setProperty('--chromium-popup-height', '2000px');

		// Use setTimeout to ensure the DOM has updated before we measure
		setTimeout(() => {
			setPopupDimensions();
		}, 0);

		debugLog('Settings', 'General settings:', loadedSettings);

		templates = await loadTemplates();
		debugLog('Templates', 'Loaded templates:', templates);

		if (templates.length === 0) {
			console.error('No templates loaded');
			return false;
		}

		// Initialize triggers to speed up template matching
		initializeTriggers(templates);

		const firstTemplate = templates[0];
		if (!firstTemplate) {
			showError('noTemplates');
			return;
		}
		currentTemplate = firstTemplate;
		debugLog('Templates', 'Current template set to:', currentTemplate);

		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}

		// Setup message listeners
		setupMessageListeners();

		await checkHighlighterModeState(tabId);

		return true;
	} catch (error) {
		console.error('Error initializing extension:', error);
		showError('failedToInitialize');
		return false;
	}
}

function setupMessageListeners() {
	browser.runtime.onMessage.addListener(
		(message: unknown, _sender: browser.Runtime.MessageSender, sendResponse: (response?: unknown) => void) => {
			const request = message as Record<string, unknown>;
			if (request.action === 'triggerQuickClip') {
				handleClipLogseq()
					.then(() => {
						sendResponse({ success: true });
					})
					.catch((error) => {
						console.error('Error in handleClipLogseq:', error);
						sendResponse({ success: false, error: error instanceof Error ? error.message : String(error) });
					});
				return true;
			} else if (request.action === 'tabUrlChanged') {
				if (request.tabId === currentTabId) {
					if (currentTabId !== undefined) {
						refreshFields(currentTabId);
					}
				}
			} else if (request.action === 'activeTabChanged') {
				// Only handle active tab changes if we're in side panel mode, not iframe mode
				if (!isIframe) {
					currentTabId = request.tabId as number | undefined;
					if (request.isValidUrl) {
						if (currentTabId !== undefined) {
							refreshFields(currentTabId); // Force template check when URL changes
						}
					} else if (request.isBlankPage) {
						showError(getMessage('pageCannotBeClipped'));
					} else {
						showError(getMessage('onlyHttpSupported'));
					}
				}
			} else if (request.action === 'highlightsUpdated') {
				if (request.tabId === currentTabId) {
					// Refresh fields when highlights are updated
					if (currentTabId !== undefined) {
						refreshFields(currentTabId);
					}
				}
			} else if (request.action === 'updatePopupHighlighterUI') {
				// This message is now handled by checkHighlighterModeState
			} else if (request.action === 'highlighterModeChanged') {
				// This message is now handled by checkHighlighterModeState
			}
		},
	);
}

document.addEventListener('DOMContentLoaded', async () => {
	loadedSettings = await loadSettings();
	if (isIframe) {
		document.documentElement.classList.add('is-embedded');
	}

	const isSidePanel = document.documentElement.classList.contains('is-side-panel');

	try {
		// Get the active tab via background script to handle Firefox compatibility
		const response = (await browser.runtime.sendMessage({ action: 'getActiveTab' })) as {
			tabId?: number;
			error?: string;
		};
		if (!response || response.error || !response.tabId) {
			showError(getMessage('pleaseReload'));
			return;
		}

		currentTabId = response.tabId;
		const tab = await getTabInfo(currentTabId);
		const currentBrowser = await detectBrowser();
		const isMobile = currentBrowser === 'mobile-safari';

		const openBehavior: Settings['openBehavior'] = isMobile ? 'popup' : loadedSettings.openBehavior;

		// Check if we should open in an iframe, but only if the URL is valid
		if (isValidUrl(tab.url) && !isBlankPage(tab.url) && openBehavior === 'embedded' && !isIframe && !isSidePanel) {
			try {
				const response = (await browser.runtime.sendMessage({ action: 'getActiveTabAndToggleIframe' })) as {
					success?: boolean;
					error?: string;
				};
				if (response?.success) {
					window.close();
					return; // Exit script after closing the window
				} else if (response?.error) {
					console.error('Error toggling iframe:', response.error);
					// If there's an error, we'll fall through and open the normal popup.
				}
			} catch (error) {
				console.error('Error toggling iframe:', error);
				// If there's an error, we'll fall through and open the normal popup.
			}
		}

		// Connect to the background script for communication
		browser.runtime.connect({ name: 'popup' });

		// Setup event listeners for popup buttons
		const refreshButton = document.getElementById('refresh-pane');
		if (refreshButton) {
			refreshButton.addEventListener('click', (e) => {
				e.preventDefault();
				refreshPopup();
				initializeIcons(refreshButton);
			});
		}
		const settingsButton = document.getElementById('open-settings');
		if (settingsButton) {
			settingsButton.addEventListener('click', async () => {
				try {
					await browser.runtime.sendMessage({ action: 'openOptionsPage' });
					setTimeout(() => window.close(), 50);
				} catch (error) {
					console.error('Error opening options page:', error);
				}
			});
			initializeIcons(settingsButton);
		}

		// Initialize the rest of the popup
		if (currentTabId) {
			const initialized = await initializeExtension(currentTabId);
			if (!initialized) {
				return;
			}

			try {
				// DOM-dependent initializations
				populateTemplateDropdown();
				setupEventListeners(currentTabId);
				await initializeUI();

				determineMainAction();

				const showMoreActionsButton = document.getElementById('show-variables');
				if (showMoreActionsButton) {
					showMoreActionsButton.addEventListener('click', (e) => {
						e.preventDefault();
						showVariables();
					});
				}

				// Initial content load
				await refreshFields(currentTabId);

				// Reconnect to in-progress batch clip if popup was reopened
				await reconnectToBatch();
			} catch (error) {
				console.error('Error initializing popup:', error);
				showError(getMessage('pleaseReload'));
			}
		} else {
			showError(getMessage('pleaseReload'));
		}
	} catch (error) {
		console.error('Error getting active tab:', error);
		showError(getMessage('pleaseReload'));
	}
});

function setupEventListeners(tabId: number) {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown) {
		templateDropdown.addEventListener('change', function (this: HTMLSelectElement) {
			handleTemplateChange(this.value);
		});
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.addEventListener('input', () => adjustNoteNameHeight(noteNameField));
		noteNameField.addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
			}
		});
	}

	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		highlighterModeButton.addEventListener('click', () => toggleHighlighterMode(tabId));
	}

	const embeddedModeButton = document.getElementById('embedded-mode');
	if (embeddedModeButton) {
		embeddedModeButton.addEventListener('click', async () => {
			try {
				await browser.runtime.sendMessage({ action: 'getActiveTabAndToggleIframe' });
				setTimeout(() => window.close(), 50);
			} catch (error) {
				console.error('Error toggling emedded iframe:', error);
			}
		});
	}

	const moreButton = document.getElementById('more-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const copyContentButton = document.getElementById('copy-content');
	const saveDownloadsButton = document.getElementById('save-downloads');
	const _shareContentButton = document.getElementById('share-content');

	if (moreButton && moreDropdown) {
		moreButton.addEventListener('click', (e) => {
			e.stopPropagation();
			const isOpen = moreDropdown.classList.toggle('show');
			moreButton.setAttribute('aria-expanded', String(isOpen));
		});

		// Close dropdown when clicking outside
		document.addEventListener('click', (e) => {
			if (!moreButton.contains(e.target as Node)) {
				moreDropdown.classList.remove('show');
				moreButton.setAttribute('aria-expanded', 'false');
			}
		});
	}

	if (copyContentButton) {
		copyContentButton.addEventListener('click', async () => {
			const properties = getPropertiesFromDOM();

			const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
			const frontmatter = buildFrontmatter(properties);
			const fileContent = frontmatter + noteContentField.value;

			await copyToClipboard(fileContent);
		});
	}

	if (saveDownloadsButton) {
		saveDownloadsButton.addEventListener('click', handleSaveToDownloads);
	}

	const shareButtons = document.querySelectorAll('.share-content');
	if (shareButtons) {
		shareButtons.forEach((button) => {
			button.addEventListener('click', async (_e) => {
				// Get content synchronously
				const properties = getPropertiesFromDOM();

				const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;

				// Build frontmatter and prepare data
				const frontmatter = buildFrontmatter(properties);
				const noteContent = noteContentField.value;
				Promise.resolve().then(() => {
					const fileContent = frontmatter + noteContent;

					// Call share directly from the click handler
					const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
					let fileName = noteNameField?.value || 'untitled';
					fileName = sanitizeFileName(fileName);
					if (!fileName.toLowerCase().endsWith('.md')) {
						fileName += '.md';
					}

					if (navigator.share && navigator.canShare) {
						const blob = new Blob([fileContent], { type: 'text/markdown;charset=utf-8' });
						const file = new File([blob], fileName, { type: 'text/markdown;charset=utf-8' });

						const shareData = {
							files: [file],
							text: 'Shared from Logseq Web Clipper',
						};

						if (navigator.canShare(shareData)) {
							const pathField = document.getElementById('path-name-field') as HTMLInputElement;
							const path = pathField?.value || '';

							navigator
								.share(shareData)
								.then(async () => {
									const tabInfo = await getCurrentTabInfo();
									await incrementStat('share', path, tabInfo.url, tabInfo.title);
									const moreDropdown = document.getElementById('more-dropdown');
									const moreBtn = document.getElementById('more-btn');
									if (moreDropdown) {
										moreDropdown.classList.remove('show');
									}
									if (moreBtn) {
										moreBtn.setAttribute('aria-expanded', 'false');
									}
								})
								.catch((error) => {
									console.error('Error sharing:', error);
								});
						}
					}
				});
			});
		});
	}

	const shareButtonElements = document.querySelectorAll('.share-content');
	if (shareButtonElements.length > 0) {
		detectBrowser().then((browser) => {
			const isSafariBrowser = ['safari', 'mobile-safari', 'ipad-os'].includes(browser);
			if (!isSafariBrowser || !navigator.share || !navigator.canShare) {
				shareButtonElements.forEach((button) => {
					const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
					if (parentElement) {
						parentElement.style.display = 'none';
					}
				});
			} else {
				// Test if we can share files (only on Safari)
				const testFile = new File(['test'], 'test.txt', { type: 'text/plain' });
				const testShare = { files: [testFile] };
				if (!navigator.canShare(testShare)) {
					shareButtonElements.forEach((button) => {
						const parentElement = button.closest('.share-btn, .menu-item') as HTMLElement;
						if (parentElement) {
							parentElement.style.display = 'none';
						}
					});
				}
			}
		});
	}

	const readerModeButton = document.getElementById('reader-mode');
	if (readerModeButton) {
		readerModeButton.addEventListener('click', () => toggleReaderMode(tabId));
	}
}

async function initializeUI() {
	const clipButton = document.getElementById('clip-btn');
	if (clipButton) {
		clipButton.focus();
	} else {
		console.warn('Clip button not found');
	}

	const showMoreActionsButton = document.getElementById('show-variables') as HTMLElement;
	const variablesPanel = document.createElement('div');
	variablesPanel.className = 'variables-panel';
	document.body.appendChild(variablesPanel);

	if (showMoreActionsButton) {
		showMoreActionsButton.addEventListener('click', async (e) => {
			e.preventDefault();
			// Initialize the variables panel with the latest data
			initializeVariablesPanel(variablesPanel, currentTemplate, currentVariables);
			await showVariables();
		});
	}

	if (isSidePanel) {
		browser.runtime.sendMessage({ action: 'sidePanelOpened' });

		window.addEventListener('unload', () => {
			browser.runtime.sendMessage({ action: 'sidePanelClosed' });
		});
	}
}

function showError(messageKey: string): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.textContent = getMessage(messageKey);
		errorMessage.style.display = 'flex';
		clipper.style.display = 'none';

		document.body.classList.add('has-error');
	}
}
function _clearError(): void {
	const errorMessage = document.querySelector('.error-message') as HTMLElement;
	const clipper = document.querySelector('.clipper') as HTMLElement;

	if (errorMessage && clipper) {
		errorMessage.style.display = 'none';
		clipper.style.display = 'block';

		document.body.classList.remove('has-error');
	}
}

function _logError(message: string, error?: unknown): void {
	console.error(message, error);
	showError(message);
}

// waitForInterpreter removed — replaced by direct Promise tracking via getActiveInterpreterPromise()

async function refreshFields(tabId: number, checkTemplateTriggers: boolean = true) {
	if (templates.length === 0) {
		console.warn('No templates available');
		showError('noTemplates');
		return;
	}

	try {
		const tab = await getTabInfo(tabId);
		if (!tab.url || isBlankPage(tab.url)) {
			showError('pageCannotBeClipped');
			return;
		}
		if (!isValidUrl(tab.url)) {
			showError('onlyHttpSupported');
			return;
		}

		// Start content extraction (don't await yet)
		const extractionPromise = memoizedExtractPageContent(tabId);

		// Match URL/regex triggers immediately (schema triggers will await extraction)
		if (checkTemplateTriggers) {
			const getSchemaOrgData = async () => {
				const data = await extractionPromise;
				return data?.schemaOrgData ?? null;
			};

			const matchedTemplate = await findMatchingTemplate(tab.url, getSchemaOrgData);
			if (matchedTemplate) {
				debugLog('Popup', 'Matched template:', matchedTemplate);
				currentTemplate = matchedTemplate;
				updateTemplateDropdown();
			}
		}

		// Show template skeleton immediately
		buildTemplateFieldsSkeleton(currentTemplate);
		setupMetadataToggle();

		const extractedData = await extractionPromise;
		if (extractedData) {
			const currentUrl = tab.url;

			const initializedContent = await initializePageContent(
				extractedData.content,
				extractedData.selectedHtml,
				extractedData.extractedContent,
				currentUrl,
				extractedData.schemaOrgData,
				extractedData.fullHtml,
				extractedData.highlights || [],
				extractedData.title,
				extractedData.author,
				extractedData.description,
				extractedData.favicon,
				extractedData.image,
				extractedData.published,
				extractedData.site,
				extractedData.wordCount,
				extractedData.language || '',
				extractedData.metaTags,
			);
			if (initializedContent) {
				currentVariables = initializedContent.currentVariables;
				debugLog('Popup', 'Updated currentVariables:', currentVariables);
				await fillTemplateFieldValues(
					tabId,
					currentTemplate,
					initializedContent.currentVariables,
					extractedData.schemaOrgData,
				);

				// Update variables panel if it's open
				updateVariablesPanel(currentTemplate, currentVariables);
			} else {
				throw new Error('Unable to initialize page content.');
			}
		} else {
			throw new Error('Unable to extract page content.');
		}
	} catch (error) {
		console.error('Error refreshing fields:', error);
		const errorMessage = error instanceof Error ? error.message : 'An unknown error occurred';
		showError(errorMessage);
	}
}

function updateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		templateDropdown.value = currentTemplate.id;
	}
}

function populateTemplateDropdown() {
	const templateDropdown = document.getElementById('template-select') as HTMLSelectElement;
	if (templateDropdown && currentTemplate) {
		// Clear existing options
		templateDropdown.textContent = '';
		const fragment = document.createDocumentFragment();
		templates.forEach((template: Template) => {
			const option = document.createElement('option');
			option.value = template.id;
			option.textContent = template.name;
			fragment.appendChild(option);
		});
		templateDropdown.appendChild(fragment);
		templateDropdown.value = currentTemplate.id;
	}
}

function buildTemplateFieldsSkeleton(template: Template | null) {
	if (!template) return;

	const existingTemplateProperties = document.querySelector('.metadata-properties') as HTMLElement;

	const newTemplateProperties = createElementWithClass('div', 'metadata-properties');

	if (Array.isArray(template.properties)) {
		for (const property of template.properties) {
			const propertyDiv = createElementWithClass('div', 'metadata-property');
			const propertyType = generalSettings.propertyTypes.find((p) => p.name === property.name)?.type || 'text';

			// Create metadata property key container
			const metadataPropertyKey = document.createElement('div');
			metadataPropertyKey.className = 'metadata-property-key';

			const propertyIconSpan = document.createElement('span');
			propertyIconSpan.className = 'metadata-property-icon';
			const iconElement = document.createElement('i');
			iconElement.setAttribute('data-lucide', getPropertyTypeIcon(propertyType));
			propertyIconSpan.appendChild(iconElement);

			const propertyLabel = document.createElement('label');
			propertyLabel.setAttribute('for', property.name);
			propertyLabel.textContent = property.name;

			metadataPropertyKey.appendChild(propertyIconSpan);
			metadataPropertyKey.appendChild(propertyLabel);

			// Create metadata property value container with empty input
			const metadataPropertyValue = document.createElement('div');
			metadataPropertyValue.className = 'metadata-property-value';

			const inputElement = document.createElement('input');
			inputElement.id = property.name;
			inputElement.setAttribute('data-type', propertyType);
			inputElement.setAttribute('data-template-value', property.value);
			inputElement.type = propertyType === 'checkbox' ? 'checkbox' : 'text';

			metadataPropertyValue.appendChild(inputElement);

			propertyDiv.appendChild(metadataPropertyKey);
			propertyDiv.appendChild(metadataPropertyValue);
			newTemplateProperties.appendChild(propertyDiv);
		}
	}

	// Replace the existing element
	if (existingTemplateProperties?.parentNode) {
		existingTemplateProperties.parentNode.replaceChild(newTemplateProperties, existingTemplateProperties);
		existingTemplateProperties.remove();
	}

	initializeIcons(newTemplateProperties);

	// Set up note name and path fields with template values
	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.setAttribute('data-template-value', template.noteNameFormat);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	const pathContainer = document.querySelector('.vault-path-container') as HTMLElement;
	if (pathField && pathContainer) {
		const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';
		if (isDailyNote) {
			pathField.style.display = 'none';
		} else {
			pathContainer.style.display = 'flex';
			pathField.setAttribute('data-template-value', template.path);
		}
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.setAttribute('data-template-value', template.noteContentFormat || '');
	}

	// Show/hide interpreter section based on template prompt variables
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn');
	const hasPromptVars = generalSettings.interpreterEnabled && collectPromptVariables(template).length > 0;
	if (interpreterContainer) interpreterContainer.style.display = hasPromptVars ? 'flex' : 'none';
	if (interpretBtn) interpretBtn.style.display = hasPromptVars ? 'inline-block' : 'none';

	// Populate model dropdown immediately (only needs generalSettings)
	if (hasPromptVars) {
		const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
		if (modelSelect) {
			const enabledModels = generalSettings.models.filter((model) => model.enabled);
			modelSelect.textContent = '';
			enabledModels.forEach((model) => {
				const option = document.createElement('option');
				option.value = model.id;
				option.textContent = model.name;
				modelSelect.appendChild(option);
			});
			modelSelect.value = generalSettings.interpreterModel || (enabledModels[0]?.id ?? '');
			modelSelect.style.display = 'inline-block';
		}
	}
}

async function fillTemplateFieldValues(
	currentTabId: number,
	template: Template | null,
	variables: { [key: string]: string },
	_schemaOrgData?: SchemaOrgData,
) {
	if (!template) return;

	const currentUrl = currentTabId ? (await getTabInfo(currentTabId)).url || '' : '';

	currentVariables = variables;

	if (!Array.isArray(template.properties)) return;

	const tabId = currentTabId ?? 0;
	// Compile all templates in parallel
	const [settledPropertyValues, formattedNoteName, formattedPath, formattedContent] = await Promise.all([
		Promise.allSettled(
			template.properties.map((property) =>
				memoizedCompileTemplate(tabId, unescapeValue(property.value), variables, currentUrl),
			),
		),
		memoizedCompileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
		memoizedCompileTemplate(tabId, template.path, variables, currentUrl),
		template.noteContentFormat
			? memoizedCompileTemplate(tabId, template.noteContentFormat, variables, currentUrl)
			: Promise.resolve(''),
	]);

	// Fill property values into existing DOM elements
	for (let i = 0; i < template.properties.length; i++) {
		const property = template.properties[i]!;
		const inputElement = document.getElementById(property.name) as HTMLInputElement;
		if (!inputElement) continue;

		const settled = settledPropertyValues[i]!;
		if (settled.status === 'rejected') {
			debugLog('Popup', `Property '${property.name}' compilation failed:`, settled.reason);
			continue;
		}

		let value = settled.value;
		const propertyType = inputElement.getAttribute('data-type') || 'text';

		// Apply type-specific parsing
		value = formatPropertyValue(value, propertyType, property.value);

		if (propertyType === 'checkbox') {
			inputElement.checked = value === 'true';
		} else {
			inputElement.value = value;
		}
	}

	const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement;
	if (noteNameField) {
		noteNameField.value = formattedNoteName.trim();
		adjustNoteNameHeight(noteNameField);
	}

	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	if (pathField) {
		pathField.value = formattedPath;
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	if (noteContentField) {
		noteContentField.value = template.noteContentFormat ? formattedContent : '';
	}

	if (generalSettings.interpreterEnabled) {
		await initializeInterpreter(template, variables, currentTabId!, currentUrl);

		const promptVariables = collectPromptVariables(template);

		if (generalSettings.interpreterAutoRun && promptVariables.length > 0) {
			try {
				const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
				const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
				const selectedModelId = modelSelect?.value || generalSettings.interpreterModel;
				const modelConfig = generalSettings.models.find((m) => m.id === selectedModelId);
				if (!modelConfig) {
					throw new Error(`Model configuration not found for ${selectedModelId}`);
				}
				await handleInterpreterUI(template, variables, currentTabId!, currentUrl, modelConfig);

				if (interpretBtn) {
					interpretBtn.classList.add('done');
					interpretBtn.disabled = true;
				}
			} catch (error) {
				console.error('Error auto-processing with interpreter:', error);
				const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
				if (interpretBtn) {
					interpretBtn.classList.add('error');
				}
			}
		}
	}

	debugLog('Variables', 'Template variables loaded:', Object.keys(variables).length);
}

function setupMetadataToggle() {
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;

	if (metadataHeader && metadataProperties) {
		metadataHeader.removeEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('click', toggleMetadataProperties);
		metadataHeader.addEventListener('keydown', (e: KeyboardEvent) => {
			if (e.key === 'Enter' || e.key === ' ') {
				e.preventDefault();
				toggleMetadataProperties();
			}
		});

		// Set initial state
		getLocalStorage('propertiesCollapsed').then((isCollapsed) => {
			if (isCollapsed === undefined) {
				// If the value is not set, default to not collapsed
				updateMetadataToggleState(false);
			} else {
				updateMetadataToggleState(isCollapsed as boolean);
			}
		});
	}
}

function toggleMetadataProperties() {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;

	if (metadataProperties && metadataHeader) {
		const isCollapsed = metadataProperties.classList.toggle('collapsed');
		metadataHeader.classList.toggle('collapsed');
		metadataHeader.setAttribute('aria-expanded', String(!isCollapsed));
		setLocalStorage('propertiesCollapsed', isCollapsed);
	}
}

function updateMetadataToggleState(isCollapsed: boolean) {
	const metadataProperties = document.querySelector('.metadata-properties') as HTMLElement;
	const metadataHeader = document.querySelector('.metadata-properties-header') as HTMLElement;

	if (metadataProperties && metadataHeader) {
		if (isCollapsed) {
			metadataProperties.classList.add('collapsed');
			metadataHeader.classList.add('collapsed');
		} else {
			metadataProperties.classList.remove('collapsed');
			metadataHeader.classList.remove('collapsed');
		}
	}
}

interface ReplacedTemplate {
	schemaVersion: string;
	name: string;
	behavior: string;
	noteNameFormat: string;
	path?: string;
	noteContentFormat: string;
	properties: Property[];
	triggers?: string[];
	context?: string;
}

async function _getReplacedTemplate(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string,
): Promise<ReplacedTemplate> {
	const replacedTemplate: ReplacedTemplate = {
		schemaVersion: '0.1.0',
		name: template.name,
		behavior: template.behavior,
		noteNameFormat: await compileTemplate(tabId, template.noteNameFormat, variables, currentUrl),
		path: template.path,
		noteContentFormat: await compileTemplate(tabId, template.noteContentFormat, variables, currentUrl),
		properties: [],
		triggers: template.triggers,
	};

	if (template.context) {
		replacedTemplate.context = await compileTemplate(tabId, template.context, variables, currentUrl);
	}

	for (const prop of template.properties) {
		const replacedProp: Property = {
			id: prop.id,
			name: prop.name,
			value: await compileTemplate(tabId, prop.value, variables, currentUrl),
		};
		replacedTemplate.properties.push(replacedProp);
	}

	return replacedTemplate;
}

function refreshPopup() {
	window.location.reload();
}

function handleTemplateChange(templateId: string) {
	currentTemplate = templates.find((t) => t.id === templateId) ?? templates[0]!;
	refreshFields(currentTabId!, false);
}

async function checkHighlighterModeState(tabId: number) {
	try {
		const response = (await browser.runtime.sendMessage({
			action: 'getHighlighterMode',
			tabId: tabId,
		})) as { isActive: boolean };

		const isHighlighterMode = response.isActive;

		loadedSettings = await loadSettings();

		updateHighlighterModeUI(isHighlighterMode);
	} catch (error) {
		console.error('Error checking highlighter mode state:', error);
		// If there's an error, assume highlighter mode is off
		updateHighlighterModeUI(false);
	}
}

async function toggleHighlighterMode(tabId: number) {
	try {
		const response = (await browser.runtime.sendMessage({
			action: 'toggleHighlighterMode',
			tabId: tabId,
		})) as { success: boolean; isActive: boolean; error?: string };

		if (response?.success) {
			const isNowActive = response.isActive;
			updateHighlighterModeUI(isNowActive);

			// Close the popup if highlighter mode is turned on and not in side panel
			if (isNowActive && !isSidePanel && !isIframe) {
				setTimeout(() => window.close(), 50);
			}
		} else {
			throw new Error(response.error || 'Failed to toggle highlighter mode.');
		}
	} catch (error) {
		console.error('Error toggling highlighter mode:', error);
		showError('failedToToggleHighlighter');
	}
}

function updateHighlighterModeUI(isActive: boolean) {
	const highlighterModeButton = document.getElementById('highlighter-mode');
	if (highlighterModeButton) {
		if (generalSettings.highlighterEnabled) {
			highlighterModeButton.style.display = 'flex';
			highlighterModeButton.classList.toggle('active', isActive);
			highlighterModeButton.setAttribute('aria-pressed', isActive.toString());
			highlighterModeButton.title = isActive ? getMessage('disableHighlighter') : getMessage('enableHighlighter');
		} else {
			highlighterModeButton.style.display = 'none';
		}
	}
}

async function toggleReaderMode(tabId: number) {
	try {
		const response = (await browser.runtime.sendMessage({
			action: 'toggleReaderMode',
			tabId: tabId,
		})) as ReaderModeResponse;

		if (response?.success) {
			const readerButton = document.getElementById('reader-mode');
			if (readerButton) {
				const isActive = response.isActive ?? false;
				readerButton.classList.toggle('active', isActive);
				readerButton.setAttribute('aria-pressed', isActive.toString());
				readerButton.title = isActive ? getMessage('disableReader') : getMessage('enableReader');
			}
		}

		// Close the popup if not in side panel
		if (!isSidePanel) {
			window.close();
		}
	} catch (error) {
		console.error('Error toggling reader mode:', error);
		showError('failedToToggleReaderMode');
	}
}

export async function copyToClipboard(content: string) {
	try {
		await browser.runtime.sendMessage({
			action: 'copy-to-clipboard',
			text: content,
		});

		const pathField = document.getElementById('path-name-field') as HTMLInputElement;
		const path = pathField?.value || '';

		const tabInfo = await getCurrentTabInfo();
		await incrementStat('copyToClipboard', path, tabInfo.url, tabInfo.title);

		// Change the main button text temporarily
		const clipButton = document.getElementById('clip-btn');
		if (clipButton) {
			const originalText = clipButton.textContent || getMessage('addToLogseq');
			clipButton.textContent = getMessage('copied');

			// Reset the text after 1.5 seconds
			setTimeout(() => {
				clipButton.textContent = originalText;
			}, 1500);
		}
	} catch (error) {
		console.error('Failed to copy to clipboard:', error);
		showError('failedToCopyText');
	}
}

async function handleSaveToDownloads() {
	try {
		const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
		const pathField = document.getElementById('path-name-field') as HTMLInputElement;

		const fileName = noteNameField?.value || 'untitled';
		const path = pathField?.value || '';

		const properties = getPropertiesFromDOM();

		const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
		const frontmatter = buildFrontmatter(properties);
		const fileContent = frontmatter + noteContentField.value;

		await saveFile({
			content: fileContent,
			fileName,
			mimeType: 'text/markdown',
			tabId: currentTabId,
			onError: (_error) => showError('failedToSaveFile'),
		});

		const tabInfo = await getCurrentTabInfo();
		await incrementStat('saveFile', path, tabInfo.url, tabInfo.title);

		const moreDropdown = document.getElementById('more-dropdown');
		const moreBtn = document.getElementById('more-btn');
		if (moreDropdown) {
			moreDropdown.classList.remove('show');
		}
		if (moreBtn) {
			moreBtn.setAttribute('aria-expanded', 'false');
		}
	} catch (error) {
		console.error('Failed to save file:', error);
		showError('failedToSaveFile');
	}
}

function determineMainAction() {
	const mainButton = document.getElementById('clip-btn');
	const moreDropdown = document.getElementById('more-dropdown');
	const secondaryActions = moreDropdown?.querySelector('.secondary-actions');
	if (!mainButton || !secondaryActions) return;

	// Clear existing secondary actions
	secondaryActions.textContent = '';

	// Set up actions based on saved behavior
	switch (loadedSettings.saveBehavior) {
		case 'copyToClipboard':
			mainButton.textContent = getMessage('copyToClipboard');
			mainButton.onclick = () => copyContent();
			// Add direct actions to secondary
			addSecondaryAction(secondaryActions, 'addToLogseq', () =>
				handleClipLogseq().catch((e) => debugLog('Clip', 'Unhandled clip error:', e)),
			);
			addSecondaryAction(secondaryActions, 'saveFile', handleSaveToDownloads);
			addSecondaryAction(secondaryActions, 'saveAsPage', () =>
				handleClipLogseq('create').catch((e) => debugLog('Clip', 'Unhandled clip error:', e)),
			);
			addSecondaryAction(secondaryActions, 'clipAllTabs', showBatchView);
			break;
		case 'saveFile':
			mainButton.textContent = getMessage('saveFile');
			mainButton.onclick = () => handleSaveToDownloads();
			// Add direct actions to secondary
			addSecondaryAction(secondaryActions, 'addToLogseq', () =>
				handleClipLogseq().catch((e) => debugLog('Clip', 'Unhandled clip error:', e)),
			);
			addSecondaryAction(secondaryActions, 'copyToClipboard', copyContent);
			addSecondaryAction(secondaryActions, 'saveAsPage', () =>
				handleClipLogseq('create').catch((e) => debugLog('Clip', 'Unhandled clip error:', e)),
			);
			addSecondaryAction(secondaryActions, 'clipAllTabs', showBatchView);
			break;
		default: // 'addToLogseq'
			mainButton.textContent = getMessage('addToLogseq');
			mainButton.onclick = () => handleClipLogseq().catch((e) => debugLog('Clip', 'Unhandled clip error:', e));
			// Add direct actions to secondary
			addSecondaryAction(secondaryActions, 'copyToClipboard', copyContent);
			addSecondaryAction(secondaryActions, 'saveFile', handleSaveToDownloads);
			addSecondaryAction(secondaryActions, 'saveAsPage', () =>
				handleClipLogseq('create').catch((e) => debugLog('Clip', 'Unhandled clip error:', e)),
			);
			addSecondaryAction(secondaryActions, 'clipAllTabs', showBatchView);
	}
}

async function handleClipLogseq(behaviorOverride?: Template['behavior']): Promise<void> {
	const clipBtn = document.getElementById('clip-btn') as HTMLButtonElement;
	if (clipBtn) clipBtn.disabled = true;

	if (!currentTemplate) {
		if (clipBtn) clipBtn.disabled = false;
		return;
	}

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const noteNameField = document.getElementById('note-name-field') as HTMLInputElement;
	const pathField = document.getElementById('path-name-field') as HTMLInputElement;
	const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;

	if (!noteContentField) {
		showError('Some required fields are missing. Please try reloading the extension.');
		if (clipBtn) clipBtn.disabled = false;
		return;
	}

	try {
		// Handle interpreter if needed
		if (generalSettings.interpreterEnabled && interpretBtn && collectPromptVariables(currentTemplate).length > 0) {
			const inFlight = getActiveInterpreterPromise();
			if (inFlight) {
				// Interpreter already running — await it directly
				await inFlight;
			} else if (!interpretBtn.classList.contains('done')) {
				// Start interpreter and await it directly (no click + poll)
				const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
				const selectedModelId = modelSelect?.value || generalSettings.interpreterModel;
				const modelConfig = generalSettings.models.find((m) => m.id === selectedModelId);
				if (modelConfig) {
					await handleInterpreterUI(currentTemplate, currentVariables, currentTabId!, '', modelConfig);
				}
			}
		}

		// Gather content
		const properties = getPropertiesFromDOM();
		const noteContent = noteContentField.value;
		const behavior = behaviorOverride ?? currentTemplate.behavior;
		const isDailyNote = behavior === 'append-daily' || behavior === 'prepend-daily';
		const noteName = isDailyNote ? '' : noteNameField?.value || '';
		const path = isDailyNote ? '' : pathField?.value || '';

		if (behavior === 'create' && !noteName.trim()) {
			showError('Page name is required when saving as a new page.');
			return;
		}

		// Get current URL for dedup check
		const tabInfo = await getCurrentTabInfo();
		const currentUrl = tabInfo.url || '';

		// Skip dedup for explicit "save as page" — user explicitly wants a new page
		if (!behaviorOverride) {
			const dup = await checkDuplicate(currentUrl);
			if (dup.exists) {
				const action = confirm(
					`This URL was already clipped${dup.clippedAt ? ` on ${dup.clippedAt}` : ''} to page '${dup.pageTitle}'. ` +
						`Press OK to update existing, or Cancel to create new.`,
				);
				if (action) {
					await updateExistingClip(dup.pageTitle!, noteContent, properties, currentUrl);
					await incrementStat('addToLogseq', path, tabInfo.url, tabInfo.title);
					if (!isSidePanel) {
						setTimeout(() => window.close(), 500);
					}
					return;
				}
				// User chose Cancel — proceed with normal save (create new)
			}
		}

		await saveToLogseq(noteContent, noteName, properties, behavior, currentUrl);
		await incrementStat('addToLogseq', path, tabInfo.url, tabInfo.title);

		if (!isSidePanel) {
			setTimeout(() => window.close(), 500);
		}
	} catch (error) {
		if (error instanceof LogseqConnectionError) {
			showError('Logseq is not running or API server is not started.');
		} else if (error instanceof LogseqAuthError) {
			showError('Invalid API token. Check Settings → Logseq Connection.');
		} else if (error instanceof LogseqApiError) {
			debugLog('Save', 'Logseq API error:', error.status, error.message);
			showError('Save failed. Check that Logseq is open and the target page exists.');
		} else {
			const msg = error instanceof Error ? error.message : String(error);
			debugLog('Save', 'Save error:', msg);
			showError(`Save failed: ${msg}`);
		}
		throw error; // Keep throw — quickClip .catch() at line 217 needs it
	} finally {
		if (clipBtn) clipBtn.disabled = false;
	}
}

function addSecondaryAction(container: Element, actionType: string, handler: () => void) {
	const menuItem = document.createElement('button');
	menuItem.type = 'button';
	menuItem.className = 'menu-item';

	// Create menu item icon container
	const menuItemIcon = document.createElement('div');
	menuItemIcon.className = 'menu-item-icon';

	const iconElement = document.createElement('i');
	iconElement.setAttribute('data-lucide', getActionIcon(actionType));
	menuItemIcon.appendChild(iconElement);

	// Create menu item title
	const menuItemTitle = document.createElement('div');
	menuItemTitle.className = 'menu-item-title';
	menuItemTitle.setAttribute('data-i18n', actionType);
	menuItemTitle.textContent = getMessage(actionType);

	// Assemble menu item
	menuItem.appendChild(menuItemIcon);
	menuItem.appendChild(menuItemTitle);

	menuItem.addEventListener('click', handler);
	container.appendChild(menuItem);
	initializeIcons(menuItem);
}

function getActionIcon(actionType: string): string {
	switch (actionType) {
		case 'copyToClipboard':
			return 'copy';
		case 'saveFile':
			return 'file-down';
		case 'addToLogseq':
			return 'pen-line';
		case 'saveAsPage':
			return 'file-plus';
		case 'clipAllTabs':
			return 'layers';
		default:
			return 'plus';
	}
}

async function copyContent() {
	const properties = getPropertiesFromDOM();

	const noteContentField = document.getElementById('note-content-field') as HTMLTextAreaElement;
	const frontmatter = buildFrontmatter(properties);
	const fileContent = frontmatter + noteContentField.value;
	await copyToClipboard(fileContent);
}

// --- Batch Tab Clip UI ---

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

interface ClippableTab {
	id: number;
	title: string;
	url: string;
	favIconUrl: string;
	matchedTemplateId: string;
}

let batchTabs: ClippableTab[] = [];
let batchProgressListener:
	| ((
			message: unknown,
			sender: browser.Runtime.MessageSender,
			sendResponse: (response?: unknown) => void,
	  ) => undefined)
	| null = null;

function showBatchView(): void {
	const clipper = document.querySelector('.clipper') as HTMLElement;
	const popupHeader = document.getElementById('popup-header') as HTMLElement;
	const batchView = document.getElementById('batch-clip-view') as HTMLElement;
	if (!batchView) return;

	if (clipper) clipper.style.display = 'none';
	if (popupHeader) popupHeader.style.display = 'none';
	batchView.style.display = 'flex';

	// Reset sub-views
	const batchProgress = document.getElementById('batch-progress') as HTMLElement;
	const batchComplete = document.getElementById('batch-complete') as HTMLElement;
	const batchTabList = document.getElementById('batch-tab-list') as HTMLElement;
	const batchControls = document.querySelector('.batch-controls') as HTMLElement;
	const batchActions = batchView.querySelector('.batch-actions') as HTMLElement;
	if (batchProgress) batchProgress.style.display = 'none';
	if (batchComplete) batchComplete.style.display = 'none';
	if (batchTabList) batchTabList.style.display = '';
	if (batchControls) batchControls.style.display = '';
	if (batchActions) batchActions.style.display = '';

	// Fetch clippable tabs
	browser.runtime.sendMessage({ action: 'getClippableTabs' }).then((response) => {
		const resp = response as { success: boolean; tabs: ClippableTab[] };
		if (resp?.success) {
			batchTabs = resp.tabs;
			renderBatchTabList(batchTabs);
		}
	});

	// Wire event listeners
	const backBtn = document.getElementById('batch-back-btn');
	if (backBtn) {
		backBtn.onclick = hideBatchView;
	}

	const selectAllCheckbox = document.getElementById('batch-select-all') as HTMLInputElement;
	if (selectAllCheckbox) {
		selectAllCheckbox.onclick = handleSelectAll;
	}

	const clipBtn = document.getElementById('batch-clip-btn');
	if (clipBtn) {
		clipBtn.onclick = startBatchClip;
	}

	initializeIcons(batchView);
}

function hideBatchView(): void {
	const clipper = document.querySelector('.clipper') as HTMLElement;
	const popupHeader = document.getElementById('popup-header') as HTMLElement;
	const batchView = document.getElementById('batch-clip-view') as HTMLElement;

	if (batchView) batchView.style.display = 'none';
	if (clipper) clipper.style.display = '';
	if (popupHeader) popupHeader.style.display = '';
}

function renderBatchTabList(tabs: ClippableTab[]): void {
	const list = document.getElementById('batch-tab-list');
	if (!list) return;

	list.textContent = '';
	const fragment = document.createDocumentFragment();

	for (const tab of tabs) {
		const row = document.createElement('div');
		row.className = 'batch-tab-row';
		row.dataset.tabId = String(tab.id);

		const checkbox = document.createElement('input');
		checkbox.type = 'checkbox';
		checkbox.checked = true;
		checkbox.dataset.tabId = String(tab.id);
		checkbox.addEventListener('change', updateBatchCount);
		row.appendChild(checkbox);

		const favicon = document.createElement('img');
		favicon.className = 'batch-tab-favicon';
		favicon.src = tab.favIconUrl || '';
		favicon.alt = '';
		favicon.onerror = () => {
			favicon.style.display = 'none';
		};
		row.appendChild(favicon);

		const title = document.createElement('span');
		title.className = 'batch-tab-title';
		title.textContent = tab.title;
		title.title = tab.title;
		row.appendChild(title);

		const templateSelect = document.createElement('select');
		templateSelect.className = 'batch-tab-template';
		templateSelect.dataset.tabId = String(tab.id);
		for (const t of templates) {
			const option = document.createElement('option');
			option.value = t.id;
			option.textContent = t.name;
			templateSelect.appendChild(option);
		}
		if (tab.matchedTemplateId) {
			templateSelect.value = tab.matchedTemplateId;
		}
		row.appendChild(templateSelect);

		fragment.appendChild(row);
	}

	list.appendChild(fragment);
	updateBatchCount();
}

function updateBatchCount(): void {
	const checkboxes = document.querySelectorAll<HTMLInputElement>('#batch-tab-list input[type="checkbox"]');
	const checked = Array.from(checkboxes).filter((cb) => cb.checked).length;
	const total = checkboxes.length;

	const countEl = document.getElementById('batch-tab-count');
	if (countEl) {
		countEl.textContent = `${checked} / ${total}`;
	}

	const clipBtn = document.getElementById('batch-clip-btn');
	if (clipBtn) {
		clipBtn.textContent = `Clip selected (${checked})`;
		(clipBtn as HTMLButtonElement).disabled = checked === 0;
	}

	// Update select-all checkbox state
	const selectAll = document.getElementById('batch-select-all') as HTMLInputElement;
	if (selectAll) {
		selectAll.checked = checked === total;
		selectAll.dataset.indeterminate = String(checked > 0 && checked < total);
	}
}

function handleSelectAll(): void {
	const selectAll = document.getElementById('batch-select-all') as HTMLInputElement;
	const checkboxes = Array.from(
		document.querySelectorAll<HTMLInputElement>('#batch-tab-list input[type="checkbox"]'),
	);
	const shouldCheck = selectAll.checked;

	for (const cb of checkboxes) {
		cb.checked = shouldCheck;
	}
	updateBatchCount();
}

function startBatchClip(): void {
	const checkboxes = Array.from(
		document.querySelectorAll<HTMLInputElement>('#batch-tab-list input[type="checkbox"]'),
	);
	const clips: Array<{ tabId: number; templateId: string }> = [];

	for (const cb of checkboxes) {
		if (!cb.checked) continue;
		const tabId = Number(cb.dataset.tabId);
		const templateSelect = document.querySelector<HTMLSelectElement>(
			`#batch-tab-list select[data-tab-id="${tabId}"]`,
		);
		const templateId = templateSelect?.value || templates[0]?.id || '';
		clips.push({ tabId, templateId });
	}

	if (clips.length === 0) return;

	browser.runtime.sendMessage({
		action: 'executeBatchClip',
		clips,
		templates,
	});

	showBatchProgress(clips);
}

function showBatchProgress(clips: Array<{ tabId: number; templateId: string }>): void {
	const batchView = document.getElementById('batch-clip-view') as HTMLElement;
	const batchTabList = document.getElementById('batch-tab-list') as HTMLElement;
	const batchControls = document.querySelector('.batch-controls') as HTMLElement;
	const batchActions = batchView?.querySelector('.batch-actions') as HTMLElement;
	const batchProgress = document.getElementById('batch-progress') as HTMLElement;
	const batchComplete = document.getElementById('batch-complete') as HTMLElement;

	if (batchTabList) batchTabList.style.display = 'none';
	if (batchControls) batchControls.style.display = 'none';
	if (batchActions) batchActions.style.display = 'none';
	if (batchComplete) batchComplete.style.display = 'none';
	if (batchProgress) batchProgress.style.display = '';

	const progressHeader = document.getElementById('batch-progress-header');
	if (progressHeader) {
		progressHeader.textContent = `Clipping 0 / ${clips.length}...`;
	}

	// Build initial progress list
	const progressList = document.getElementById('batch-progress-list');
	if (progressList) {
		progressList.textContent = '';
		const fragment = document.createDocumentFragment();
		for (const clip of clips) {
			const tab = batchTabs.find((t) => t.id === clip.tabId);
			const row = document.createElement('div');
			row.className = 'batch-progress-row';
			row.dataset.tabId = String(clip.tabId);

			const icon = document.createElement('span');
			icon.className = 'status-icon';
			icon.textContent = '\u00B7'; // middle dot for pending
			row.appendChild(icon);

			const title = document.createElement('span');
			title.textContent = tab?.title || `Tab ${clip.tabId}`;
			row.appendChild(title);

			fragment.appendChild(row);
		}
		progressList.appendChild(fragment);
	}

	// Wire cancel button
	const cancelBtn = document.getElementById('batch-cancel-btn');
	if (cancelBtn) {
		cancelBtn.onclick = () => {
			browser.runtime.sendMessage({ action: 'cancelBatchClip' });
		};
	}

	// Listen for progress updates
	if (batchProgressListener) {
		browser.runtime.onMessage.removeListener(batchProgressListener);
	}
	batchProgressListener = (
		message: unknown,
		_sender: browser.Runtime.MessageSender,
		_sendResponse: (response?: unknown) => void,
	) => {
		const msg = message as Record<string, unknown>;
		if (msg.action === 'batchClipProgress') {
			const state = msg.state as BatchClipState;
			updateBatchProgressUI(state);
			if (state.status === 'complete' || state.status === 'cancelled') {
				showBatchComplete(state);
				if (batchProgressListener) {
					browser.runtime.onMessage.removeListener(batchProgressListener);
					batchProgressListener = null;
				}
			}
		}
		return undefined;
	};
	browser.runtime.onMessage.addListener(batchProgressListener);
}

const STATUS_ICONS: Record<string, string> = {
	pending: '\u00B7',
	clipping: '\u231B',
	done: '\u2713',
	failed: '\u2717',
	duplicate: '\u2298',
};

function updateBatchProgressUI(state: BatchClipState): void {
	const progressHeader = document.getElementById('batch-progress-header');
	if (progressHeader) {
		progressHeader.textContent = `Clipping ${state.current} / ${state.total}...`;
	}

	for (const result of state.results) {
		const row = document.querySelector(`.batch-progress-row[data-tab-id="${result.tabId}"]`);
		if (!row) continue;
		const icon = row.querySelector('.status-icon');
		if (icon) {
			icon.textContent = STATUS_ICONS[result.status] || '\u00B7';
		}
	}
}

function showBatchComplete(state: BatchClipState): void {
	const batchProgress = document.getElementById('batch-progress') as HTMLElement;
	const batchComplete = document.getElementById('batch-complete') as HTMLElement;

	if (batchProgress) batchProgress.style.display = 'none';
	if (batchComplete) batchComplete.style.display = '';

	const done = state.results.filter((r) => r.status === 'done').length;
	const failed = state.results.filter((r) => r.status === 'failed').length;
	const duplicate = state.results.filter((r) => r.status === 'duplicate').length;

	const summary = document.getElementById('batch-complete-summary');
	if (summary) {
		const parts: string[] = [];
		if (done > 0) parts.push(`${done} clipped`);
		if (failed > 0) parts.push(`${failed} failed`);
		if (duplicate > 0) parts.push(`${duplicate} already existed`);
		summary.textContent = parts.join(', ') || 'No tabs processed';
	}

	const errorsEl = document.getElementById('batch-complete-errors');
	if (errorsEl) {
		errorsEl.textContent = '';
		const failedResults = state.results.filter((r) => r.status === 'failed');
		if (failedResults.length > 0) {
			for (const r of failedResults) {
				const div = document.createElement('div');
				div.textContent = `${r.title}: ${r.error || 'Unknown error'}`;
				errorsEl.appendChild(div);
			}
		}
	}

	// Close tabs prompt
	const closeable = state.results.filter((r) => r.status === 'done' || r.status === 'duplicate');
	const closeQuestion = document.getElementById('batch-close-question');
	const closePrompt = document.querySelector('.batch-close-prompt') as HTMLElement;

	if (closeable.length > 0) {
		if (closeQuestion) {
			closeQuestion.textContent = `Close ${closeable.length} clipped tab${closeable.length === 1 ? '' : 's'}?`;
		}
		if (closePrompt) closePrompt.style.display = '';

		const yesBtn = document.getElementById('batch-close-yes');
		const noBtn = document.getElementById('batch-close-no');

		if (yesBtn) {
			yesBtn.onclick = () => {
				browser.runtime.sendMessage({ action: 'closeClippedTabs' });
				hideBatchView();
			};
		}
		if (noBtn) {
			noBtn.onclick = () => {
				browser.runtime.sendMessage({ action: 'dismissBatchClip' });
				hideBatchView();
			};
		}
	} else {
		if (closePrompt) closePrompt.style.display = 'none';
		// Auto-dismiss after a short delay since there's nothing to close
		setTimeout(() => {
			browser.runtime.sendMessage({ action: 'dismissBatchClip' });
		}, 100);
	}
}

async function reconnectToBatch(): Promise<void> {
	try {
		const response = (await browser.runtime.sendMessage({ action: 'getBatchClipStatus' })) as {
			success: boolean;
			state: BatchClipState;
		};
		if (!response?.success) return;

		const state = response.state;
		if (state.status === 'clipping') {
			// Show batch view in progress mode
			const clipper = document.querySelector('.clipper') as HTMLElement;
			const popupHeader = document.getElementById('popup-header') as HTMLElement;
			const batchView = document.getElementById('batch-clip-view') as HTMLElement;
			if (!batchView) return;

			if (clipper) clipper.style.display = 'none';
			if (popupHeader) popupHeader.style.display = 'none';
			batchView.style.display = 'flex';

			initializeIcons(batchView);

			// Reconstruct clips from state results for progress view
			const clips = state.results.map((r) => ({ tabId: r.tabId, templateId: '' }));
			batchTabs = state.results.map((r) => ({
				id: r.tabId,
				title: r.title,
				url: '',
				favIconUrl: '',
				matchedTemplateId: '',
			}));
			showBatchProgress(clips);
			updateBatchProgressUI(state);
		} else if (state.status === 'complete' || state.status === 'cancelled') {
			const clipper = document.querySelector('.clipper') as HTMLElement;
			const popupHeader = document.getElementById('popup-header') as HTMLElement;
			const batchView = document.getElementById('batch-clip-view') as HTMLElement;
			if (!batchView) return;

			if (clipper) clipper.style.display = 'none';
			if (popupHeader) popupHeader.style.display = 'none';
			batchView.style.display = 'flex';

			// Hide the review list UI
			const batchTabList = document.getElementById('batch-tab-list') as HTMLElement;
			const batchControls = document.querySelector('.batch-controls') as HTMLElement;
			const batchActions = batchView.querySelector('.batch-actions') as HTMLElement;
			if (batchTabList) batchTabList.style.display = 'none';
			if (batchControls) batchControls.style.display = 'none';
			if (batchActions) batchActions.style.display = 'none';

			initializeIcons(batchView);
			showBatchComplete(state);
		}
		// 'idle' → do nothing
	} catch {
		// Background may not be ready yet — that's fine
	}
}

// Update the resize event listener to use the debounced version
window.addEventListener('resize', debouncedSetPopupDimensions);
