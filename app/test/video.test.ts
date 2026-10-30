import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import '../src/actions/video.ts';
import { Events } from '../src/studio/events.ts';
import { runAction } from '../src/actions/registry.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { transcribeFile } from '../src/speech/transcribe.ts';
import { VIDEO_CHUNK, readVideoPart, videoDir } from '../src/world/video.ts';
vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
vi.mock('../src/speech/transcribe.ts', () => ({ transcribeFile: vi.fn() }));
let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-video-')); vi.resetAllMocks(); });
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const action = async (name: string, input: object) => runAction(name, input, { root, by: 'user', events: new Events() } as never) as Promise<any>;
async function upload(bytes: Buffer) {
  const { id } = await action('video_upload', { name: 'brief.mp4', size: bytes.length });
  for (let offset = 0; offset < bytes.length; offset += VIDEO_CHUNK) await action('video_upload', { id, offset, data: bytes.subarray(offset, offset + VIDEO_CHUNK).toString('base64') });
  return id as string;
}
function movie(seconds: number, sound = false) {
  const file = path.join(root, 'test.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:r=1', ...(sound ? ['-f', 'lavfi', '-i', 'sine=frequency=400:sample_rate=24000'] : []), '-t', String(seconds), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', ...(sound ? ['-c:a', 'aac'] : []), file]);
  return fs.readFileSync(file);
}
function reader() {
  vi.mocked(transcribeFile).mockResolvedValue({ text: 'This key opens the blue house.', provider: 'meta', model: 'muse-voice-transcribe-1.0', timing: 'turn', speakerScope: 'clip-session', segments: [{ start: 1, end: 4, text: 'This key opens the blue house.', speaker: 'A' }] });
  vi.mocked(askSparkJson).mockImplementation(async (_memo, request) => {
    const intervals = JSON.parse(request.prompt.split('seconds): ')[1].split('\n')[0]);
    return { idea: 'The hero finds a key that opens the blue house.', observations: 'The blue object is visible; its identity needs review.', frames: intervals.map((i: { at: number }) => ({ at: i.at, use: true })) };
  });
}
test('chunk upload is resumable and idempotent but rejects conflicts and incomplete movies', async () => {
  const { id } = await action('video_upload', { name: 'brief.mov', size: 6 });
  await action('video_upload', { id, offset: 0, data: Buffer.from('abc').toString('base64') });
  await action('video_upload', { id, offset: 0, data: Buffer.from('abc').toString('base64') });
  expect(await action('video_upload', { id })).toMatchObject({ received: 3 });
  await expect(action('video_upload', { id, offset: 0, data: Buffer.from('xyz').toString('base64') })).rejects.toThrow('Conflicting');
  await expect(action('video_upload', { id, offset: 4, data: 'YQ==' })).rejects.toThrow('byte 3');
  await expect(action('video_inspect', { id })).rejects.toThrow('incomplete');
  await expect(action('video_upload', { id: '../bad' })).rejects.toThrow();
});
test('silent video uses pictures, records timestamps and never calls transcription', async () => {
  const id = await upload(movie(2)); reader();
  expect(await action('video_inspect', { id })).toMatchObject({ audio: false, parts: 1 });
  await readVideoPart(root, id, 0, 'A Polish game');
  expect(transcribeFile).not.toHaveBeenCalled();
  const result = await action('video_result', { id });
  expect(result.photos).toHaveLength(1);
  expect(result.photos[0].name).toContain('0s.jpg');
  expect(result.photos[0].data).toMatch(/^data:image\/jpeg;base64,/);
  expect(fs.existsSync(path.join(videoDir(root, id), 'source'))).toBe(true);
});
test('a longer movie keeps speech tied to ten-second windows, resumes without paid repeat calls and preserves the tail', async () => {
  const id = await upload(movie(65, true)); reader();
  expect(await action('video_inspect', { id })).toMatchObject({ audio: true, parts: 3 });
  await expect(action('video_result', { id })).rejects.toThrow();
  await Promise.all([readVideoPart(root, id, 0, ''), readVideoPart(root, id, 0, '')]);
  expect(askSparkJson).toHaveBeenCalledTimes(1);
  expect(transcribeFile).toHaveBeenCalledTimes(1);
  await readVideoPart(root, id, 1, ''); await readVideoPart(root, id, 2, '');
  const result = await action('video_result', { id });
  expect(result.photos).toHaveLength(7);
  expect(result.speech[1].segments[0]).toMatchObject({ start: 31, end: 34, speaker: 'A' });
  const intervals = JSON.parse(fs.readFileSync(path.join(videoDir(root, id), 'part-1.json'), 'utf8')).intervals;
  expect(intervals[0].said).toContain('blue house'); expect(intervals[1].said).toBe('');
  expect(result.photos.at(-1).name).toContain('60s');
  const request = vi.mocked(askSparkJson).mock.calls[0][1];
  expect(request.personal).toBe(true); expect(request.images).toHaveLength(3);
  expect(request.prompt).toContain('"from":0,"to":10,"at":0,"said":"This key opens the blue house."');
  expect(vi.mocked(askSparkJson).mock.calls[1][1].prompt).toContain('Previous accumulated brief: The hero');
  await expect(readVideoPart(root, id, 0, 'changed')).rejects.toThrow('original note');
}, 30000);
test('an outage does not mark an interval complete and an invalid frame mapping is rejected', async () => {
  const id = await upload(movie(1)); await action('video_inspect', { id });
  vi.mocked(askSparkJson).mockRejectedValueOnce(new Error('provider unavailable'));
  await expect(readVideoPart(root, id, 0, '')).rejects.toThrow('provider unavailable');
  expect(fs.existsSync(path.join(videoDir(root, id), 'part-0.json'))).toBe(false);
  vi.mocked(askSparkJson).mockResolvedValue({ idea: 'A blue house adventure', observations: '', frames: [] });
  await expect(readVideoPart(root, id, 0, '')).rejects.toThrow('omitted');
  reader(); await readVideoPart(root, id, 0, '');
  expect(await action('video_result', { id })).toHaveProperty('idea');
});
