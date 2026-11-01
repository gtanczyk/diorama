import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
vi.mock('../src/meta/muse.ts', () => ({ museEdit: vi.fn() }));
vi.mock('../src/scene/critic.ts', () => ({ addsPerson: () => false, critique: vi.fn(async () => ({ issues: [] })), paintedPeople: vi.fn(async () => []), repaint: vi.fn(async (_m, _p, painting) => painting) }));
vi.mock('../src/scene/brief.ts', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/scene/brief.ts')>(), writeBrief: vi.fn(async () => brief) }));
import { askSparkJson } from '../src/meta/spark.ts';
import { museEdit } from '../src/meta/muse.ts';
import { Memo } from '../src/meta/memo.ts';
import { alignPainting, PaintedLayout, PaintingLayoutError, paintedLayoutIssues, paintingLayoutHash, type PaintedLayout as Seen } from '../src/scene/paint-layout.ts';
import { Layout } from '../src/scene/layout.ts';
import { Place } from '../src/world/schema.ts';
import { registry } from '../src/registry.ts';
import '../src/commands/paint.ts';
import '../src/commands/masks.ts';

const place: Place = { key: 'pier', shows: 'a pier with stairs and a moored boat', mood: 'night', exits: [], things: [
  { key: 'boat', role: 'prop', looks: 'a small blue boat' },
  { key: 'can', role: 'item', looks: 'an oil can on the deck' },
  { key: 'stairs', role: 'exit', looks: 'stairs up to the market' },
] };
const layout: Layout = { horizon: 340, sky: '#112233', ground: '#445566', lights: [],
  floors: [
    { key: 'pier', is: 'pier planks', colour: '#665544', outline: [[0, 896], [1200, 896], [1040, 620], [160, 620]] },
    { key: 'steps', is: 'stone stairs', colour: '#888888', outline: [[130, 620], [300, 620], [280, 430], [150, 430]] },
  ],
  things: [
    { key: 'boat', colour: '#224488', x: 365, footY: 610, width: 200, height: 90, metres: 1 },
    { key: 'can', colour: '#ddaa44', x: 365, footY: 612, width: 40, height: 40, metres: 0.3 },
    { key: 'stairs', colour: '#888888', x: 215, footY: 440, width: 150, height: 130, metres: 1 },
  ],
};
const brief = { looks: { boat: 'a small blue boat', can: 'an oil can', stairs: 'market stairs', pier: 'wooden planks', steps: 'stone treads' }, alive: [] };
const passing = (): Seen => ({ horizon: 345, people: false,
  things: [
    { key: 'boat', box: [264, 518, 466, 614], approach: true, why: 'at the pier edge' },
    { key: 'can', box: [346, 571, 385, 614], approach: true, why: 'within reach from the pier' },
    { key: 'stairs', box: [139, 308, 291, 442], approach: true, why: 'joins the pier' },
  ],
  floors: layout.floors.map((f) => ({ key: f.key, coverage: 0.9, connected: true, reachesEdges: true, why: 'continuous solid surface at planned position' })),
});
const drifted = (): Seen => {
  const s = passing();
  s.horizon = 104;
  s.things[1] = { ...s.things[1], box: [287, 376, 342, 439], approach: false, why: 'can on a boat beyond water' };
  s.floors[1] = { ...s.floors[1], coverage: 0.03, connected: false, why: 'stairs moved away from the pier' };
  return s;
};
let dir: string, original: Buffer, repaired: Buffer, plan: Buffer;
const cwd = process.cwd();
beforeEach(async () => {
  vi.clearAllMocks();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-paint-layout-'));
  const png = (background: string) => sharp({ create: { width: 1200, height: 896, channels: 3, background } }).png().toBuffer();
  [original, repaired, plan] = await Promise.all([png('#445566'), png('#556677'), png('#223344')]);
  vi.mocked(museEdit).mockResolvedValue(repaired);
});
afterEach(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); });

test('harbour regression: displaced can, broken stairs and camera fail despite every object being present', () => {
  const errors = paintedLayoutIssues(place, layout, drifted());
  expect(errors).toEqual(expect.arrayContaining([
    expect.stringContaining('camera horizon moved'), expect.stringContaining('can: moved'),
    expect.stringContaining('can: no usable approach'), expect.stringContaining('steps: only 3%'), expect.stringContaining('steps: its planned connection'),
  ]));
  expect(paintedLayoutIssues(place, layout, passing())).toEqual([]);
});

test('source binding allows removing a decorative click target, but not moving story targets or changing pixels', () => {
  const hash = paintingLayoutHash(place, layout, plan, original);
  expect(paintingLayoutHash({ ...place, things: place.things.filter((t) => t.key !== 'boat') }, layout, plan, original)).toBe(hash);
  expect(paintingLayoutHash({ ...place, things: place.things.filter((t) => t.key !== 'can') }, layout, plan, original)).not.toBe(hash);
  expect(paintingLayoutHash(place, layout, plan, repaired)).not.toBe(hash);
});

