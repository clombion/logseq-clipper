import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
	appendBlockInPage,
	checkConnection,
	createPage,
	getPage,
	insertBatchBlock,
	type LogseqApiConfig,
	LogseqApiError,
	LogseqAuthError,
	LogseqConnectionError,
	queryByProperty,
	removeBlock,
	upsertBlockProperty,
} from './logseq-api';

const config: LogseqApiConfig = { port: 12315, token: 'test-token' };

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function jsonResponse(data: any, status = 200) {
	return Promise.resolve({
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(data),
		text: () => Promise.resolve(JSON.stringify(data)),
	});
}

function errorResponse(status: number, body: string) {
	return Promise.resolve({
		ok: false,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(body),
	});
}

beforeEach(() => {
	mockFetch.mockReset();
});

describe('checkConnection', () => {
	test('returns true on success', async () => {
		mockFetch.mockReturnValue(jsonResponse({ name: 'my-graph' }));
		const result = await checkConnection(config);
		expect(result).toBe(true);
	});

	test('returns false when fetch fails (connection refused)', async () => {
		mockFetch.mockRejectedValue(new TypeError('fetch failed'));
		const result = await checkConnection(config);
		expect(result).toBe(false);
	});

	test('returns false on 401', async () => {
		mockFetch.mockReturnValue(errorResponse(401, 'Unauthorized'));
		const result = await checkConnection(config);
		expect(result).toBe(false);
	});
});

describe('createPage', () => {
	test('sends correct method/args and returns page entity', async () => {
		const page = { name: 'Test Page', uuid: 'abc-123' };
		mockFetch.mockReturnValue(jsonResponse(page));

		const result = await createPage(config, 'Test Page');

		expect(result).toEqual(page);
		expect(mockFetch).toHaveBeenCalledWith(
			'http://127.0.0.1:12315/api',
			expect.objectContaining({
				method: 'POST',
				headers: expect.objectContaining({ Authorization: 'Bearer test-token' }),
				body: JSON.stringify({
					method: 'logseq.Editor.createPage',
					args: ['Test Page', {}, { redirect: false }],
				}),
			}),
		);
	});
});

describe('getPage', () => {
	test('returns null when API returns null', async () => {
		mockFetch.mockReturnValue(jsonResponse(null));
		const result = await getPage(config, 'Nonexistent');
		expect(result).toBeNull();
	});
});

describe('appendBlockInPage', () => {
	test('sends correct method/args', async () => {
		const block = { uuid: 'block-1', content: 'Hello' };
		mockFetch.mockReturnValue(jsonResponse(block));

		const result = await appendBlockInPage(config, 'My Page', 'Hello');

		expect(result).toEqual(block);
		expect(mockFetch).toHaveBeenCalledWith(
			'http://127.0.0.1:12315/api',
			expect.objectContaining({
				body: JSON.stringify({
					method: 'logseq.Editor.appendBlockInPage',
					args: ['My Page', 'Hello'],
				}),
			}),
		);
	});
});

describe('insertBatchBlock', () => {
	test('sends nested block structure correctly', async () => {
		const blocks = [
			{
				content: 'Parent',
				children: [{ content: 'Child' }],
			},
		];
		const resultBlocks = [{ uuid: 'b1', content: 'Parent', children: [{ uuid: 'b2', content: 'Child' }] }];
		mockFetch.mockReturnValue(jsonResponse(resultBlocks));

		const result = await insertBatchBlock(config, 'target-uuid', blocks);

		expect(result).toEqual(resultBlocks);
		expect(mockFetch).toHaveBeenCalledWith(
			'http://127.0.0.1:12315/api',
			expect.objectContaining({
				body: JSON.stringify({
					method: 'logseq.Editor.insertBatchBlock',
					args: ['target-uuid', blocks, { sibling: false }],
				}),
			}),
		);
	});
});

describe('queryByProperty', () => {
	test('constructs correct DSL query string', async () => {
		mockFetch.mockReturnValue(jsonResponse([{ uuid: 'r1' }]));

		const result = await queryByProperty(config, 'url', 'https://example.com');

		expect(result).toEqual([{ uuid: 'r1' }]);
		expect(mockFetch).toHaveBeenCalledWith(
			'http://127.0.0.1:12315/api',
			expect.objectContaining({
				body: JSON.stringify({
					method: 'logseq.DB.q',
					args: ['(property url "https://example.com")'],
				}),
			}),
		);
	});
});

describe('removeBlock', () => {
	test('sends correct method/args', async () => {
		mockFetch.mockReturnValue(jsonResponse(null));

		await removeBlock(config, 'block-uuid');

		expect(mockFetch).toHaveBeenCalledWith(
			'http://127.0.0.1:12315/api',
			expect.objectContaining({
				body: JSON.stringify({
					method: 'logseq.Editor.removeBlock',
					args: ['block-uuid'],
				}),
			}),
		);
	});
});

