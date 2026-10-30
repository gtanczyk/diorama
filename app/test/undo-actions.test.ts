import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs, type Job } from '../src/studio/jobs.ts';
import { snapshotBeforeJob } from '../src/studio/history.ts';
import { scene } from './fixtures/scene.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const cases: Array<[string, Record<string, unknown>, string]> = [
  ['reactions_set', { place: 'room', hint: 'Keep the floor clean' }, 'places/room/reactions-wish.json'],
  ['weather_set', { place: 'room', fall: 'rain' }, 'places/room/weather-wish.json'],
  ['water_flow', { place: 'room', flow: 'reverse' }, 'places/room/depth.json'],
  ['fog_drift', { place: 'room', drift: 'left', speed: 2 }, 'places/room/depth.json'],
  ['cast_redo', { key: 'hero', anotherTake: true }, 'cast/fixes.json'],
  ['cast_animate', { key: 'hero' }, 'cast/fixes.json'],
  ['voice_set', { key: 'hero', voice: 'test-voice' }, 'cast/fixes.json'],
  ['icon_redo', { item: 'token', anotherTake: true }, 'items/fixes.json'],
  ['icon_fix_clear', { item: 'token' }, 'items/fixes.json'],
  ['story_redo', { wish: 'Add a friendly ending' }, 'story-fixes.json'],
];

test.each(cases)('%s queues its source edit, retries cancellation, and supports undo/redo', async (name, input, rel) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-undo-actions-'));
  const { dir, put } = await scene(root);
  put('items/fixes.json', { token: { hint: 'a bright red token' } });
  const file = path.join(dir, rel);
  const read = () => fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  const before = read();
  const events = new Events();
  const jobs = new Jobs(events, { bin: FAKE, beforeStart: snapshotBeforeJob(root, events) });
  const ctx = { root, events, jobs, by: 'user' as const };
  try {
    const blocker = jobs.start('w', ['sleep', 'w'], 'blocker', 'user');
    const queued = await runAction(name, { slug: 'w', ...input }, ctx) as Job;
    expect(queued.state).toBe('queued');
    expect(read()).toBe(before);
    jobs.cancel(queued.id);
    jobs.cancel(blocker.id); await jobs.wait(blocker.id);
    // Await child exit before retrying, so it can leave the queue.
    await expect.poll(() => jobs.list().every((j) => j.state !== 'running')).toBe(true);
    const retried = await runAction('job_retry', { id: queued.id }, ctx) as Job;
    expect((await jobs.wait(retried.id)).state).toBe('done');
    const after = read(); expect(after).not.toBe(before);
    await runAction('history_undo', { slug: 'w' }, ctx); expect(read()).toBe(before);
    await runAction('history_redo', { slug: 'w' }, ctx); expect(read()).toBe(after);
  } finally { jobs.stopAll(); await Promise.all(jobs.list().map((j) => jobs.wait(j.id))); fs.rmSync(root, { recursive: true, force: true }); }
});

test('queued edits read their latest shared source and direct story text has its own undo', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-undo-shared-'));
  const { dir } = await scene(root);
  const events = new Events();
  const jobs = new Jobs(events, { bin: FAKE, beforeStart: snapshotBeforeJob(root, events) });
  const ctx = { root, events, jobs, by: 'user' as const };
  const read = (f: string) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  try {
    await runAction('water_flow', { slug: 'w', place: 'room', flow: 'reverse' }, ctx);
    const last = await runAction('fog_drift', { slug: 'w', place: 'room', drift: 'left' }, ctx) as Job;
    await expect(runAction('story_text', { slug: 'w', path: 'intro', text: 'Changed intro.' }, ctx)).rejects.toThrow('wait before editing');
    await jobs.wait(last.id);
    expect(read('places/room/depth.json')).toMatchObject({ flow: 'reverse', fog: 'left' });
    await runAction('history_undo', { slug: 'w' }, ctx);
    expect(read('places/room/depth.json')).toMatchObject({ flow: 'reverse' });
    expect(read('places/room/depth.json').fog).not.toBe('left');
    const before = read('story.json');
    await runAction('story_text', { slug: 'w', path: 'intro', text: 'Changed intro.' }, ctx);
    expect(read('story.json').intro).toBe('Changed intro.');
    await runAction('history_undo', { slug: 'w' }, ctx); expect(read('story.json')).toEqual(before);
  } finally { jobs.stopAll(); await Promise.all(jobs.list().map((j) => jobs.wait(j.id))); fs.rmSync(root, { recursive: true, force: true }); }
});
