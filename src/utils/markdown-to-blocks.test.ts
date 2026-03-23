import { describe, test, expect } from 'vitest';
import { markdownToBlocks } from './markdown-to-blocks';

describe('markdownToBlocks', () => {
	// 1. Empty input
	test('empty input returns empty array', () => {
		expect(markdownToBlocks('')).toEqual([]);
		expect(markdownToBlocks('   ')).toEqual([]);
		expect(markdownToBlocks('\n\n')).toEqual([]);
	});

	// 2. Single paragraph
	test('single paragraph becomes one block', () => {
		expect(markdownToBlocks('Hello world')).toEqual([
			{ content: 'Hello world' },
		]);
	});

	// 3. Multiple paragraphs separated by blank lines
	test('multiple paragraphs become multiple blocks', () => {
		const md = 'First paragraph\n\nSecond paragraph\n\nThird paragraph';
		expect(markdownToBlocks(md)).toEqual([
			{ content: 'First paragraph' },
			{ content: 'Second paragraph' },
			{ content: 'Third paragraph' },
		]);
	});

	// 4. Heading hierarchy
	test('heading hierarchy nests content correctly', () => {
		const md = [
			'# Title',
			'intro paragraph',
			'## Section A',
			'content A',
			'## Section B',
			'content B',
		].join('\n');

		expect(markdownToBlocks(md)).toEqual([
			{
				content: '# Title',
				children: [
					{ content: 'intro paragraph' },
					{
						content: '## Section A',
						children: [{ content: 'content A' }],
					},
					{
						content: '## Section B',
						children: [{ content: 'content B' }],
					},
				],
			},
		]);
	});

	// 5. Fenced code block
	test('fenced code block becomes a single block', () => {
		const md = '```python\ndef hello():\n    print("world")\n```';
		expect(markdownToBlocks(md)).toEqual([
			{ content: '```python\ndef hello():\n    print("world")\n```' },
		]);
	});

	// 6. Table as single block
	test('table becomes a single block', () => {
		const md = '| Name | Age |\n|------|-----|\n| Alice | 30 |';
		expect(markdownToBlocks(md)).toEqual([
			{ content: '| Name | Age |\n|------|-----|\n| Alice | 30 |' },
		]);
	});

	// 7. Unordered list with nesting
	test('unordered list with nesting', () => {
		const md = '- Item 1\n  - Sub item 1a\n  - Sub item 1b\n- Item 2';
		expect(markdownToBlocks(md)).toEqual([
			{
				content: 'Item 1',
				children: [
					{ content: 'Sub item 1a' },
					{ content: 'Sub item 1b' },
				],
			},
			{ content: 'Item 2' },
		]);
	});

	// 8. Ordered list
	test('ordered list with nesting', () => {
		const md = '1. First\n2. Second\n   1. Sub-second';
		expect(markdownToBlocks(md)).toEqual([
			{ content: 'First' },
			{
				content: 'Second',
				children: [{ content: 'Sub-second' }],
			},
		]);
	});

	// 9. Blockquote
	test('blockquote spanning multiple lines becomes single block', () => {
		const md = '> This is a quote\n> spanning multiple lines';
		expect(markdownToBlocks(md)).toEqual([
			{ content: '> This is a quote\n> spanning multiple lines' },
		]);
	});

	// 10. Mixed content under a heading
	test('mixed content under heading', () => {
		const md = [
			'# Guide',
			'Some intro text.',
			'',
			'```js',
			'console.log("hi");',
			'```',
			'',
			'- step one',
			'- step two',
		].join('\n');

		expect(markdownToBlocks(md)).toEqual([
			{
				content: '# Guide',
				children: [
					{ content: 'Some intro text.' },
					{ content: '```js\nconsole.log("hi");\n```' },
					{ content: 'step one' },
					{ content: 'step two' },
				],
			},
		]);
	});

	// 11. Content before any heading
	test('content before any heading becomes top-level blocks', () => {
		const md = 'Preamble text\n\n# First heading\nBody';
		expect(markdownToBlocks(md)).toEqual([
			{ content: 'Preamble text' },
			{
				content: '# First heading',
				children: [{ content: 'Body' }],
			},
		]);
	});

	// 12. Heading with no content beneath it
	test('heading with no content has no children', () => {
		const md = '# Empty heading';
		expect(markdownToBlocks(md)).toEqual([
			{ content: '# Empty heading' },
		]);
	});

	// Extra: consecutive blank lines don't produce empty blocks
	test('consecutive blank lines are ignored', () => {
		const md = 'First\n\n\n\nSecond';
		expect(markdownToBlocks(md)).toEqual([
			{ content: 'First' },
			{ content: 'Second' },
		]);
	});

	// Extra: deeper heading nesting (h1 > h2 > h3)
	test('three-level heading nesting', () => {
		const md = [
			'# H1',
			'## H2',
			'### H3',
			'deep content',
		].join('\n');

		expect(markdownToBlocks(md)).toEqual([
			{
				content: '# H1',
				children: [
					{
						content: '## H2',
						children: [
							{
								content: '### H3',
								children: [{ content: 'deep content' }],
							},
						],
					},
				],
			},
		]);
	});

	// Extra: asterisk-style unordered lists
	test('asterisk unordered list items', () => {
		const md = '* Alpha\n* Beta';
		expect(markdownToBlocks(md)).toEqual([
			{ content: 'Alpha' },
			{ content: 'Beta' },
		]);
	});

	// Extra: sibling headings at same level
	test('sibling headings at same level are peers', () => {
		const md = '## A\ncontent A\n## B\ncontent B';
		expect(markdownToBlocks(md)).toEqual([
			{
				content: '## A',
				children: [{ content: 'content A' }],
			},
			{
				content: '## B',
				children: [{ content: 'content B' }],
			},
		]);
	});
});
