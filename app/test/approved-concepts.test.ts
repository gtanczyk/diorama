import sharp from 'sharp';
import { expect, test, vi } from 'vitest';
vi.mock('../src/meta/muse.ts', () => ({ museEdit: vi.fn(), musePaint: vi.fn() }));
vi.mock('../src/meta/sam.ts', () => ({ samFind: vi.fn() }));
vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
import { museEdit, musePaint } from '../src/meta/muse.ts';
import { samFind } from '../src/meta/sam.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { Memo } from '../src/meta/memo.ts';
import { paintFigure } from '../src/scene/cast.ts';
import { paintPlace } from '../src/scene/paint.ts';
import { paintPhoto } from '../src/scene/photo.ts';
import type { World } from '../src/world/schema.ts';
import { layOut, type Layout } from '../src/scene/layout.ts';

/** An oval figure, not a full box: a cut-out filling its whole box is painted again (cast.ts boxed). */
const figureMask = (width: number, height: number) => ({ width, height, bits: Uint8Array.from({ length: width * height }, (_, i) => (((i % width) + 0.5 - width / 2) / (width / 2)) ** 2 + ((Math.floor(i / width) + 0.5 - height / 2) / (height / 2)) ** 2 <= 1 ? 1 : 0) });
const world: World = { title: 'Home', pitch: 'An owl brings a letter home', style: 'Pencil lines on paper', start: 'home', hero: { key: 'owl', looks: 'A round owl with big eyes' }, places: [{ key: 'home', shows: 'A little wooden house', mood: 'sunny', things: [{ key: 'owl', role: 'npc', looks: 'A round owl' }], exits: [] }] };
test('production painters receive approved references alongside original sources, while retaining layout constraints', async () => {
  const png = await sharp({ create: { width: 24, height: 32, channels: 4, background: '#aa88bb' } }).png().toBuffer();
  const source = await sharp(png).tint('green').png().toBuffer();
  const concept = await sharp(png).tint('red').png().toBuffer();
  vi.mocked(museEdit).mockReset().mockResolvedValue(png); vi.mocked(musePaint).mockReset();
  vi.mocked(samFind).mockResolvedValue([{ mask: figureMask(24, 32), score: 1 }] as any);
  const memo = new Memo('/tmp/unused-mocked-concepts');
  await paintFigure(memo, world, world.hero, 0, { drawing: source, concept });
  expect(vi.mocked(museEdit).mock.calls[0][1]).toMatchObject({ images: [source, concept], prompt: expect.stringContaining('creator-approved character') });
  expect(musePaint).not.toHaveBeenCalled();
  const layout: Layout = { horizon: 300, sky: '#ffffff', ground: '#eeeeee', floors: [{ key: 'yard', is: 'grass', colour: '#00aa00', outline: [[0, 896], [0, 400], [1200, 400], [1200, 896]] }], things: [], lights: [] };
  await paintPlace(memo, world, world.places[0], layout, png, undefined, 0, [{ key: 'home', image: source }], concept);
  expect(vi.mocked(museEdit).mock.calls[1][1]).toMatchObject({ images: [png, source, concept], prompt: expect.stringContaining('FIRST image remains the authoritative layout') });
  await paintPhoto(memo, world, world.places[0], source, undefined, 0, concept);
  expect(vi.mocked(museEdit).mock.calls[2][1]).toMatchObject({ images: [source, concept], prompt: expect.stringContaining('first photo is authoritative') });
});

test('layout uses the approved composition but still repairs invalid walkable floors; a real photo remains authoritative', async () => {
  const concept = Buffer.from('concept'), photo = Buffer.from('original-photo');
  const place = world.places[0];
  const good: Layout = { horizon: 300, sky: '#ffffff', ground: '#eeeeee', floors: [{ key: 'yard', is: 'grass', colour: '#00aa00', outline: [[0, 896], [0, 400], [1200, 400], [1200, 896]] }], things: [{ key: 'owl', colour: '#ffffff', x: 300, footY: 700, width: 60, height: 90, metres: 1 }], lights: [] };
  const bad = { ...good, horizon: 1000 };
  vi.mocked(askSparkJson).mockReset().mockResolvedValueOnce(bad).mockResolvedValue(good);
  const memo = new Memo('/tmp/unused-mocked-concepts');
  expect(await layOut(memo, world, place, undefined, undefined, concept)).toEqual(good);
  expect(vi.mocked(askSparkJson).mock.calls[0][1]).toMatchObject({ images: [concept], prompt: expect.stringContaining('creator-approved concept') });
  expect(vi.mocked(askSparkJson).mock.calls[1][1].prompt).toContain('horizon');
  await layOut(memo, world, place, photo, undefined, concept);
  expect(vi.mocked(askSparkJson).mock.calls[2][1].images).toEqual([photo]);
  expect(vi.mocked(askSparkJson).mock.calls[2][1].prompt).toContain('Do not place anything; measure');
});


test('style references reach cast and backgrounds without taking over approved composition or identity', async () => {
  const png = await sharp({ create: { width: 24, height: 32, channels: 4, background: '#5588cc' } }).png().toBuffer();
  const concept = await sharp(png).tint('green').png().toBuffer();
  const styleReference = await sharp(png).tint('red').png().toBuffer();
  vi.mocked(museEdit).mockReset().mockResolvedValue(png); vi.mocked(musePaint).mockReset();
  vi.mocked(samFind).mockResolvedValue([{ mask: figureMask(24, 32), score: 1 }] as any);
  const memo = new Memo('/tmp/unused-style-references');
  await paintFigure(memo, world, world.hero, 0, { concept, styleReference });
  expect(vi.mocked(museEdit).mock.calls[0][1]).toMatchObject({ images: [concept, styleReference], prompt: expect.stringContaining('second-to-last image is the creator-approved') });
  await paintFigure(memo, world, world.hero, 0, { styleReference });
  expect(vi.mocked(museEdit).mock.calls[1][1].images).toEqual([styleReference]);
  const layout: Layout = { horizon: 300, sky: '#ffffff', ground: '#eeeeee', floors: [{ key: 'yard', is: 'grass', colour: '#00aa00', outline: [[0, 896], [0, 400], [1200, 400], [1200, 896]] }], things: [], lights: [] };
  await paintPlace(memo, world, world.places[0], layout, png, undefined, 0, [{ key: 'home', image: png }], concept, styleReference);
  expect(vi.mocked(museEdit).mock.calls[2][1]).toMatchObject({ images: [png, png, styleReference, concept], prompt: expect.stringContaining('Image 3:') });
  await paintPhoto(memo, world, world.places[0], png, undefined, 0, concept, styleReference);
  expect(vi.mocked(museEdit).mock.calls[3][1].images).toEqual([png, concept, styleReference]);
  for (const [, args] of vi.mocked(museEdit).mock.calls) expect(args.prompt).toContain('STYLE reference only');
  expect(musePaint).not.toHaveBeenCalled();
});
