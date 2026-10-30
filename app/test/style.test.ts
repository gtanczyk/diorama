import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { restyleFigurePrompt, restylePlacePrompt } from '../src/scene/restyle.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';
import { WorldFiles } from '../src/world/files.ts';
import { castStyle, markStyled, placeStyle, readStyled } from '../src/world/styled.ts';
import { stylePlan } from '../src/world/style-plan.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

const CARTOON = 'bright flat cartoon with thick black outlines';
const PAINTERLY = 'realistic oil painting, soft natural light, muted palette';

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-style-'));
  roots.push(root);
  const dir = path.join(root, 'w');
  for (const p of ['dock', 'hill']) fs.mkdirSync(path.join(dir, 'places', p), { recursive: true });
  fs.mkdirSync(path.join(dir, 'cast'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Quay', pitch: 'A small quay on a river at dusk.', style: CARTOON, start: 'dock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [
      { key: 'dock', shows: 'a dock at dusk', mood: 'calm', exits: [{ to: 'hill', via: 'path' }], things: [{ key: 'path', role: 'exit', looks: 'a path' }, { key: 'ferryman', role: 'npc', looks: 'an old ferryman' }] },
      { key: 'hill', shows: 'a grassy hill', mood: 'windy', exits: [{ to: 'dock', via: 'steps' }], things: [{ key: 'steps', role: 'exit', looks: 'steps' }] },
    ],
  }));
  for (const p of ['dock', 'hill']) fs.writeFileSync(path.join(dir, 'places', p, 'painting.png'), 'x');
  fs.writeFileSync(path.join(dir, 'cast', 'wren-painting.png'), 'x');
  fs.writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ steps: { paint: { seconds: 60, sent: { spark: 4, muse: 6 } }, masks: { seconds: 60, sent: { spark: 2, sam: 20 } }, cast: { seconds: 30, sent: { muse: 2, sam: 2 } } } }));
  const events = new Events();
  const jobs = new Jobs(events, { bin: FAKE });
  return { root, dir, files: new WorldFiles('w', root), jobs, ctx: (by: 'user' | 'agent') => ({ by, root, events, jobs }) };
}

test('style_set without go only estimates, from what the world\'s own build sent', async () => {
  const { ctx, dir, jobs } = world();
  const r = (await runAction('style_set', { slug: 'w', style: PAINTERLY }, ctx('user'))) as { estimate: { places: string[]; cast: string[]; calls: Record<string, number> }; line: string; was: string };
  expect(r.was).toBe(CARTOON);
  expect(r.estimate.places).toEqual(['dock', 'hill']);
  // Only the hero is painted so far; the ferryman has nothing to repaint.
  expect(r.estimate.cast).toEqual(['wren']);
  // paint and masks as the world's build sent them, the cast step shared over two characters, the rest by the rough table.
  expect(r.estimate.calls).toEqual({ spark: 16, muse: 13, sam: 25 });
  expect(r.line).toContain('2 place(s) repainted');
  expect(JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8')).style).toBe(CARTOON);
  expect(jobs.list('w')).toEqual([]);
});

test('style_set with go runs the style command as one job, so one undo takes it all back', async () => {
  const { ctx } = world();
  const place = (await runAction('style_set', { slug: 'w', style: PAINTERLY, scope: 'place', key: 'hill', go: true }, ctx('agent'))) as { job: { args: string[]; label: string } };
  expect(place.job.args).toEqual(['style', 'w', PAINTERLY, '--place', 'hill']);
  const cast = (await runAction('style_set', { slug: 'w', style: PAINTERLY, scope: 'cast', go: true }, ctx('user'))) as { job: { args: string[] } };
  expect(cast.job.args).toEqual(['style', 'w', PAINTERLY, '--cast', 'all']);
  await expect(runAction('style_set', { slug: 'w', style: PAINTERLY, scope: 'place', key: 'moon' }, ctx('user'))).rejects.toThrow(/scope place needs key/);
});

test('a place\'s or character\'s own style wins over the world\'s; styled.json keeps what each was painted in', () => {
  const { files, dir } = world();
  const w = files.world();
  expect(placeStyle(files, w, 'dock')).toBe(CARTOON);
  fs.writeFileSync(path.join(dir, 'places', 'dock', 'corrections.json'), JSON.stringify({ style: PAINTERLY }));
  fs.writeFileSync(path.join(dir, 'cast', 'fixes.json'), JSON.stringify({ wren: { style: PAINTERLY } }));
  expect(placeStyle(files, w, 'dock')).toBe(PAINTERLY);
  expect(castStyle(files, w, 'wren')).toBe(PAINTERLY);
  expect(castStyle(files, w, 'ferryman')).toBe(CARTOON);
  markStyled(files, 'places', 'dock', CARTOON);
  markStyled(files, 'cast', 'wren', PAINTERLY);
  expect(readStyled(files)).toEqual({ places: { dock: CARTOON }, cast: { wren: PAINTERLY } });
  expect(stylePlan(files, w, 'place', 'dock').places).toEqual(['dock']);
});

test('the restyle prompts keep the composition and the child\'s drawing', () => {
  const place = { key: 'dock', shows: 'a dock at dusk', mood: 'calm', exits: [], things: [{ key: 'boat', role: 'prop' as const, looks: 'a blue boat' }, { key: 'jory', role: 'npc' as const, looks: 'a man' }] };
  const p = restylePlacePrompt(place, CARTOON, PAINTERLY, undefined, [{ key: 'boat', image: Buffer.from('x') }]);
  expect(p).toContain('Keep the composition exactly');
  expect(p).toContain(`It is painted now as: ${CARTOON}`);
  expect(p).toContain(`Paint it as: ${PAINTERLY}`);
  expect(p).toContain('- boat: a blue boat');
  expect(p).not.toContain('a man');
  expect(p).toContain('image 2 is the boat');
  const f = restyleFigurePrompt('a keeper', CARTOON, PAINTERLY, true);
  expect(f).toContain('exact pose');
  expect(f).toContain("child's drawing");
});