test('missing/duplicate observations and a cut-off frame route cannot pass', () => {
  const s = passing(); s.things.pop(); s.floors.push(s.floors[1]); s.floors[0].reachesEdges = false;
  expect(paintedLayoutIssues(place, layout, s)).toEqual(expect.arrayContaining([
    expect.stringContaining('stairs: comparison'), expect.stringContaining('steps: comparison'), expect.stringContaining('pier: the planned route'),
  ]));
  const missing = passing(); missing.things[1].box = null;
  expect(paintedLayoutIssues(place, layout, missing)).toContain('can: not painted; within reach from the pier');
  expect(PaintedLayout.safeParse({ ...passing(), things: [{ key: 'can', box: [500, 600, 300, 400], approach: true, why: '' }] }).success).toBe(false);
  expect(paintedLayoutIssues(place, layout, { ...passing(), people: true })).toContain('unwanted people painted into the background; the game adds its cast separately');
});

test('a mismatch is repaired using BOTH images and measured problems, then checked again', async () => {
  vi.mocked(askSparkJson).mockResolvedValueOnce(drifted()).mockResolvedValueOnce(passing());
  const result = await alignPainting(new Memo(dir), place, layout, plan, original, brief, 0, ['keep the blue paint']);
  expect(result.painting).toEqual(repaired); expect(result.attempts).toHaveLength(2);
  expect(askSparkJson).toHaveBeenCalledTimes(2);
  const call = vi.mocked(museEdit).mock.calls[0][1];
  expect(call.images).toEqual([plan, original]);
  expect(call.prompt).toContain('can: moved'); expect(call.prompt).toContain('keep the blue paint');
  expect(call.prompt).toContain('polygon [[130,620]');
});

test('an unsuccessful repair terminates with actionable diagnostics; a passing image costs no edit', async () => {
  vi.mocked(askSparkJson).mockResolvedValue(drifted());
  await expect(alignPainting(new Memo(dir), place, layout, plan, original, brief, 0)).rejects.toBeInstanceOf(PaintingLayoutError);
  expect(museEdit).toHaveBeenCalledTimes(1); expect(askSparkJson).toHaveBeenCalledTimes(2);
  vi.clearAllMocks(); vi.mocked(askSparkJson).mockResolvedValue(passing());
  expect((await alignPainting(new Memo(dir), place, layout, plan, original, brief, 0)).painting).toEqual(original);
  expect(museEdit).not.toHaveBeenCalled();
});

async function fixture() {
  const at = (...p: string[]) => path.join(dir, 'worlds', 'w', 'places', 'pier', ...p);
  fs.mkdirSync(at(), { recursive: true });
  fs.writeFileSync(path.join(dir, 'worlds', 'w', 'world.json'), JSON.stringify({ title: 'Pier', pitch: 'A walk along the harbour.', style: 'gouache on paper', start: 'pier', hero: { key: 'keeper', looks: 'a keeper in a yellow coat' }, places: [place] }));
  fs.writeFileSync(at('layout.json'), JSON.stringify(layout)); fs.writeFileSync(at('blockin.png'), plan);
  process.chdir(dir);
  return at;
}

test('paint command retains the old painting on rejection and masks stops before calls', async () => {
  const at = await fixture(); fs.writeFileSync(at('painting.png'), original);
  vi.mocked(askSparkJson).mockResolvedValue(drifted());
  await expect(registry.get('paint')!.run(['w'])).rejects.toThrow('PAINT_LAYOUT_MISMATCH');
  expect(fs.readFileSync(at('painting.png'))).toEqual(original);
  expect(JSON.parse(fs.readFileSync(at('painting-layout.json'), 'utf8'))).toMatchObject({ ok: false, attempts: [{}, {}] });
  vi.clearAllMocks();
  await expect(registry.get('masks')!.run(['w'])).rejects.toThrow('rebuild this place from paint');
  expect(askSparkJson).not.toHaveBeenCalled();
});

test('accepted report is reusable without a model call and becomes invalid after a layout edit', async () => {
  const at = await fixture(); vi.mocked(askSparkJson).mockResolvedValue(passing());
  await registry.get('paint')!.run(['w']);
  const image = fs.readFileSync(at('painting.png'));
  expect(JSON.parse(fs.readFileSync(at('painting-layout.json'), 'utf8'))).toMatchObject({ ok: true, inputs: paintingLayoutHash(Place.parse(place), Layout.parse(layout), plan, image) });
  vi.clearAllMocks(); await registry.get('paint')!.run(['w']);
  expect(askSparkJson).not.toHaveBeenCalled(); expect(museEdit).not.toHaveBeenCalled();
  fs.writeFileSync(at('layout.json'), JSON.stringify({ ...layout, horizon: 360 }));
  await expect(registry.get('masks')!.run(['w'])).rejects.toThrow('PAINT_LAYOUT_MISMATCH');
  expect(askSparkJson).not.toHaveBeenCalled();
});

test('photo places retain the photo flow without a synthetic-layout comparison', async () => {
  const at = await fixture(); fs.writeFileSync(at('photo.png'), plan);
  await registry.get('paint')!.run(['w']);
  expect(askSparkJson).not.toHaveBeenCalled();
  expect(fs.existsSync(at('painting-layout.json'))).toBe(false);
});
