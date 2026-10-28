import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { worldSummary } from '../src/actions/world.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';
import { scene } from './fixtures/scene.ts';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

test('list, world and place status recheck current masks instead of trusting an old green report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-status-')); roots.push(root);
  const { dir, notes, put } = await scene(root);
  const events = new Events(); const ctx = { root, events, jobs: new Jobs(events), by: 'user' as const };
  expect(worldSummary(root, 'w').playable).toBe(1);
  put('places/room/masks.json', { ...notes, things: { token: { ...notes.things.token, check: { ok: false, seen: 'a grey stone', box: [490, 540, 510, 560] } } } });
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'places/room/verify.json'), 'utf8')).ok).toBe(true);
  expect(worldSummary(root, 'w')).toMatchObject({ playable: 0, verified: 1 });
  const world = await runAction('world_status', { slug: 'w' }, ctx) as { playable: number; placeDetail: Array<{ verdict: { ok: boolean }; trouble: { why: string } }> };
  expect(world.playable).toBe(0); expect(world.placeDetail[0].verdict.ok).toBe(false); expect(world.placeDetail[0].trouble.why).toContain('MASK_WRONG');
  const place = await runAction('place_status', { slug: 'w', place: 'room' }, ctx) as { playable: boolean; errors: Array<{ code: string }> };
  expect(place.playable).toBe(false); expect(place.errors[0].code).toBe('MASK_WRONG');
  fs.rmSync(path.join(dir, 'places/room/geometry.json'));
  expect(worldSummary(root, 'w').playable).toBe(0);
});
