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

test('download asks again after a transient error or a dropped connection', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn()
    .mockResolvedValueOnce(new Response('<html>busy</html>', { status: 500 }))
    .mockRejectedValueOnce(new Error('fetch failed'))
    .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3])));
  vi.stubGlobal('fetch', fetch);
  const result = new Space('test/model').download({ path: '/tmp/gradio/x.png' });
  await vi.runAllTimersAsync();
  expect([...await result]).toEqual([1, 2, 3]);
  expect(fetch).toHaveBeenCalledTimes(3);
});

test('download does not ask again after a 404', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  await expect(new Space('test/model').download({ path: '/tmp/gradio/x.png' })).rejects.toThrow('test/model download /tmp/gradio/x.png: 404');
  expect(fetch).toHaveBeenCalledTimes(1);
});

test('a call whose queue stream goes silent gives up instead of hanging the build', async () => {
  const config = { components: [], dependencies: [{ id: 0, api_name: 'run', inputs: [] }] };
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/config')) return Response.json(config);
    if (url.includes('/queue/join')) return Response.json({ event_id: 'e1' });
    // The queue opens and never says anything again, until the caller aborts.
    return new Response(new ReadableStream({
      start(ctrl) {
        ctrl.enqueue(new TextEncoder().encode('data: {"msg":"estimation","event_id":"e1"}\n\n'));
        init?.signal?.addEventListener('abort', () => ctrl.error(new DOMException('aborted', 'AbortError')));
      },
    }));
  });
  vi.stubGlobal('fetch', fetch);
  const { SPACE_WAIT } = await import('../src/model/space.ts');
  const was = { ...SPACE_WAIT };
  Object.assign(SPACE_WAIT, { idleMs: 30, totalMs: 1000 });
  try {
    await expect(new Space('test/model').call('run', [])).rejects.toThrow('test/model /run: silent for 0 s');
  } finally {
    Object.assign(SPACE_WAIT, was);
  }
});
