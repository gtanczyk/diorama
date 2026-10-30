import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Memo } from '../src/meta/memo.ts';
import { transcribeFile, type SttProvider } from '../src/speech/transcribe.ts';
import { metaFileStt } from '../src/meta/voice-file.ts';
let root: string, memo: Memo;
const pcm = Buffer.alloc(48000);
const response = { sessionId: 'session-1', transcript: 'To jest klucz.', audioDurationMs: 1000, turns: [{ turnId: 1, startMs: 100, endMs: 900, transcript: 'To jest klucz.', speaker: 'A' }] };
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'file-stt-')); memo = new Memo(path.join(root, 'memo')); vi.stubEnv('DIORAMA_CACHE', path.join(root, 'cache')); vi.stubEnv('META_API_KEY', 'test-meta-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); fs.rmSync(root, { recursive: true, force: true }); });
test('Meta receives a multipart WAV, diarization and optional language/vocabulary hints; timestamps become seconds', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(response))); vi.stubGlobal('fetch', fetcher);
  const result = await transcribeFile(memo, 'clip', pcm, { languages: ['Polish'], keywords: ['Smoczek'] });
  const [url, options] = fetcher.mock.calls[0];
  expect(url).toMatch(/^https:\/\/api.meta.ai\/v1\/asr\/transcribe\?sessionId=/);
  expect(options.headers).toEqual({ Authorization: 'Bearer test-meta-key', Accept: 'application/json' });
  const form = options.body as FormData;
  expect(JSON.parse(await (form.get('request') as Blob).text())).toMatchObject({ mode: 'DIARIZATION', audioEncoding: 'WAV', languageBias: ['Polish'], keywords: ['Smoczek'] });
  const wav = Buffer.from(await (form.get('audio') as Blob).arrayBuffer());
  expect(wav.subarray(0, 4).toString()).toBe('RIFF'); expect(wav.readUInt32LE(24)).toBe(24000); expect(wav.subarray(44, 44 + pcm.length)).toEqual(pcm); expect(wav.length).toBe(pcm.length + 48000 + 44);
  expect(result).toMatchObject({ provider: 'meta', timing: 'turn', speakerScope: 'session-1', segments: [{ start: .1, end: .9, speaker: 'A' }] });
});
test('shared cache separates provider, model and hints; duplicate requests share the same paid operation', async () => {
  const fake: SttProvider = { id: 'test-other', model: 'stt-model', capabilities: { maxSeconds: 600, speakers: false, timing: 'none' }, transcribe: vi.fn().mockResolvedValue({ provider: 'test-other', model: 'stt-model', timing: 'none', text: 'A key', segments: [] }) };
  await Promise.all([transcribeFile(memo, 'a', pcm, {}, fake), transcribeFile(memo, 'b', pcm, {}, fake)]);
  await transcribeFile(memo, 'again', pcm, {}, fake);
  expect(fake.transcribe).toHaveBeenCalledTimes(1);
  await transcribeFile(memo, 'hint', pcm, { keywords: ['Dziadek'] }, fake);
  expect(fake.transcribe).toHaveBeenCalledTimes(2);
  const next: SttProvider = { ...fake, model: 'new-model', transcribe: vi.fn().mockResolvedValue({ provider: 'test-other', model: 'new-model', timing: 'none', text: 'Another key', segments: [] }) };
  expect((await transcribeFile(memo, 'new', pcm, {}, next)).text).toBe('Another key');
});
test('auth errors fail once, and failed calls are not cached', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response('unauthorized', { status: 401 })).mockResolvedValueOnce(new Response(JSON.stringify(response))); vi.stubGlobal('fetch', fetcher);
  await expect(transcribeFile(memo, 'bad', pcm)).rejects.toThrow('401'); expect(fetcher).toHaveBeenCalledTimes(1);
  await transcribeFile(memo, 'retry', pcm); expect(fetcher).toHaveBeenCalledTimes(2);
});
test('server budget failure retries once and queue recovers', async () => {
  vi.useFakeTimers(); const fetcher = vi.fn().mockImplementation(async () => new Response('budget', { status: 500 })); vi.stubGlobal('fetch', fetcher);
  const failed = expect(transcribeFile(memo, 'bad', pcm)).rejects.toThrow('500');
  await vi.runAllTimersAsync(); await failed; expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockImplementation(async () => new Response(JSON.stringify(response)));
  await transcribeFile(memo, 'retry', pcm);
});
test('adapter refuses malformed timing instead of caching or inventing precision', async () => {
  const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify({ ...response, turns: [{ ...response.turns[0], endMs: 8000 }] }))); vi.stubGlobal('fetch', fetcher);
  await expect(transcribeFile(memo, 'bad', pcm)).rejects.toThrow('outside');
  fetcher.mockImplementation(async () => new Response(JSON.stringify({ ...response, turns: [] })));
  expect(await transcribeFile(memo, 'untimed', pcm)).toMatchObject({ timing: 'none', segments: [] });
  await expect(transcribeFile(memo, 'long', Buffer.alloc(601 * 48000))).rejects.toThrow('600s limit');
});
