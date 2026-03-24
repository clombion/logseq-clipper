import { describe, expect, test } from 'vitest';
import { unescapeString } from './unescape';

describe('unescape filter', () => {
	test('unescapes escaped quotes', () => {
		expect(unescapeString('\\"hello\\"')).toBe('"hello"');
	});

	test('unescapes escaped newlines', () => {
		expect(unescapeString('line1\\nline2')).toBe('line1\nline2');
	});

	test('handles no escapes', () => {
		expect(unescapeString('plain text')).toBe('plain text');
	});

	test('handles empty string', () => {
		expect(unescapeString('')).toBe('');
	});

	test('handles multiple escapes', () => {
		expect(unescapeString('\\"one\\"\\n\\"two\\"')).toBe('"one"\n"two"');
	});
});
