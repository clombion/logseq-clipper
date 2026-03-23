import { compressToUTF16, decompressFromUTF16 } from 'lz-string';
import { addPropertyType, updatePropertyTypesList } from '../managers/property-types-manager';
import { editingTemplateIndex, loadTemplates, saveTemplateSettings, templates } from '../managers/template-manager';
import { showTemplateEditor, updateTemplateList } from '../managers/template-ui';
import type { Template } from '../types/types';
import browser from '../utils/browser-polyfill';
import { hideModal } from '../utils/modal-utils';
import { generalSettings, loadSettings } from '../utils/storage-utils';
import { copyToClipboardWithFeedback } from './clipboard-utils';
import { debugLog } from './debug';
import { saveFile } from './file-utils';
import { getMessage } from './i18n';
import { showImportModal } from './import-modal';
import { sanitizeFileName } from './string-utils';

const SCHEMA_VERSION = '0.1.0';

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Add these type definitions at the top
interface StorageData {
	// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
	[key: string]: any;
	template_list?: string[];
}

export async function exportTemplate(): Promise<void> {
	if (editingTemplateIndex === -1) {
		alert(getMessage('selectTemplateToExport'));
		return;
	}

	const template = templates[editingTemplateIndex] as Template;
	const sanitizedName = sanitizeFileName(template.name);
	const fileName = `${sanitizedName.replace(/\s+/g, '-').toLowerCase()}-clipper.json`;

	const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';

	const orderedTemplate: Partial<Template> & { schemaVersion: string } = {
		schemaVersion: SCHEMA_VERSION,
		name: template.name,
		behavior: template.behavior,
		noteContentFormat: template.noteContentFormat,
		properties: template.properties.map(({ name, value, type }) => ({
			name,
			value,
			type: type || generalSettings.propertyTypes.find((pt) => pt.name === name)?.type || 'text',
		})),
		triggers: template.triggers,
	};

	// Only include noteNameFormat and path for non-daily note behaviors
	if (!isDailyNote) {
		orderedTemplate.noteNameFormat = template.noteNameFormat;
		orderedTemplate.path = template.path;
	}

	// Include context only if it has a value
	if (template.context) {
		orderedTemplate.context = template.context;
	}

	const content = JSON.stringify(orderedTemplate, null, '\t');

	await saveFile({
		content,
		fileName,
		mimeType: 'application/json',
		onError: (error) => console.error('Failed to export template:', error),
	});
}

export function importTemplate(input?: HTMLInputElement): void {
	if (!input) {
		input = document.createElement('input');
		input.type = 'file';
		input.accept = '.json';
	}

	const handleFile = (file: File) => {
		const reader = new FileReader();
		reader.onload = async (e: ProgressEvent<FileReader>) => {
			try {
				const raw: unknown = JSON.parse(e.target?.result as string);
				if (!isPlainObject(raw)) {
					throw new Error('Invalid template file: expected a JSON object');
				}
				const importedTemplate = raw as Partial<Template>;
				debugLog('ImportExport', 'Imported template:', importedTemplate);

				if (!validateImportedTemplate(importedTemplate)) {
					throw new Error('Invalid template file');
				}

				importedTemplate.id = Date.now().toString() + Math.random().toString(36).slice(2, 9);

				// Handle property types and preserve existing IDs or generate new ones
				if (importedTemplate.properties) {
					importedTemplate.properties = await Promise.all(
						// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
						importedTemplate.properties.map(async (prop: any) => {
							debugLog('ImportExport', 'Processing property:', prop);
							// Add or update the property type
							await addPropertyType(prop.name, prop.type || 'text', prop.value || '');

							// Use the type from generalSettings, which will be either the existing type or the newly added one
							const type =
								generalSettings.propertyTypes.find((pt) => pt.name === prop.name)?.type || 'text';
							debugLog('ImportExport', `Property ${prop.name} type after processing:`, type);
							return {
								id: prop.id || Date.now().toString() + Math.random().toString(36).slice(2, 9),
								name: prop.name,
								value: prop.value,
								type: type,
							};
						}),
					);
				}

				debugLog('ImportExport', 'Processed template properties:', importedTemplate.properties);

				// Keep the context if it exists in the imported template
				// context is preserved as-is from the imported template

				let newName = importedTemplate.name as string;
				let counter = 1;
				while (templates.some((t) => t.name === newName)) {
					newName = `${importedTemplate.name} (${counter++})`;
				}
				importedTemplate.name = newName;

				debugLog('ImportExport', 'Final imported template:', importedTemplate);
				templates.unshift(importedTemplate as Template);

				saveTemplateSettings();
				updateTemplateList();
				showTemplateEditor(importedTemplate as Template);
				hideModal(document.getElementById('import-modal'));
			} catch (error) {
				console.error('Error parsing imported template:', error);
				alert(getMessage('failedToImportTemplate'));
			}
		};
		reader.readAsText(file);
	};

	if (input.files && input.files.length > 0) {
		handleFile(input.files[0]!);
	} else {
		input.onchange = (event: Event) => {
			const file = (event.target as HTMLInputElement).files?.[0];
			if (file) {
				handleFile(file);
			}
		};
		input.click();
	}
}

