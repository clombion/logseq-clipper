import type { ModelConfig, PromptVariable, Template } from '../types/types';
import { debugLog } from './debug';
import { applyFilters } from './filters';
import { getMessage } from './i18n';
import { generalSettings, saveSettings } from './storage-utils';
import { formatDuration } from './string-utils';
import { compileTemplate } from './template-compiler';
import { updateTokenCount } from './token-counter';
import { adjustNoteNameHeight } from './ui-utils';

const RATE_LIMIT_RESET_TIME = 60000; // 1 minute in milliseconds
let lastRequestTime = 0;

// Store event listeners for cleanup
const eventListeners = new WeakMap<HTMLElement, { [key: string]: EventListener }>();

// Track in-flight interpreter operation so callers can await it directly
let activeInterpreterPromise: Promise<void> | null = null;

export function getActiveInterpreterPromise(): Promise<void> | null {
	return activeInterpreterPromise;
}

export async function sendToLLM(
	promptContext: string,
	_content: string,
	promptVariables: PromptVariable[],
	model: ModelConfig,
	// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
): Promise<{ promptResponses: any[] }> {
	debugLog('Interpreter', 'Sending request to LLM...');

	// Find the provider for this model
	const provider = generalSettings.providers.find((p) => p.id === model.providerId);
	if (!provider) {
		throw new Error(`Provider not found for model ${model.name}`);
	}

	// Only check for API key if the provider requires it
	if (provider.apiKeyRequired && !provider.apiKey) {
		throw new Error(`API key is not set for provider ${provider.name}`);
	}

	const now = Date.now();
	if (now - lastRequestTime < RATE_LIMIT_RESET_TIME) {
		throw new Error(
			`Rate limit cooldown. Please wait ${Math.ceil((RATE_LIMIT_RESET_TIME - (now - lastRequestTime)) / 1000)} seconds before trying again.`,
		);
	}

	try {
		const systemContent = `You are a helpful assistant. Please respond with one JSON object named \`prompts_responses\` — no explanatory text before or after. Use the keys provided, e.g. \`prompt_1\`, \`prompt_2\`, and fill in the values. Values should be Markdown strings unless otherwise specified. Make your responses concise. For example, your response should look like: {"prompts_responses":{"prompt_1":"tag1, tag2, tag3","prompt_2":"- bullet1\n- bullet 2\n- bullet3"}}`;

		const promptContent = {
			prompts: promptVariables.reduce(
				(acc, { key, prompt }) => {
					acc[key] = prompt;
					return acc;
				},
				{} as { [key: string]: string },
			),
		};

		let requestUrl: string;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
		let requestBody: any;
		let headers: HeadersInit = {
			'Content-Type': 'application/json',
		};

		if (provider.name.toLowerCase().includes('hugging')) {
			// Replace {model-id} in baseUrl with the actual model ID
			requestUrl = provider.baseUrl.replace('{model-id}', model.providerModelId);
			requestBody = {
				model: model.providerModelId,
				messages: [
					{ role: 'system', content: systemContent },
					{ role: 'user', content: `${promptContext}` },
					{ role: 'user', content: `${JSON.stringify(promptContent)}` },
				],
				max_tokens: 1600,
				stream: false,
			};
			headers = {
				...headers,
				Authorization: `Bearer ${provider.apiKey}`,
			};
		} else if (provider.baseUrl.includes('openai.azure.com')) {
			requestUrl = provider.baseUrl;
			requestBody = {
				messages: [
					{ role: 'system', content: systemContent },
					{ role: 'user', content: `${promptContext}` },
					{ role: 'user', content: `${JSON.stringify(promptContent)}` },
				],
				max_tokens: 1600,
				stream: false,
			};
			headers = {
				...headers,
				'api-key': provider.apiKey,
			};
		} else if (provider.name.toLowerCase().includes('anthropic')) {
			requestUrl = provider.baseUrl;
			requestBody = {
				model: model.providerModelId,
				max_tokens: 1600,
				messages: [
					{ role: 'user', content: `${promptContext}` },
					{ role: 'user', content: `${JSON.stringify(promptContent)}` },
				],
				temperature: 0.5,
				system: systemContent,
			};
			headers = {
				...headers,
				'x-api-key': provider.apiKey,
				'anthropic-version': '2023-06-01',
				'anthropic-dangerous-direct-browser-access': 'true',
			};
		} else if (provider.name.toLowerCase().includes('perplexity')) {
			requestUrl = provider.baseUrl;
			requestBody = {
				model: model.providerModelId,
				max_tokens: 1600,
				messages: [
					{ role: 'system', content: systemContent },
					{
						role: 'user',
						content: `
						"${promptContext}"
						"${JSON.stringify(promptContent)}"`,
					},
				],
				temperature: 0.3,
			};
			headers = {
				...headers,
				'HTTP-Referer': 'https://logseq.com/',
				'X-Title': 'Logseq Web Clipper',
				Authorization: `Bearer ${provider.apiKey}`,
			};
		} else if (provider.name.toLowerCase().includes('ollama')) {
			requestUrl = provider.baseUrl;
			requestBody = {
				model: model.providerModelId,
				messages: [
					{ role: 'system', content: systemContent },
					{ role: 'user', content: `${promptContext}` },
					{ role: 'user', content: `${JSON.stringify(promptContent)}` },
				],
				format: 'json',
				num_ctx: 120000,
				temperature: 0.5,
				stream: false,
			};
		} else {
			// Default request format
			requestUrl = provider.baseUrl;
			requestBody = {
				model: model.providerModelId,
				messages: [
					{ role: 'system', content: systemContent },
					{ role: 'user', content: `${promptContext}` },
					{ role: 'user', content: `${JSON.stringify(promptContent)}` },
				],
			};
			headers = {
				...headers,
				'HTTP-Referer': 'https://logseq.com/',
				'X-Title': 'Logseq Web Clipper',
				Authorization: `Bearer ${provider.apiKey}`,
			};
		}

		debugLog('Interpreter', `Sending request to ${provider.name} API:`, requestBody);

		const response = await fetch(requestUrl, {
			method: 'POST',
			headers: headers,
			body: JSON.stringify(requestBody),
			signal: AbortSignal.timeout(60_000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			console.error(`${provider.name} error response:`, errorText);

			// Add specific message for Ollama 403 errors
			if (provider.name.toLowerCase().includes('ollama') && response.status === 403) {
				throw new Error(
					`Ollama cannot process requests originating from a browser extension without setting OLLAMA_ORIGINS. ` +
						`See Ollama documentation for OLLAMA_ORIGINS configuration`,
				);
			}

			throw new Error(`${provider.name} error: ${response.statusText} ${errorText}`);
		}

		const responseText = await response.text();
		debugLog('Interpreter', `Raw ${provider.name} response:`, responseText);

		// biome-ignore lint/suspicious/noExplicitAny: dynamic API response parsing
		let data: Record<string, any>;
		try {
			const raw: unknown = JSON.parse(responseText);
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
				throw new Error('Expected JSON object response');
			}
			// biome-ignore lint/suspicious/noExplicitAny: dynamic API response parsing
			data = raw as Record<string, any>;
		} catch (error) {
			console.error('Error parsing JSON response:', error);
			throw new Error(`Failed to parse response from ${provider.name}`, { cause: error });
		}

		debugLog('Interpreter', `Parsed ${provider.name} response:`, data);

		lastRequestTime = now;

		let llmResponseContent: string;
		if (provider.name.toLowerCase().includes('anthropic')) {
			// Handle Anthropic's nested content structure
			const textContent = data.content?.[0]?.text;
			if (textContent) {
				try {
					// Try to parse the inner content first
					const parsed: unknown = JSON.parse(textContent);
					llmResponseContent = JSON.stringify(parsed);
				} catch {
					// If parsing fails, use the raw text
					llmResponseContent = textContent;
				}
			} else {
				llmResponseContent = JSON.stringify(data);
			}
		} else if (provider.name.toLowerCase().includes('ollama')) {
			const messageContent = data.message?.content;
			if (messageContent) {
				try {
					const parsed: unknown = JSON.parse(messageContent);
					llmResponseContent = JSON.stringify(parsed);
				} catch {
					llmResponseContent = messageContent;
				}
			} else {
				llmResponseContent = JSON.stringify(data);
			}
		} else {
			llmResponseContent = data.choices[0]?.message?.content || JSON.stringify(data);
		}
		debugLog('Interpreter', 'Processed LLM response:', llmResponseContent);

		return parseLLMResponse(llmResponseContent, promptVariables);
	} catch (error) {
		console.error(`Error sending to ${provider.name} LLM:`, error);
		throw error;
	}
}

interface LLMResponse {
	prompts_responses: { [key: string]: string };
}

// --- JSON sanitization for messy LLM output ---

function sanitizeJsonString(str: string): string {
	let result = str.replace(/\r\n/g, '\n');
	result = result.replace(/\n/g, '\\n');
	result = result.replace(/(?<!\\)"/g, '\\"');
	result = result.replace(/(?<=[{[,:]\s*)\\"/g, '"').replace(/\\"(?=\s*[}\],:}])/g, '"');
	return (
		result
			.replace(/[\u201C\u201D]/g, '\\"')
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control character removal
			.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '')
			.replace(/"\s*:/g, '":')
			.replace(/:\s*"/g, ':"')
			.replace(/\\{3,}/g, '\\\\')
	);
}

// --- Parse strategies (tried in order, first success wins) ---

function tryDirectParse(content: string): LLMResponse | null {
	try {
		const sanitized = sanitizeJsonString(content);
		debugLog('Interpreter', 'Trying direct parse');
		const raw: unknown = JSON.parse(sanitized);
		return raw as LLMResponse;
	} catch {
		return null;
	}
}

function tryExtractedMinimalSanitize(content: string): LLMResponse | null {
	const jsonMatch = content.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;
	try {
		const sanitized = jsonMatch[0]
			.replace(/[\u201C\u201D]/g, '"')
			.replace(/\r\n/g, '\\n')
			.replace(/\n/g, '\\n');
		debugLog('Interpreter', 'Trying extracted JSON with minimal sanitization');
		const raw: unknown = JSON.parse(sanitized);
		return raw as LLMResponse;
	} catch {
		return null;
	}
}

function tryExtractedFullSanitize(content: string): LLMResponse | null {
	const jsonMatch = content.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;
	try {
		const sanitized = sanitizeJsonString(jsonMatch[0]);
		debugLog('Interpreter', 'Trying extracted JSON with full sanitization');
		const raw: unknown = JSON.parse(sanitized);
		return raw as LLMResponse;
	} catch {
		return null;
	}
}

function tryRegexRebuild(content: string, promptVariables: PromptVariable[]): LLMResponse | null {
	const jsonMatch = content.match(/\{[\s\S]*\}/);
	if (!jsonMatch) return null;
	try {
		const prompts_responses: { [key: string]: string } = {};
		for (let i = 0; i < promptVariables.length; i++) {
			const promptKey = `prompt_${i + 1}`;
			const promptRegex = new RegExp(`"${promptKey}"\\s*:\\s*"([^]*?)(?:"\\s*,|"\\s*})`, 'g');
			const match = promptRegex.exec(jsonMatch[0]);
			if (match?.[1]) {
				prompts_responses[promptKey] = match[1]
					.replace(/"/g, '\\"')
					.replace(/\r\n/g, '\\n')
					.replace(/\n/g, '\\n');
			}
		}
		debugLog('Interpreter', 'Trying regex key extraction rebuild');
		const rebuilt = JSON.stringify({ prompts_responses });
		const raw: unknown = JSON.parse(rebuilt);
		return raw as LLMResponse;
	} catch {
		return null;
	}
}

// --- Main parse function ---

interface PromptResponse {
	key: string;
	prompt: string;
	user_response: string;
}

function parseLLMResponse(
	responseContent: string,
	promptVariables: PromptVariable[],
): { promptResponses: PromptResponse[] } {
	// Normalize: if already an object, stringify first
	if (typeof responseContent === 'object') {
		responseContent = JSON.stringify(responseContent);
	}

	// Try parse strategies in order of preference
	const strategies = [
		() => tryDirectParse(responseContent),
		() => tryExtractedMinimalSanitize(responseContent),
		() => tryExtractedFullSanitize(responseContent),
		() => tryRegexRebuild(responseContent, promptVariables),
	];

	let parsedResponse: LLMResponse | null = null;
	for (const strategy of strategies) {
		parsedResponse = strategy();
		if (parsedResponse) break;
	}

	if (!parsedResponse?.prompts_responses) {
		debugLog('Interpreter', 'All parse strategies failed for LLM response');
		return { promptResponses: [] };
	}

	// Convert escaped newlines to actual newlines
	for (const key of Object.keys(parsedResponse.prompts_responses)) {
		const value = parsedResponse.prompts_responses[key];
		if (typeof value === 'string') {
			parsedResponse.prompts_responses[key] = value.replace(/\\n/g, '\n').replace(/\r/g, '');
		}
	}

	// Map responses to prompt variables
	const promptResponses = promptVariables.map((variable) => ({
		key: variable.key,
		prompt: variable.prompt,
		user_response: parsedResponse.prompts_responses[variable.key] || '',
	}));

	debugLog('Interpreter', 'Successfully mapped prompt responses:', promptResponses);
	return { promptResponses };
}

export function collectPromptVariables(template: Template | null): PromptVariable[] {
	const promptMap = new Map<string, PromptVariable>();
	const promptRegex = /{{(?:prompt:)?"([\s\S]*?)"(\|.*?)?}}/g;
	let match: RegExpExecArray | null;

	function addPrompt(prompt: string, filters: string) {
		if (!promptMap.has(prompt)) {
			const key = `prompt_${promptMap.size + 1}`;
			promptMap.set(prompt, { key, prompt, filters });
		}
	}

	if (template?.noteContentFormat) {
		match = promptRegex.exec(template.noteContentFormat);
		while (match !== null) {
			addPrompt(match[1] ?? '', match[2] || '');
			match = promptRegex.exec(template.noteContentFormat);
		}
	}

	if (template?.properties) {
		for (const property of template.properties) {
			const propertyValue = property.value;
			match = promptRegex.exec(propertyValue);
			while (match !== null) {
				addPrompt(match[1] ?? '', match[2] || '');
				match = promptRegex.exec(propertyValue);
			}
		}
	}

	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			const inputValue = input.value;
			match = promptRegex.exec(inputValue);
			while (match !== null) {
				addPrompt(match[1] ?? '', match[2] || '');
				match = promptRegex.exec(inputValue);
			}
		}
	});

	return Array.from(promptMap.values());
}

export async function initializeInterpreter(
	template: Template,
	variables: { [key: string]: string },
	tabId: number,
	currentUrl: string,
) {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn');
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;
	const modelSelect = document.getElementById('model-select') as HTMLSelectElement;

	function removeOldListeners(element: HTMLElement, eventType: string) {
		const listeners = eventListeners.get(element);
		if (listeners?.[eventType]) {
			element.removeEventListener(eventType, listeners[eventType]);
		}
	}

	function storeListener(element: HTMLElement, eventType: string, listener: EventListener) {
		let listeners = eventListeners.get(element);
		if (!listeners) {
			listeners = {};
			eventListeners.set(element, listeners);
		}
		removeOldListeners(element, eventType);
		listeners[eventType] = listener;
		element.addEventListener(eventType, listener);
	}

	const promptVariables = collectPromptVariables(template);

	// Hide interpreter if it's disabled or there are no prompt variables
	if (!generalSettings.interpreterEnabled || promptVariables.length === 0) {
		if (interpreterContainer) interpreterContainer.style.display = 'none';
		if (interpretBtn) interpretBtn.style.display = 'none';
		return;
	}

	if (interpreterContainer) interpreterContainer.style.display = 'flex';
	if (interpretBtn) interpretBtn.style.display = 'inline-block';

	if (promptContextTextarea) {
		const tokenCounter = document.getElementById('token-counter');

		const inputListener = () => {
			template.context = promptContextTextarea.value;
			if (tokenCounter) {
				updateTokenCount(promptContextTextarea.value, tokenCounter);
			}
		};

		storeListener(promptContextTextarea, 'input', inputListener);

		let promptToDisplay =
			template.context ||
			generalSettings.defaultPromptContext ||
			'{{fullHtml|remove_html:("#navbar,.footer,#footer,header,footer,style,script")|strip_tags:("script,h1,h2,h3,h4,h5,h6,meta,a,ol,ul,li,p,em,strong,i,b,s,strike,u,sup,sub,img,video,audio,math,table,cite,td,th,tr,caption")|strip_attr:("alt,src,href,id,content,property,name,datetime,title")}}';
		promptToDisplay = await compileTemplate(tabId, promptToDisplay, variables, currentUrl);
		promptContextTextarea.value = promptToDisplay;

		// Initial token count
		if (tokenCounter) {
			updateTokenCount(promptContextTextarea.value, tokenCounter);
		}
	}

	if (template) {
		// Only add click listener if auto-run is disabled
		if (interpretBtn && !generalSettings.interpreterAutoRun) {
			const clickListener = async () => {
				const selectedModelId = modelSelect.value;
				const modelConfig = generalSettings.models.find((m) => m.id === selectedModelId);
				if (!modelConfig) {
					throw new Error(`Model configuration not found for ${selectedModelId}`);
				}
				await handleInterpreterUI(template, variables, tabId, currentUrl, modelConfig);
			};
			storeListener(interpretBtn, 'click', clickListener);
		}

		if (modelSelect) {
			const changeListener = async () => {
				generalSettings.interpreterModel = modelSelect.value;
				await saveSettings();
			};
			storeListener(modelSelect, 'change', changeListener);

			modelSelect.style.display = 'inline-block';

			// Only repopulate if the skeleton hasn't already done it
			if (modelSelect.options.length === 0) {
				const enabledModels = generalSettings.models.filter((model) => model.enabled);
				modelSelect.textContent = '';
				enabledModels.forEach((model) => {
					const option = document.createElement('option');
					option.value = model.id;
					option.textContent = model.name;
					modelSelect.appendChild(option);
				});
				modelSelect.value = generalSettings.interpreterModel || (enabledModels[0]?.id ?? '');
			}

			// Validate that the selected model is still enabled
			const enabledModels = generalSettings.models.filter((model) => model.enabled);
			const lastSelectedModel = enabledModels.find((model) => model.id === generalSettings.interpreterModel);

			if (!lastSelectedModel && enabledModels.length > 0) {
				generalSettings.interpreterModel = enabledModels[0]?.id ?? '';
				await saveSettings();
				modelSelect.value = generalSettings.interpreterModel;
			}
		}
	}
}

export async function handleInterpreterUI(
	template: Template,
	variables: { [key: string]: string },
	_tabId: number,
	_currentUrl: string,
	modelConfig: ModelConfig,
): Promise<void> {
	// If an interpreter operation is already in flight, await it first
	// to prevent the single-slot promise from being overwritten
	if (activeInterpreterPromise) {
		await activeInterpreterPromise;
	}
	const work = handleInterpreterUIInternal(template, variables, _tabId, _currentUrl, modelConfig);
	activeInterpreterPromise = work;
	try {
		await work;
	} finally {
		activeInterpreterPromise = null;
	}
}

async function handleInterpreterUIInternal(
	template: Template,
	variables: { [key: string]: string },
	_tabId: number,
	_currentUrl: string,
	modelConfig: ModelConfig,
): Promise<void> {
	const interpreterContainer = document.getElementById('interpreter');
	const interpretBtn = document.getElementById('interpret-btn') as HTMLButtonElement;
	const interpreterErrorMessage = document.getElementById('interpreter-error') as HTMLDivElement;
	const responseTimer = document.getElementById('interpreter-timer') as HTMLSpanElement;
	const clipButton = document.getElementById('clip-btn') as HTMLButtonElement;
	const moreButton = document.getElementById('more-btn') as HTMLButtonElement;
	const promptContextTextarea = document.getElementById('prompt-context') as HTMLTextAreaElement;

	try {
		// Hide any previous error message
		interpreterErrorMessage.style.display = 'none';
		interpreterErrorMessage.textContent = '';

		// Remove any previous done or error classes
		interpreterContainer?.classList.remove('done', 'error');

		// Find the provider for this model
		const provider = generalSettings.providers.find((p) => p.id === modelConfig.providerId);
		if (!provider) {
			throw new Error(`Provider not found for model ${modelConfig.name}`);
		}

		// Only check for API key if the provider requires it
		if (provider.apiKeyRequired && !provider.apiKey) {
			throw new Error(`API key is not set for provider ${provider.name}`);
		}

		const promptVariables = collectPromptVariables(template);

		if (promptVariables.length === 0) {
			throw new Error('No prompt variables found. Please add at least one prompt variable to your template.');
		}

		const contextToUse = promptContextTextarea.value;
		const contentToProcess = variables.content || '';

		// Start the timer
		const startTime = performance.now();
		let timerInterval = 0;

		// Change button text and add class
		interpretBtn.textContent = getMessage('thinking');
		interpretBtn.classList.add('processing');

		// Disable the clip button
		clipButton.disabled = true;
		moreButton.disabled = true;

		// Show and update the timer
		responseTimer.style.display = 'inline';
		responseTimer.textContent = '0ms';

		// Update the timer text with elapsed time
		timerInterval = window.setInterval(() => {
			const elapsedTime = performance.now() - startTime;
			responseTimer.textContent = formatDuration(elapsedTime);
		}, 10);

		const { promptResponses } = await sendToLLM(contextToUse, contentToProcess, promptVariables, modelConfig);
		debugLog('Interpreter', 'LLM response:', { promptResponses });

		// Stop the timer and update UI
		clearInterval(timerInterval);
		const endTime = performance.now();
		const totalTime = endTime - startTime;
		responseTimer.textContent = formatDuration(totalTime);

		// Update button state
		interpretBtn.textContent = getMessage('done').toLowerCase();
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add('done');
		interpretBtn.disabled = true;

		// Add done class to container
		interpreterContainer?.classList.add('done');

		// Update fields with responses
		replacePromptVariables(promptVariables, promptResponses);

		// Re-enable clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		// Adjust height for noteNameField after content is replaced
		const noteNameField = document.getElementById('note-name-field') as HTMLTextAreaElement | null;
		if (noteNameField instanceof HTMLTextAreaElement) {
			adjustNoteNameHeight(noteNameField);
		}
	} catch (error) {
		console.error('Error processing LLM:', error);

		// Revert button text and remove class in case of error
		interpretBtn.textContent = getMessage('error');
		interpretBtn.classList.remove('processing');
		interpretBtn.classList.add('error');
		interpretBtn.disabled = true;

		// Add error class to interpreter container
		interpreterContainer?.classList.add('error');

		// Hide the timer
		responseTimer.style.display = 'none';

		// Display the error message
		interpreterErrorMessage.textContent =
			error instanceof Error
				? error.message
				: 'An unknown error occurred while processing the interpreter request.';
		interpreterErrorMessage.style.display = 'block';

		// Re-enable the clip button
		clipButton.disabled = false;
		moreButton.disabled = false;

		if (error instanceof Error) {
			throw new Error(`${error.message}`, { cause: error });
		} else {
			throw new Error('An unknown error occurred while processing the interpreter request.', { cause: error });
		}
	}
}

// Similar to replaceVariables, but happens after the LLM response is received
// biome-ignore lint/suspicious/noExplicitAny: dynamic data processing
export function replacePromptVariables(promptVariables: PromptVariable[], promptResponses: any[]) {
	const allInputs = document.querySelectorAll('input, textarea');
	allInputs.forEach((input) => {
		if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
			input.value = input.value.replace(
				/{{(?:prompt:)?"([\s\S]*?)"(\|[\s\S]*?)?}}/g,
				(match, promptText, filters) => {
					const variable = promptVariables.find((v) => v.prompt === promptText);
					if (!variable) return match;

					const response = promptResponses.find((r) => r.key === variable.key);
					if (response && response.user_response !== undefined) {
						let value = response.user_response;

						// Handle array or object responses
						if (typeof value === 'object') {
							try {
								value = JSON.stringify(value, null, 2);
							} catch (error) {
								console.error('Error stringifying object:', error);
								value = String(value);
							}
						}

						if (filters) {
							value = applyFilters(value, filters.slice(1));
						}

						return value;
					}
					return match; // Return original if no match found
				},
			);

			// Adjust height for noteNameField after updating its value
			if (input.id === 'note-name-field' && input instanceof HTMLTextAreaElement) {
				adjustNoteNameHeight(input);
			}
		}
	});
}