describe('queryByProperty', () => {
	test('rejects invalid property names', async () => {
		await expect(queryByProperty(config, 'source"; DROP TABLE', 'value')).rejects.toThrow('Invalid property name');
	});

	test('rejects property names starting with number', async () => {
		await expect(queryByProperty(config, '123bad', 'value')).rejects.toThrow('Invalid property name');
	});

	test('accepts valid property names with hyphens and underscores', async () => {
		mockFetch.mockReturnValue(jsonResponse([]));
		await expect(queryByProperty(config, 'destination-page', 'value')).resolves.not.toThrow();

		mockFetch.mockReturnValue(jsonResponse([]));
		await expect(queryByProperty(config, 'content_hash', 'value')).resolves.not.toThrow();
	});
});

describe('timeout', () => {
	test('fetch is called with AbortSignal.timeout', async () => {
		mockFetch.mockReturnValue(jsonResponse({ name: 'graph' }));
		await checkConnection(config);
		expect(mockFetch).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				signal: expect.anything(),
			}),
		);
	});
});

describe('error handling', () => {
	test('401 throws LogseqAuthError', async () => {
		mockFetch.mockReturnValue(errorResponse(401, 'Unauthorized'));
		await expect(createPage(config, 'Test')).rejects.toThrow(LogseqAuthError);
	});

	test('connection error throws LogseqConnectionError', async () => {
		mockFetch.mockRejectedValue(new TypeError('fetch failed'));
		await expect(createPage(config, 'Test')).rejects.toThrow(LogseqConnectionError);
	});

	test('500 throws LogseqApiError with status and message', async () => {
		mockFetch.mockReturnValue(errorResponse(500, 'Internal Server Error'));
		try {
			await createPage(config, 'Test');
			expect.fail('should have thrown');
		} catch (err) {
			expect(err).toBeInstanceOf(LogseqApiError);
			expect((err as LogseqApiError).status).toBe(500);
			expect((err as LogseqApiError).message).toBe('Internal Server Error');
		}
	});

	test('error-in-200: response with serialized Error object (string stack) throws LogseqApiError', async () => {
		mockFetch.mockReturnValue(
			jsonResponse({
				message: 'Invalid target: nil',
				stack: 'Error: Invalid target: nil\n  at Object.invoke (core.cljs:123)',
			}),
		);

		await expect(getPage(config, 'Test')).rejects.toThrow(LogseqApiError);
		try {
			await getPage(config, 'Test');
		} catch (err) {
			expect((err as LogseqApiError).status).toBe(200);
			expect((err as LogseqApiError).message).toBe('Invalid target: nil');
		}
	});

	test('false-positive guard: response with non-string stack passes through normally', async () => {
		const data = { uuid: 'abc', stack: 42 };
		mockFetch.mockReturnValue(jsonResponse(data));

		const result = await getPage(config, 'Test');
		expect(result).toEqual(data);
	});

	test('removeBlock throws LogseqConnectionError on connection failure', async () => {
		mockFetch.mockRejectedValue(new TypeError('fetch failed'));
		await expect(removeBlock(config, 'block-uuid')).rejects.toThrow(LogseqConnectionError);
	});

	test('removeBlock throws LogseqAuthError on 401', async () => {
		mockFetch.mockReturnValue(errorResponse(401, 'Unauthorized'));
		await expect(removeBlock(config, 'block-uuid')).rejects.toThrow(LogseqAuthError);
	});

	test('insertBatchBlock throws LogseqApiError on 500', async () => {
		mockFetch.mockReturnValue(errorResponse(500, 'Internal Server Error'));
		await expect(insertBatchBlock(config, 'target-uuid', [{ content: 'test' }])).rejects.toThrow(LogseqApiError);
	});

	test('insertBatchBlock throws LogseqConnectionError on connection failure', async () => {
		mockFetch.mockRejectedValue(new TypeError('fetch failed'));
		await expect(insertBatchBlock(config, 'target-uuid', [{ content: 'test' }])).rejects.toThrow(
			LogseqConnectionError,
		);
	});

	test('upsertBlockProperty throws LogseqAuthError on 401', async () => {
		mockFetch.mockReturnValue(errorResponse(401, 'Unauthorized'));
		await expect(upsertBlockProperty(config, 'block-uuid', 'key', 'value')).rejects.toThrow(LogseqAuthError);
	});

	test('upsertBlockProperty throws LogseqApiError on 500', async () => {
		mockFetch.mockReturnValue(errorResponse(500, 'Internal Server Error'));
		await expect(upsertBlockProperty(config, 'block-uuid', 'key', 'value')).rejects.toThrow(LogseqApiError);
	});
});
