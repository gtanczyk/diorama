import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { WorldFiles } from '../src/world/files.ts';
import { retryVoiceLine, voiceRetryTarget } from '../src/sound/retry.ts';
import { voiceLine, freeVoiceSlot } from '../src/sound/voices.ts';
import { scene } from './fixtures/scene.ts';
import '../src/actions/cast.ts';
import { runAction, type ActionContext } from '../src/actions/registry.ts';

vi.mock('../src/sound/sources.ts', () => ({ elevenKey: () => 'test' }));
vi.mock('../src/sound/cost.ts', async (original) => ({ ...await original<object>(), creditGuard: async () => ({ report: async () => 'test' }) }));
vi.mock('../src/sound/voices.ts', async (original) => ({ ...await original<object>(), voiceLine: vi.fn(), freeVoiceSlot: vi.fn(), DesignedVoices: class { async close() {} } }));
let root: string, files: WorldFiles;
const failure = { speaker: 'hero', text: 'Found it.', reason: 'speech rejected after 3 takes' };
const other = { speaker: 'narrator', text: 'Find the token.', file: 'sound/voice/intro.mp3', seconds: 1, heard: 'Find the token.', match: 1, flags: [] };
const cast = { hero: { voice: 'design', design: { generated: 'selected-preview', description: 'User selected voice', request: 'Keep this actor' }, why: 'selected by user', stability: 0.45, style: 0.2, pitch: 0 }, narrator: { voice: 'narrator', why: '', stability: 0.5, style: 0.1 } };
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-voice-retry-'));
  const { put } = await scene(root);
  put('voices.json', { cast, lines: [other], failures: [failure, { speaker: 'narrator', text: 'You found the token.', reason: 'another failure' }] });
  put('sound/voice/intro.mp3', Buffer.from('unchanged audio'));
  files = new WorldFiles('w', root);
  vi.clearAllMocks();
  vi.mocked(freeVoiceSlot).mockResolvedValue(true);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('single-line retry preserves the cast, unrelated audio and failures', async () => {
  vi.mocked(voiceLine).mockImplementation(async (_memo, line, _voice, write) => ({ ...line, file: write('new', Buffer.from('new audio')), seconds: 1, heard: line.text, match: 1, flags: [] }));
  const before = files.readJson(files.path('voices.json')) as { cast: object };
  await retryVoiceLine(files, 'hero', 'Found it.');
  const after = files.readJson(files.path('voices.json')) as { cast: object; lines: unknown[]; failures: unknown[] };
  expect(after.cast).toEqual(before.cast);
  expect(after.lines).toContainEqual(other);
  expect(after.lines).toHaveLength(2);
  expect(after.failures).toEqual([{ speaker: 'narrator', text: 'You found the token.', reason: 'another failure' }]);
  expect(fs.readFileSync(files.path(other.file), 'utf8')).toBe('unchanged audio');
  expect(voiceLine).toHaveBeenCalledTimes(1);
  expect(vi.mocked(voiceLine).mock.calls[0][5]).toEqual({ retryRejected: true });
});

test('an outage updates only the target failure and its next retry reuses saved audio', async () => {
  vi.mocked(voiceLine).mockRejectedValue(new Error('transcribe: backlog'));
  await expect(retryVoiceLine(files, 'hero', 'Found it.')).rejects.toThrow('backlog');
  const after = files.readJson(files.path('voices.json')) as { cast: object; lines: unknown[]; failures: unknown[] };
  expect(after.cast).toEqual(cast); expect(after.lines).toEqual([other]);
  expect(after.failures).toContainEqual({ ...failure, reason: 'transcribe: backlog' });
  await expect(retryVoiceLine(files, 'hero', 'Found it.')).rejects.toThrow('backlog');
  expect(vi.mocked(voiceLine).mock.calls[1][5]).toEqual({ retryRejected: false });
});

test('removed lines and unknown speakers cannot be retried', () => {
  expect(() => voiceRetryTarget(files, 'hero', 'Old wording')).toThrow('no longer');
  expect(() => voiceRetryTarget(files, 'unknown', 'Found it.')).toThrow('no longer');
  expect(voiceLine).not.toHaveBeenCalled();
});

test('no voice slot never substitutes a different actor', async () => {
  vi.mocked(freeVoiceSlot).mockResolvedValue(false);
  const before = fs.readFileSync(files.path('voices.json'), 'utf8');
  await expect(retryVoiceLine(files, 'hero', 'Found it.')).rejects.toThrow('selected voice is unchanged');
  expect(fs.readFileSync(files.path('voices.json'), 'utf8')).toBe(before);
  expect(voiceLine).not.toHaveBeenCalled();
});

test('Studio and agent action queues precisely one line without recasting', async () => {
  const start = vi.fn(() => ({ id: 'retry', state: 'queued' }));
  const ctx = { root, by: 'user', jobs: { start }, events: { publish: vi.fn() } } as unknown as ActionContext;
  await runAction('voice_retry', { slug: 'w', key: 'hero', text: 'Found it.' }, ctx);
  expect(start).toHaveBeenCalledWith('w', ['voice-retry', 'w', 'hero', 'Found it.'], 'retry line hero', 'user');
  expect(voiceLine).not.toHaveBeenCalled();
  await expect(runAction('voice_retry', { slug: 'w', key: 'hero', text: 'Removed' }, ctx)).rejects.toThrow('no longer');
  expect(start).toHaveBeenCalledTimes(1);
});