function validateImportedTemplate(template: Partial<Template>): boolean {
	const requiredFields: (keyof Template)[] = ['name', 'behavior', 'properties', 'noteContentFormat'];
	const validTypes = ['text', 'multitext', 'number', 'checkbox', 'date', 'datetime'];

	const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';

	const hasRequiredFields = requiredFields.every((field) => Object.hasOwn(template, field));
	const hasValidProperties =
		Array.isArray(template.properties) &&
		template.properties?.every(
			// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
			(prop: any) =>
				Object.hasOwn(prop, 'name') &&
				Object.hasOwn(prop, 'value') &&
				(!Object.hasOwn(prop, 'type') || validTypes.includes(prop.type)),
		);

	// Check for noteNameFormat and path only if it's not a daily note template
	const hasValidNoteNameAndPath =
		isDailyNote || (Object.hasOwn(template, 'noteNameFormat') && Object.hasOwn(template, 'path'));

	// Add optional check for context
	const hasValidContext = !template.context || typeof template.context === 'string';

	return hasRequiredFields && hasValidProperties && hasValidNoteNameAndPath && hasValidContext;
}

function _preventDefaults(e: Event): void {
	e.preventDefault();
	e.stopPropagation();
}

function _handleDrop(e: DragEvent): void {
	const dt = e.dataTransfer;
	const files = dt?.files;

	if (files?.length) {
		handleFiles(files);
	}
}

function handleFiles(files: FileList): void {
	Array.from(files).forEach(importTemplateFile);
}

async function processImportedTemplate(importedTemplate: Partial<Template>): Promise<Template> {
	debugLog('ImportExport', 'Processing imported template:', importedTemplate);

	if (!validateImportedTemplate(importedTemplate)) {
		throw new Error('Invalid template file');
	}

	importedTemplate.id = Date.now().toString() + Math.random().toString(36).slice(2, 9);

	// Process property types
	if (importedTemplate.properties) {
		debugLog('ImportExport', 'Processing properties:', importedTemplate.properties);
		for (const prop of importedTemplate.properties) {
			debugLog(
				'ImportExport',
				`Processing property: ${prop.name}, type: ${prop.type || 'text'}, value: ${prop.value}`,
			);
			const existingPropertyType = generalSettings.propertyTypes.find((pt) => pt.name === prop.name);
			if (!existingPropertyType) {
				// Only add the property type if it doesn't exist
				await addPropertyType(prop.name, prop.type || 'text', prop.value || '');
			} else {
				debugLog(
					'ImportExport',
					`Property type ${prop.name} already exists, keeping existing type: ${existingPropertyType.type}`,
				);
			}
		}

		// Reassign properties with existing or new types
		importedTemplate.properties = importedTemplate.properties.map((prop) => {
			const existingPropertyType = generalSettings.propertyTypes.find((pt) => pt.name === prop.name);
			return {
				id: prop.id || Date.now().toString() + Math.random().toString(36).slice(2, 9),
				name: prop.name,
				value: prop.value,
				type: existingPropertyType ? existingPropertyType.type : prop.type || 'text',
			};
		});
	}

	debugLog('ImportExport', 'Processed template properties:', importedTemplate.properties);

	// Ensure unique name
	let newName = importedTemplate.name as string;
	let counter = 1;
	while (templates.some((t) => t.name === newName)) {
		newName = `${importedTemplate.name} (${counter++})`;
	}
	importedTemplate.name = newName;

	debugLog('ImportExport', 'Final imported template:', importedTemplate);
	return importedTemplate as Template;
}

