import { debugLog } from './debug';

export interface LogseqApiConfig {
	port: number;
	token: string;
}

export interface IBatchBlock {
	content: string;
	children?: IBatchBlock[];
	properties?: Record<string, string>;
}

export interface LogseqPage {
	name: string;
	uuid: string;
	originalName?: string;
	properties?: Record<string, any>;
}

export interface LogseqBlock {
	uuid: string;
	content: string;
	children?: LogseqBlock[];
	properties?: Record<string, any>;
}

export class LogseqConnectionError extends Error {
	cause: Error;
	constructor(cause: Error) {
		super(`Failed to connect to Logseq: ${cause.message}`);
		this.name = 'LogseqConnectionError';
		this.cause = cause;
	}
}

export class LogseqAuthError extends Error {
	constructor() {
		super('Logseq API authentication failed (401)');
		this.name = 'LogseqAuthError';
	}
}

export class LogseqApiError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'LogseqApiError';
		this.status = status;
	}
}

async function logseqApi(config: LogseqApiConfig, method: string, args: any[] = []): Promise<any> {
	debugLog('LogseqAPI', `${method}`, args);
	let response: Response;
	try {
		response = await fetch(`http://127.0.0.1:${config.port}/api`, {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				'Authorization': `Bearer ${config.token}`,
			},
			body: JSON.stringify({ method, args }),
		});
	} catch (err) {
		throw new LogseqConnectionError(err as Error);
	}

	if (response.status === 401) {
		throw new LogseqAuthError();
	}

	if (!response.ok) {
		const text = await response.text();
		throw new LogseqApiError(response.status, text);
	}

	const result = await response.json();
	debugLog('LogseqAPI', `${method} →`, typeof result === 'object' ? Object.keys(result || {}) : result);

	// HACK: Logseq server sends promise rejections as 200 with serialized Error objects.
	// Discriminate by checking for 'stack' property (string type) — normal API responses
	// never have stack traces. If Logseq changes error serialization, this may need updating.
	if (result && typeof result === 'object' && typeof result.stack === 'string') {
		throw new LogseqApiError(200, result.message || 'Unknown Logseq API error');
	}

	return result;
}

export async function checkConnection(config: LogseqApiConfig): Promise<boolean> {
	try {
		await logseqApi(config, 'logseq.App.getCurrentGraph');
		return true;
	} catch {
		return false;
	}
}

export async function createPage(
	config: LogseqApiConfig,
	title: string,
	properties?: Record<string, any>,
	opts: { redirect?: boolean } = {},
): Promise<LogseqPage> {
	const mergedOpts = { redirect: false, ...opts };
	return await logseqApi(config, 'logseq.Editor.createPage', [title, properties ?? {}, mergedOpts]);
}

export async function getPage(config: LogseqApiConfig, title: string): Promise<LogseqPage | null> {
	const result = await logseqApi(config, 'logseq.Editor.getPage', [title]);
	return result ?? null;
}

export async function appendBlockInPage(
	config: LogseqApiConfig,
	page: string,
	content: string,
	opts?: Record<string, any>,
): Promise<LogseqBlock> {
	const args: any[] = [page, content];
	if (opts) args.push(opts);
	return await logseqApi(config, 'logseq.Editor.appendBlockInPage', args);
}

export async function prependBlockInPage(
	config: LogseqApiConfig,
	page: string,
	content: string,
	opts?: Record<string, any>,
): Promise<LogseqBlock> {
	const args: any[] = [page, content];
	if (opts) args.push(opts);
	return await logseqApi(config, 'logseq.Editor.prependBlockInPage', args);
}

export async function insertBatchBlock(
	config: LogseqApiConfig,
	blockUuid: string,
	blocks: IBatchBlock[],
	opts: { sibling?: boolean } = {},
): Promise<LogseqBlock[]> {
	const mergedOpts = { sibling: false, ...opts };
	return await logseqApi(config, 'logseq.Editor.insertBatchBlock', [blockUuid, blocks, mergedOpts]);
}

export async function getPageBlocksTree(config: LogseqApiConfig, pageTitle: string): Promise<LogseqBlock[]> {
	return await logseqApi(config, 'logseq.Editor.getPageBlocksTree', [pageTitle]);
}

export async function queryByProperty(config: LogseqApiConfig, property: string, value: string): Promise<any[]> {
	const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
	const query = `(property ${property} "${escaped}")`;
	return await logseqApi(config, 'logseq.DB.q', [query]);
}

export async function getTodayJournalPageName(config: LogseqApiConfig): Promise<string> {
	const today = new Date();
	const journalDay = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
	const results = await logseqApi(config, 'logseq.DB.datascriptQuery', [
		`[:find (pull ?p [:block/name :block/original-name]) :where [?p :block/journal-day ${journalDay}]]`,
	]);
	if (results && results.length > 0 && results[0].length > 0) {
		const page = results[0][0];
		return page['original-name'] || page.name;
	}
	// Fallback: use Logseq's default format (MMM do, yyyy)
	const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
	const day = today.getDate();
	const suffix = day === 1 || day === 21 || day === 31 ? 'st' : day === 2 || day === 22 ? 'nd' : day === 3 || day === 23 ? 'rd' : 'th';
	return `${months[today.getMonth()]} ${day}${suffix}, ${today.getFullYear()}`;
}

export async function removeBlock(config: LogseqApiConfig, blockUuid: string): Promise<void> {
	await logseqApi(config, 'logseq.Editor.removeBlock', [blockUuid]);
}

// HACK: Assumes upsertBlockProperty works on page entities (page UUIDs),
// not just block UUIDs. Logseq's <get-block resolves both, but this
// hasn't been verified against a running instance. Test manually.
export async function upsertBlockProperty(
	config: LogseqApiConfig,
	blockUuid: string,
	key: string,
	value: any,
): Promise<void> {
	await logseqApi(config, 'logseq.Editor.upsertBlockProperty', [blockUuid, key, value]);
}
