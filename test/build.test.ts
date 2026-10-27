import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { PLACE_STEPS } from '../src/commands/build.ts';
import { defineCommand, registry } from '../src/registry.ts';

const cwd = process.cwd();
afterEach(() => {
  process.chdir(cwd);
  process.exitCode = undefined;
});

/** A world of two places with stub place steps: `bad` throws at masks, `good` writes a clean verify.json. */
function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-build-'));
  const dir = path.join(root, 'worlds', 'w');
  fs.mkdirSync(path.join(dir, 'memo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quays', pitch: 'Three quays on a river at dusk.', style: 'gouache, muted river colours', start: 'good',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: ['good', 'bad', 'stuck'].map((key) => ({ key, shows: `the ${key} quay at dusk`, mood: 'calm', things: [{ key: `${key}-door`, role: 'exit', looks: 'a red door' }], exits: [] })),
  }));
  process.chdir(root);
  const ran: string[] = [];
  for (const step of PLACE_STEPS) {
    defineCommand({
      name: step,
      usage: step,
      async run([, place]) {
        ran.push(`${step}:${place}`);
        if (step === 'masks' && place === 'bad') throw new Error('SAM said no');
        if (step === 'verify') {
          const ok = place !== 'stuck';
          const errors = ok ? [] : [{ code: 'FLOOR_UNREACHABLE', key: '0', detail: 'floor 0 has walkable cells but none reachable' }];
          fs.mkdirSync(path.join(dir, 'places', place), { recursive: true });
          fs.writeFileSync(path.join(dir, 'places', place, 'verify.json'), JSON.stringify({ ok, errors, flags: [] }));
          if (!ok) process.exitCode = 1;
        }
      },
    });
  }
  return { dir, ran };
}

test('a place that breaks is set aside and the others are built to the end, with what to try in the report', async () => {
  const { dir, ran } = world();
  await registry.get('build')!.run(['w', '--from', 'layout', '--to', 'derive']);
  expect(ran.filter((r) => r.endsWith(':bad'))).toEqual(['layout:bad', 'paint:bad', 'masks:bad']);
  expect(ran).toContain('derive:good');
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  expect(log.places).toEqual([expect.objectContaining({ place: 'bad', ok: false, from: 'masks', errors: ['STEP_FAILED masks: SAM said no'] })]);
  expect(process.exitCode).toBe(1);
});

test('verify\'s errors come with the playbook; playable places are not held back', async () => {
  const { dir } = world();
  await registry.get('build')!.run(['w', '--from', 'verify', '--to', 'verify']);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  const stuck = log.places.find((p: { place: string }) => p.place === 'stuck');
  expect(log.places.find((p: { place: string }) => p.place === 'good').ok).toBe(true);
  expect(stuck.issues[0].code).toBe('FLOOR_UNREACHABLE');
  expect(stuck.issues[0].play.tools[0]).toMatch(/^floor_cells/);
  expect(process.exitCode).toBe(1);
});

test('when every place breaks, the step fails', async () => {
  world();
  await expect(registry.get('build')!.run(['w', '--from', 'masks', '--to', 'masks', '--place', 'bad'])).rejects.toThrow(/masks failed for every place/);
});
