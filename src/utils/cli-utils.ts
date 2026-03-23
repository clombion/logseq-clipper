import { execFile } from 'child_process';
import { promisify } from 'util';
import { sanitizeFileName } from './string-utils';
import { Template } from '../types/types';

const execFileAsync = promisify(execFile);

// TODO: CLI is not yet adapted for Logseq. These functions still reference
// the Obsidian CLI and URI scheme. They compile but are not functional.
// Logseq integration uses the HTTP API via logseq-api.ts in the browser extension.

/**
 * Check if the `obsidian` CLI is available on PATH.
 */
async function hasObsidianCli(): Promise<boolean> {
	try {
		await execFileAsync('obsidian', ['version']);
		return true;
	} catch {
		return false;
	}
}

/**
 * Create/append/prepend a note via the Obsidian CLI.
 */
async function openViaObsidianCli(
	fileContent: string,
	noteName: string,
	path: string,
	behavior: Template['behavior'],
	silent: boolean,
): Promise<string> {
	const isDailyNote = behavior === 'append-daily' || behavior === 'prepend-daily';

	if (isDailyNote) {
		const command = behavior === 'append-daily' ? 'daily:append' : 'daily:prepend';
		const { stdout } = await execFileAsync('obsidian', [command, `content=${fileContent}`]);
		return stdout.trim();
	}

	const normalizedPath = path && !path.endsWith('/') ? path + '/' : path;
	const formattedNoteName = sanitizeFileName(noteName);
	const filePath = normalizedPath + formattedNoteName + '.md';

	if (behavior === 'append-specific' || behavior === 'prepend-specific') {
		const command = behavior === 'append-specific' ? 'append' : 'prepend';
		const { stdout } = await execFileAsync('obsidian', [command, `path=${filePath}`, `content=${fileContent}`]);
		return stdout.trim();
	}

	// create
	const args = ['create', `path=${filePath}`, `content=${fileContent}`, 'open'];

	const { stdout } = await execFileAsync('obsidian', args);
	return stdout.trim();
}

/**
 * Open a note in Obsidian via URI scheme (fallback / legacy mode).
 */
async function openViaUri(
	fileContent: string,
	noteName: string,
	path: string,
	behavior: Template['behavior'],
	silent: boolean,
): Promise<void> {
	const isDailyNote = behavior === 'append-daily' || behavior === 'prepend-daily';

	let obsidianUrl: string;
	if (isDailyNote) {
		obsidianUrl = `obsidian://daily?`;
	} else {
		const normalizedPath = path && !path.endsWith('/') ? path + '/' : path;
		const formattedNoteName = sanitizeFileName(noteName);
		obsidianUrl = `obsidian://new?file=${encodeURIComponent(normalizedPath + formattedNoteName)}`;
	}

	if (behavior.startsWith('append')) {
		obsidianUrl += '&append=true';
	} else if (behavior.startsWith('prepend')) {
		obsidianUrl += '&prepend=true';
	}

	if (silent) {
		obsidianUrl += '&silent=true';
	}

	obsidianUrl += `&content=${encodeURIComponent(fileContent)}`;

	const platform = process.platform;
	if (platform === 'darwin') {
		await execFileAsync('open', [obsidianUrl]);
	} else if (platform === 'win32') {
		await execFileAsync('powershell', ['-Command', 'Start-Process', '-Uri', obsidianUrl]);
	} else {
		await execFileAsync('xdg-open', [obsidianUrl]);
	}
}

/**
 * Send a note to Obsidian. Uses the Obsidian CLI by default,
 * falls back to URI scheme if --uri is set or CLI is not available.
 */
export async function openInObsidian(
	fileContent: string,
	noteName: string,
	path: string,
	behavior: Template['behavior'],
	silent: boolean,
	forceUri: boolean,
): Promise<string> {
	if (!forceUri && (await hasObsidianCli())) {
		const result = await openViaObsidianCli(fileContent, noteName, path, behavior, silent);
		return result;
	}

	await openViaUri(fileContent, noteName, path, behavior, silent);
	return 'Opened in Logseq';
}
