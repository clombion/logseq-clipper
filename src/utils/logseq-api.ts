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

	return await response.json();
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
	opts: { createFirstBlock?: boolean; redirect?: boolean } = {},
): Promise<LogseqPage> {
	const mergedOpts = { createFirstBlock: true, redirect: false, ...opts };
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

export async function removeBlock(config: LogseqApiConfig, blockUuid: string): Promise<void> {
	await logseqApi(config, 'logseq.Editor.removeBlock', [blockUuid]);
}
