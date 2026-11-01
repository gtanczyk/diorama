import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, expect, test, vi } from 'vitest';
import { MetaHttpError } from '../src/meta/http.ts';

// The image filter of this stand-in refuses any prompt with "bare" in it, as Meta's refused "between bare trees".
const muse = vi.hoisted(() => ({ prompts: [] as string[] }));
vi.mock('../src/meta/muse.ts', () => ({
  museEdit: async (_memo: unknown, { prompt }: { prompt: string }) => {
    muse.prompts.push(prompt);
    if (/\bbare\b/.test(prompt)) throw new MetaHttpError(400, 'POST /images/edits: 400 {"error":{"code":"content_policy_violation","message":"The response was filtered due to the prompt triggering our content management policy."}}');
    return sharp({ create: { width: 1200, height: 896, channels: 3, background: '#557755' } }).png().toBuffer();
  },
}));
vi.mock('../src/meta/spark.ts', () => ({
  askSparkJson: async (_memo: unknown, { label, prompt }: { label: string; prompt: string }) => {
    if (label.startsWith('brief:')) {
      // Spark's brief adds the word the filter refuses, as it did for the playground.
      return { looks: { swing: 'two empty rubber seats on a swing frame between bare trees', grass: 'worn pale grass under the frame' }, alive: [] };
    }
    if (label.startsWith('reword:')) {
      expect(prompt).toContain('safety filter');
      return { shows: 'a quiet playground among leafless trees', mood: 'pale morning', looks: { swing: 'a faded swing frame, its two seats resting low', grass: 'worn pale grass under the frame' } };
    }
    if (label.startsWith('critic:')) return { issues: [] };
    if (label.startsWith('paint-layout:')) return { horizon: 300, things: [{ key: 'swing', box: [450, 500, 750, 700], approach: true, why: 'same frame' }], floors: [{ key: 'grass', coverage: 1, connected: true, reachesEdges: true, why: 'continuous grass' }] };
    throw new Error(`unexpected spark ask ${label}`);
  },
}));

const cwd = process.cwd();
const roots: string[] = [];
afterEach(() => {
  process.chdir(cwd);
  roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  muse.prompts.length = 0;
});

async function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-words-'));
  roots.push(root);
  const dir = path.join(root, 'worlds', 'w');
  const place = path.join(dir, 'places', 'park');
  fs.mkdirSync(place, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify({
    title: 'Park', pitch: 'A pale park on a winter morning.', style: 'gouache, pale winter colours', start: 'park',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'park', shows: 'a pale playground between bare trees', mood: 'still', exits: [], things: [{ key: 'swing', role: 'prop', looks: 'faded swing frame with two empty swings' }] }],
  }));
  const outline = [[0, 896], [0, 500], [1200, 500], [1200, 896]];
  fs.writeFileSync(path.join(place, 'layout.json'), JSON.stringify({ horizon: 300, sky: '#99aabb', ground: '#556677', lights: [], floors: [{ key: 'grass', is: 'grass', colour: '#668844', outline }], things: [{ key: 'swing', colour: '#3355aa', x: 600, footY: 700, width: 300, height: 200, metres: 2 }] }));
  fs.writeFileSync(path.join(place, 'blockin.png'), await sharp({ create: { width: 1200, height: 896, channels: 3, background: '#000' } }).png().toBuffer());
  process.chdir(root);
  await import('../src/commands/paint.ts');
  const { registry } = await import('../src/registry.ts');
  return { place, paint: () => registry.get('paint')!.run(['w', 'park']) };
}

test('a painting the safety filter refuses is reworded by Spark and painted; the wording is kept so the next paint asks with it', async () => {
  const { place, paint } = await world();
  await paint();
  expect(fs.existsSync(path.join(place, 'painting.png'))).toBe(true);
  expect(muse.prompts).toHaveLength(2);
  expect(muse.prompts[1]).toContain('leafless');
  expect(muse.prompts[1]).toContain('seats resting low');
  expect(muse.prompts[1]).not.toMatch(/\bbare\b/);
  const fixes = JSON.parse(fs.readFileSync(path.join(place, 'corrections.json'), 'utf8'));
  expect(fixes.words).toMatchObject({ shows: 'a quiet playground among leafless trees', by: 'filter' });
  // A rebuild from paint keeps the painting; with it gone, the kept wording paints at once, with no refusal.
  muse.prompts.length = 0;
  fs.rmSync(path.join(place, 'painting-first.png'));
  await paint();
  expect(muse.prompts).toHaveLength(1);
  expect(muse.prompts[0]).toContain('leafless');
});

test('a filter refusal is told apart from other failures', async () => {
  const { refusedByFilter } = await import('../src/scene/words.ts');
  expect(refusedByFilter(new Error('POST /images/edits: 400 {"error":{"code":"content_policy_violation"}}'))).toBe(true);
  expect(refusedByFilter(new Error('POST /images/edits: 500 oops'))).toBe(false);
});
