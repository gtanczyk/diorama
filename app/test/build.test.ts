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
  // The stuck place: a front floor and a back floor with a 48 px band of closed rows between.
  const stuck = path.join(dir, 'places', 'stuck');
  fs.mkdirSync(stuck, { recursive: true });
  const walk: string[] = [];
  const zone: string[] = [];
  for (let r = 0; r < 112; r++) {
    const floor = r >= 30 && r < 60 ? '1' : r >= 60 ? '0' : '.';
    walk.push((floor !== '.' && !(r >= 58 && r < 64) ? '#' : '.').repeat(150));
    zone.push(floor.repeat(150));
  }
  fs.writeFileSync(path.join(stuck, 'geometry.json'), JSON.stringify({
    frame: { width: 1200, height: 896 }, cell: 8, walk, zone, scale: { horizonY: 100, pxPerY: 0.5, source: 'spark' }, start: [600, 850], things: [], occluders: [],
  }));
  const outline = [[0, 0], [10, 0], [10, 10]];
  fs.writeFileSync(path.join(stuck, 'layout.json'), JSON.stringify({ horizon: 100, sky: '#88aacc', ground: '#998877', things: [], lights: [], floors: [{ key: 'deck', is: 'deck', colour: '#aa8844', outline }, { key: 'quay', is: 'quay', colour: '#888888', outline }] }));
  // What earlier builds left: each place got through layout, paint, masks and derive once.
  for (const key of ['good', 'bad', 'stuck']) {
    fs.mkdirSync(path.join(dir, 'places', key), { recursive: true });
    for (const f of ['blockin.png', 'painting.png', 'masks.json', 'geometry.json']) {
      if (!fs.existsSync(path.join(dir, 'places', key, f))) fs.writeFileSync(path.join(dir, 'places', key, f), 'x');
    }
  }
  process.chdir(root);
  const ran: string[] = [];
  for (const step of ['icons', 'cast', 'model', 'sprites', 'sound', 'voices', 'faces']) defineCommand({ name: step, usage: step, async run() {} });
  for (const step of PLACE_STEPS) {
    defineCommand({
      name: step,
      usage: step,
      async run([, place]) {
        ran.push(`${step}:${place}`);
        if (step === 'masks' && place === 'bad') throw new Error('SAM said no');
        if (step === 'verify') {
          // The stub's verify passes once a floor stroke bridges the stuck place.
          const fixes = path.join(dir, 'places', place, 'corrections.json');
          const bridged = fs.existsSync(fixes) && JSON.parse(fs.readFileSync(fixes, 'utf8')).floors.deck?.strokes.length > 0;
          const ok = place !== 'stuck' || bridged;
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
  await registry.get('build')!.run(['w', '--from', 'verify', '--to', 'verify', '--repair', 'off']);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  const stuck = log.places.find((p: { place: string }) => p.place === 'stuck');
  expect(log.places.find((p: { place: string }) => p.place === 'good').ok).toBe(true);
  expect(stuck.issues[0].code).toBe('FLOOR_UNREACHABLE');
  expect(stuck.issues[0].play.tools[0]).toMatch(/^floor_cells/);
  expect(process.exitCode).toBe(1);
});

test('a place an earlier job never painted is set aside at paint, not failed later on a missing file', async () => {
  const { dir, ran } = world();
  fs.rmSync(path.join(dir, 'places', 'bad', 'painting.png'));
  fs.rmSync(path.join(dir, 'places', 'bad', 'masks.json'));
  await registry.get('build')!.run(['w', '--from', 'weather', '--to', 'weather']);
  expect(ran).toContain('weather:good');
  expect(ran).not.toContain('weather:bad');
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  expect(log.places).toEqual([expect.objectContaining({ place: 'bad', ok: false, from: 'paint' })]);
  expect(log.places[0].errors[0]).toMatch(/never got past paint \(no painting.png\)/);
});

test('when every place breaks, the step fails', async () => {
  world();
  await expect(registry.get('build')!.run(['w', '--from', 'masks', '--to', 'masks', '--place', 'bad'])).rejects.toThrow(/masks failed for every place/);
});

test('a short gap is bridged for free: a floor stroke in corrections.json, the place rebuilt from masks and playable', async () => {
  const { dir, ran } = world();
  await registry.get('build')!.run(['w', '--from', 'derive', '--to', 'verify']);
  const fixes = JSON.parse(fs.readFileSync(path.join(dir, 'places', 'stuck', 'corrections.json'), 'utf8'));
  expect(fixes.floors.deck.strokes).toHaveLength(1);
  expect(ran.filter((r) => r.endsWith(':stuck'))).toEqual(['derive:stuck', 'backdrop:stuck', 'weather:stuck', 'reactions:stuck', 'verify:stuck', 'masks:stuck', 'plates:stuck', 'derive:stuck', 'backdrop:stuck', 'weather:stuck', 'reactions:stuck', 'verify:stuck']);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  expect(log.places.find((p: { place: string }) => p.place === 'stuck').ok).toBe(true);
  expect(log.repairs[0]).toMatchObject({ place: 'stuck', by: 'auto', ok: true });
  expect(process.exitCode).toBeUndefined();
});

test('a remote interaction spot does not cause an invented boardwalk or brushed floor across a large gap', async () => {
  const { dir, ran } = world();
  const at = path.join(dir, 'places', 'stuck');
  const g = JSON.parse(fs.readFileSync(path.join(at, 'geometry.json'), 'utf8'));
  g.walk = Array.from({ length: 112 }, (_, r) => (r >= 30 && r < 48 || r >= 80 ? '#' : '.').repeat(150));
  g.zone = Array.from({ length: 112 }, (_, r) => (r >= 30 && r < 48 ? '1' : r >= 80 ? '0' : '.').repeat(150));
  g.things = [{ key: 'stuck-door', role: 'exit', kind: 'wall', box: [580, 350, 620, 400], stand: [600, 652] }];
  fs.writeFileSync(path.join(at, 'geometry.json'), JSON.stringify(g));
  await registry.get('build')!.run(['w', '--from', 'verify', '--to', 'verify', '--place', 'stuck']);
  expect(ran).toEqual(['verify:stuck']);
  expect(fs.existsSync(path.join(at, 'corrections.json'))).toBe(false);
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  expect(log.places[0].ok).toBe(false);
});

test('places do not wait for each other: a quick place is played while a slow one is still painted, the cast is made alongside', async () => {
  const { ran } = world();
  for (const step of ['cast', 'model', 'sprites', 'voices', 'sound', 'icons', 'faces']) defineCommand({ name: step, usage: step, async run() { ran.push(step); } });
  const paint = registry.get('paint')!;
  defineCommand({
    name: 'paint',
    usage: 'paint',
    async run(args) {
      if (args[1] === 'stuck') await new Promise((r) => setTimeout(r, 60));
      await paint.run(args);
      ran.push(`painted:${args[1]}`);
    },
  });
  await registry.get('build')!.run(['w', '--from', 'layout', '--repair', 'off']);
  const at = (r: string) => ran.indexOf(r);
  expect(at('verify:good')).toBeGreaterThan(-1);
  expect(at('verify:good')).toBeLessThan(at('painted:stuck'));
  expect(at('cast')).toBeLessThan(at('painted:stuck'));
  expect(at('model')).toBeLessThan(at('painted:stuck'));
  // Sprites walk the routes of every place, sound listens to every painting: they wait for the slow one.
  expect(at('sprites')).toBeGreaterThan(at('derive:stuck'));
  expect(at('sound')).toBeGreaterThan(at('painted:stuck'));
  expect(at('faces')).toBeGreaterThan(at('sprites'));
  expect(at('faces')).toBeGreaterThan(at('voices'));
  expect(at('faces')).toBeGreaterThan(at('cast'));
});

test('a world step that fails ends the build with its error once what was running is done', async () => {
  world();
  defineCommand({ name: 'cast', usage: 'cast', async run() { throw new Error('the hero could not be painted'); } });
  await expect(registry.get('build')!.run(['w', '--from', 'layout', '--repair', 'off'])).rejects.toThrow(/hero could not be painted/);
});

test('speaking-animation failure is recorded as incomplete while playable places finish', async () => {
  const { FacePreparationError } = await import('../src/scene/face-work.ts');
  const { dir, ran } = world();
  defineCommand({ name: 'faces', usage: 'faces', async run() { throw new FacePreparationError(['wren: F/V needs repair']); } });
  await registry.get('build')!.run(['w', '--from', 'derive', '--to', 'verify']);
  expect(ran).toContain('verify:good');
  expect(process.exitCode).toBeUndefined();
  const log = JSON.parse(fs.readFileSync(path.join(dir, 'build.json'), 'utf8'));
  expect(log.steps.faces).toMatchObject({ status: 'incomplete', warnings: ['wren: F/V needs repair'] });
  expect(log.steps.verify).toBeDefined();
});

test('even an unexpected faces failure never fails the build: it is recorded as incomplete with its error', async () => {
  world();
  defineCommand({ name: 'faces', usage: 'faces', async run() { throw new Error('broken command'); } });
  await registry.get('build')!.run(['w', '--from', 'faces', '--to', 'faces']);
  const log = JSON.parse(fs.readFileSync(path.join('worlds', 'w', 'build.json'), 'utf8'));
  expect(log.steps.faces).toMatchObject({ status: 'incomplete', warnings: ['broken command'] });
});
