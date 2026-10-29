import { afterEach, expect, test, vi } from 'vitest';
import { Space } from '../src/model/space.ts';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

test('upload retries transient HTTP errors and sends a fresh multipart body', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('<html>proxy failed</html>', { status: 500 }))
    .mockResolvedValueOnce(new Response('busy', { status: 429, headers: { 'retry-after': '2' } }))
    .mockResolvedValueOnce(Response.json(['/tmp/upload/view.png']));
  vi.stubGlobal('fetch', fetch);
  const result = new Space('test/model').upload('view.png', Buffer.from('picture'));
  await vi.runAllTimersAsync();
  expect(await result).toMatchObject({ path: '/tmp/upload/view.png', orig_name: 'view.png' });
  expect(fetch).toHaveBeenCalledTimes(3);
  const bodies = fetch.mock.calls.map(([, init]) => init.body);
  expect(new Set(bodies).size).toBe(3);
  for (const body of bodies) expect(await body.get('files').text()).toBe('picture');
});

test.each([401, 403, 413])('upload does not retry HTTP %i', async (status) => {
  const fetch = vi.fn().mockResolvedValue(new Response('<html>private proxy response</html>', { status }));
  vi.stubGlobal('fetch', fetch);
  await expect(new Space('test/model').upload('v.png', Buffer.from('v'))).rejects.toThrow(`HTTP ${status} (1 attempt(s))`);
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('persistent 500 stops after three uploads and excludes HTML from the error', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockImplementation(async () => new Response('<html>private proxy response</html>', { status: 500 }));
  vi.stubGlobal('fetch', fetch);
  const result = new Space('test/model').upload('v.png', Buffer.from('v')).catch((e: Error) => e.message);
  await vi.runAllTimersAsync();
  expect(await result).toBe('test/model upload: HTTP 500 (3 attempt(s))');
  expect(fetch).toHaveBeenCalledTimes(3);
});