export function importTemplateFile(file: File): void {
	const reader = new FileReader();
	reader.onload = async (e: ProgressEvent<FileReader>) => {
		try {
			debugLog('ImportExport', 'Starting template import');
			const raw: unknown = JSON.parse(e.target?.result as string);
			if (!isPlainObject(raw)) {
				throw new Error('Invalid template file: expected a JSON object');
			}
			const importedTemplate = raw as Partial<Template>;
			const processedTemplate = await processImportedTemplate(importedTemplate);

			templates.unshift(processedTemplate);
			await saveTemplateSettings();
			updateTemplateList();
			showTemplateEditor(processedTemplate);
			debugLog('ImportExport', 'Template import completed');
		} catch (error) {
			console.error('Error parsing imported template:', error);
			alert(getMessage('failedToImportTemplate'));
		}
	};
	reader.readAsText(file);
}

export function showTemplateImportModal(): void {
	showImportModal('import-modal', importTemplateFromJson, '.json', true, 'importTemplate');
}

async function importTemplateFromJson(jsonContent: string): Promise<void> {
	try {
		const raw: unknown = JSON.parse(jsonContent);
		if (!isPlainObject(raw)) {
			throw new Error('Invalid template data: expected a JSON object');
		}
		const importedTemplate = raw as Partial<Template>;
		const processedTemplate = await processImportedTemplate(importedTemplate);

		templates.unshift(processedTemplate);
		await saveTemplateSettings();
		updateTemplateList();
		showTemplateEditor(processedTemplate);
	} catch (error) {
		console.error('Error parsing imported template:', error);
		throw new Error('Error importing template. Please check the file and try again.', { cause: error });
	}
}

export function copyTemplateToClipboard(template: Template): void {
	const isDailyNote = template.behavior === 'append-daily' || template.behavior === 'prepend-daily';

	const orderedTemplate: Partial<Template> & { schemaVersion: string } = {
		schemaVersion: SCHEMA_VERSION,
		name: template.name,
		behavior: template.behavior,
		noteContentFormat: template.noteContentFormat,
		properties: template.properties.map(({ name, value, type }) => ({
			name,
			value,
			type: type || generalSettings.propertyTypes.find((pt) => pt.name === name)?.type || 'text',
		})),
		triggers: template.triggers,
	};

	// Only include noteNameFormat and path for non-daily note behaviors
	if (!isDailyNote) {
		orderedTemplate.noteNameFormat = template.noteNameFormat;
		orderedTemplate.path = template.path;
	}

	// Include context only if it has a value
	if (template.context) {
		orderedTemplate.context = template.context;
	}

	const jsonContent = JSON.stringify(orderedTemplate, null, 2);

	copyToClipboardWithFeedback(jsonContent, getMessage('templateCopied'), getMessage('templateCopyError')).then(
		(success) => {
			if (success) {
				alert(getMessage('templateCopied'));
			} else {
				alert(getMessage('templateCopyError'));
			}
		},
	);
}

