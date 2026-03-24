import { describe, expect, test } from 'vitest';
import { table } from './table';

describe('table filter', () => {
	test('converts array of objects to markdown table', () => {
		const result = table('[{"name":"Alice","age":30},{"name":"Bob","age":25}]');
		expect(result).toContain('| name | age |');
		expect(result).toContain('| Alice | 30 |');
		expect(result).toContain('| Bob | 25 |');
	});

	test('creates table with separator row', () => {
		const result = table('[{"a":1}]');
		// Separator row uses "| - |" format
		expect(result).toContain('| - |');
	});

	test('handles simple array', () => {
		const result = table('["a","b","c"]');
		expect(result).toContain('| Value |');
	});

	test('handles custom column headers', () => {
		const result = table('["a","b","c","d"]', '("Col1", "Col2")');
		expect(result).toContain('| Col1 | Col2 |');
	});

	test('handles empty array', () => {
		// Empty array creates a default single-column table with no rows
		const result = table('[]');
		expect(result).toContain('| Value |');
	});

	test('returns original for non-JSON', () => {
		expect(table('plain text')).toBe('plain text');
	});

	test('returns original for malformed table HTML passed as string', () => {
		const malformed = '<table><tr><td>no closing';
		expect(table(malformed)).toBe(malformed);
	});

	test('handles null/undefined string values', () => {
		expect(table('null')).toBe('null');
		expect(table('undefined')).toBe('undefined');
	});

	test('handles JSON object with empty values', () => {
		const result = table('{"a":"","b":""}');
		// Object renders as key-value rows
		expect(result).toContain('| a |');
		expect(result).toContain('| b |');
	});
});
