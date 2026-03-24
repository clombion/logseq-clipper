import type { IBatchBlock } from './logseq-api';

/**
 * Segment types produced by the parser.
 */
type Segment =
	| { type: 'heading'; level: number; raw: string }
	| { type: 'paragraph'; raw: string }
	| { type: 'code'; raw: string }
	| { type: 'table'; raw: string }
	| { type: 'list'; items: ListItem[] }
	| { type: 'blockquote'; raw: string };

interface ListItem {
	content: string;
	children: ListItem[];
}

/**
 * Convert a markdown string into Logseq's IBatchBlock[] structure.
 *
 * Headings create hierarchy; content beneath a heading becomes its children.
 * Code blocks and tables are kept as single blocks.
 * Lists preserve nesting via children.
 */
export function markdownToBlocks(markdown: string): IBatchBlock[] {
	if (!markdown || !markdown.trim()) return [];

	const segments = parseSegments(markdown);
	return buildHierarchy(segments);
}

// ---------------------------------------------------------------------------
// Parsing: markdown string → flat Segment[]
// ---------------------------------------------------------------------------

function parseSegments(markdown: string): Segment[] {
	const lines = markdown.split('\n');
	const segments: Segment[] = [];
	let i = 0;

	while (i < lines.length) {
		const line = lines[i]!;

		// Blank line — skip
		if (line.trim() === '') {
			i++;
			continue;
		}

		// Fenced code block
		if (/^(`{3,}|~{3,})/.test(line)) {
			const fence = line.match(/^(`{3,}|~{3,})/)?.[1] ?? '```';
			const codeLines: string[] = [line];
			i++;
			while (i < lines.length) {
				codeLines.push(lines[i]!);
				if (lines[i]?.trimEnd() === fence) {
					i++;
					break;
				}
				i++;
			}
			segments.push({ type: 'code', raw: codeLines.join('\n') });
			continue;
		}

		// Heading
		if (/^#{1,6}\s/.test(line)) {
			const level = line.match(/^(#{1,6})\s/)?.[1]?.length ?? 1;
			segments.push({ type: 'heading', level, raw: line });
			i++;
			continue;
		}

		// Table (line contains | and the next line is a separator row)
		if (isTableStart(lines, i)) {
			const tableLines: string[] = [];
			while (i < lines.length && lines[i]?.trim() !== '' && lines[i]?.includes('|')) {
				tableLines.push(lines[i]!);
				i++;
			}
			segments.push({ type: 'table', raw: tableLines.join('\n') });
			continue;
		}

		// Blockquote
		if (/^>\s?/.test(line)) {
			const quoteLines: string[] = [];
			while (i < lines.length && /^>\s?/.test(lines[i]!)) {
				quoteLines.push(lines[i]!);
				i++;
			}
			segments.push({ type: 'blockquote', raw: quoteLines.join('\n') });
			continue;
		}

		// Unordered or ordered list
		if (isListItem(line)) {
			const listLines: string[] = [];
			while (
				i < lines.length &&
				lines[i]?.trim() !== '' &&
				(isListItem(lines[i]!) || isIndentedLine(lines[i]!))
			) {
				listLines.push(lines[i]!);
				i++;
			}
			segments.push({ type: 'list', items: parseListItems(listLines) });
			continue;
		}

		// Paragraph — accumulate consecutive non-blank, non-special lines
		const paraLines: string[] = [];
		while (
			i < lines.length &&
			lines[i]?.trim() !== '' &&
			!/^#{1,6}\s/.test(lines[i]!) &&
			!/^(`{3,}|~{3,})/.test(lines[i]!) &&
			!/^>\s?/.test(lines[i]!) &&
			!isListItem(lines[i]!) &&
			!isTableStart(lines, i)
		) {
			paraLines.push(lines[i]!);
			i++;
		}
		if (paraLines.length > 0) {
			segments.push({ type: 'paragraph', raw: paraLines.join('\n') });
		}
	}

	return segments;
}

function isListItem(line: string): boolean {
	return /^(\s*)([-*]\s|\d+\.\s)/.test(line);
}

function isIndentedLine(line: string): boolean {
	// A line that's indented (continuation of a list context) but not itself a list marker
	return /^\s+/.test(line) && !isListItem(line);
}

function isTableStart(lines: string[], i: number): boolean {
	if (!lines[i]?.includes('|')) return false;
	// Check if next non-empty line is a separator row like |---|---|
	if (i + 1 < lines.length && /^\|?\s*[-:]+[-|\s:]*$/.test(lines[i + 1]!)) {
		return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// List parsing: lines → nested ListItem[]
// ---------------------------------------------------------------------------

function parseListItems(lines: string[]): ListItem[] {
	const root: ListItem[] = [];
	const stack: { indent: number; item: ListItem; children: ListItem[] }[] = [];

	for (const line of lines) {
		const match = line.match(/^(\s*)([-*]\s|\d+\.\s)(.*)/);
		if (!match) continue; // skip continuation lines for simplicity

		const indent = match[1]?.length ?? 0;
		const content = match[3]!;

		const item: ListItem = { content, children: [] };

		// Pop stack until we find a parent with strictly less indent
		while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) {
			stack.pop();
		}

		if (stack.length === 0) {
			root.push(item);
		} else {
			stack[stack.length - 1]?.item.children.push(item);
		}

		stack.push({ indent: indent ?? 0, item, children: item.children });
	}

	return root;
}

// ---------------------------------------------------------------------------
// Hierarchy building: Segment[] → IBatchBlock[]
// ---------------------------------------------------------------------------

function buildHierarchy(segments: Segment[]): IBatchBlock[] {
	const result: IBatchBlock[] = [];

	// Stack tracks the current heading context at each level.
	// stack[0] = h1 block, stack[1] = h2 block under that h1, etc.
	const headingStack: { level: number; block: IBatchBlock }[] = [];

	function addToCurrentContext(block: IBatchBlock): void {
		if (headingStack.length === 0) {
			result.push(block);
		} else {
			const parentEntry = headingStack[headingStack.length - 1];
			if (parentEntry) {
				if (!parentEntry.block.children) parentEntry.block.children = [];
				parentEntry.block.children.push(block);
			}
		}
	}

	for (const seg of segments) {
		if (seg.type === 'heading') {
			const block: IBatchBlock = { content: seg.raw };

			// Pop headings from stack that are same level or deeper
			while (headingStack.length > 0 && (headingStack[headingStack.length - 1]?.level ?? 0) >= seg.level) {
				headingStack.pop();
			}

			// Attach this heading to its parent (or root)
			if (headingStack.length === 0) {
				result.push(block);
			} else {
				const parentEntry = headingStack[headingStack.length - 1];
				if (parentEntry) {
					if (!parentEntry.block.children) parentEntry.block.children = [];
					parentEntry.block.children.push(block);
				}
			}

			headingStack.push({ level: seg.level, block });
		} else {
			const blocks = segmentToBlocks(seg);
			for (const b of blocks) {
				addToCurrentContext(b);
			}
		}
	}

	return result;
}

function segmentToBlocks(seg: Segment): IBatchBlock[] {
	switch (seg.type) {
		case 'paragraph':
			return [{ content: seg.raw }];
		case 'code':
			return [{ content: seg.raw }];
		case 'table':
			return [{ content: seg.raw }];
		case 'blockquote':
			return [{ content: seg.raw }];
		case 'list':
			return seg.items.map(listItemToBlock);
		default:
			return [];
	}
}

function listItemToBlock(item: ListItem): IBatchBlock {
	const block: IBatchBlock = { content: item.content };
	if (item.children.length > 0) {
		block.children = item.children.map(listItemToBlock);
	}
	return block;
}