export async function exportAllSettings(): Promise<void> {
	debugLog('ImportExport', 'Starting exportAllSettings function');
	try {
		debugLog('ImportExport', 'Fetching all data from browser storage');
		const allData = (await browser.storage.sync.get(null)) as StorageData;
		debugLog('ImportExport', 'All data fetched:', allData);

		// Create a copy of the data to modify, excluding connection settings (machine-specific secret)
		// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
		const { logseq_settings, ...exportData } = allData as StorageData & { logseq_settings?: any };

		// Decompress all templates
		const templateIds = exportData.template_list || [];
		for (const id of templateIds) {
			const key = `template_${id}`;
			if (exportData[key] && Array.isArray(exportData[key])) {
				try {
					// Join chunks and decompress
					const compressedData = (exportData[key] as string[]).join('');
					const decompressedData = decompressFromUTF16(compressedData);
					const parsed: unknown = JSON.parse(decompressedData);
					exportData[key] = parsed;
				} catch (error) {
					console.error(`Failed to decompress template ${id}:`, error);
				}
			}
		}

		// Strip API keys from providers to prevent credential leakage
		// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
		if ((exportData as any).interpreter_settings?.providers) {
			// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
			(exportData as any).interpreter_settings.providers =
				// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
				(exportData as any).interpreter_settings.providers.map(
					// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
					({ apiKey, ...rest }: any) => rest,
				);
		}

		debugLog('ImportExport', 'Data prepared for export:', exportData);
		const content = JSON.stringify(exportData, null, 2);
		debugLog('ImportExport', 'Data stringified, length:', content.length);

		const fileName = 'logseq-web-clipper-settings.json';

		await saveFile({
			content,
			fileName,
			mimeType: 'application/json',
			onError: (error) => console.error('Failed to export settings:', error),
		});

		debugLog('ImportExport', 'Export completed successfully');
	} catch (error) {
		console.error('Error in exportAllSettings:', error);
		alert(getMessage('failedToExportSettings'));
	}
}

export function importAllSettings(): void {
	showImportModal('import-modal', importAllSettingsFromJson, '.json', false, 'importAllSettings');
}

async function importAllSettingsFromJson(jsonContent: string): Promise<void> {
	try {
		const raw: unknown = JSON.parse(jsonContent);
		if (!isPlainObject(raw)) {
			throw new Error('Invalid settings data: expected a JSON object');
		}
		const settings = raw as StorageData;

		if (confirm(getMessage('confirmReplaceSettings'))) {
			// Create a copy of the settings to modify
			const importData: StorageData = { ...settings };

			// Compress all templates
			const templateIds = importData.template_list || [];
			for (const id of templateIds) {
				const key = `template_${id}`;
				if (importData[key]) {
					try {
						// Check if the data is already compressed (will be an array of strings)
						const isAlreadyCompressed =
							Array.isArray(importData[key]) &&
							// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
							importData[key].every((chunk: any) => typeof chunk === 'string');

						if (!isAlreadyCompressed) {
							// Compress the template data
							const templateStr = JSON.stringify(importData[key]);
							const compressedData = compressToUTF16(templateStr);

							// Split into chunks
							const chunks: string[] = [];
							const CHUNK_SIZE = 8000;
							for (let i = 0; i < compressedData.length; i += CHUNK_SIZE) {
								chunks.push(compressedData.slice(i, i + CHUNK_SIZE));
							}
							importData[key] = chunks;
						}
					} catch (error) {
						console.error(`Failed to process template ${id}:`, error);
					}
				}
			}

			// Preserve connection settings (machine-specific, contains API token)
			const currentStorage = await browser.storage.sync.get('logseq_settings');
			const preservedLogseqSettings = currentStorage.logseq_settings;

			// Remove logseq_settings from import data if present (don't import secrets)
			// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
			delete (importData as any).logseq_settings;

			await browser.storage.sync.clear();
			await browser.storage.sync.set(importData);

			// Restore connection settings
			if (preservedLogseqSettings) {
				await browser.storage.sync.set({ logseq_settings: preservedLogseqSettings });
			}
			await loadSettings();
			await loadTemplates();
			updateTemplateList();
			updatePropertyTypesList();
			alert(getMessage('settingsImportSuccess'));
		}
	} catch (error) {
		console.error('Error importing all settings:', error);
		throw new Error('Error importing settings. Please check the file and try again.', { cause: error });
	}
}
