import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import '../src/actions/idea-preview.ts';
import { runAction, type ActionContext } from '../src/actions/registry.ts';
import { museEdit, musePaint } from '../src/meta/muse.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { styleReferencePath, worldStyleReference } from '../src/world/style-reference.ts';
import { seedIdea } from '../src/actions/start.ts';
import { WorldFiles } from '../src/world/files.ts';
import { Events } from '../src/studio/events.ts';

vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
vi.mock('../src/meta/muse.ts', () => ({ museEdit: vi.fn(), musePaint: vi.fn() }));
let root: string, ctx: ActionContext, png: Buffer;
const start = vi.fn();
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-idea-preview-'));
  ctx = { root, by: 'user', events: new Events(), jobs: { start } } as unknown as ActionContext;
  png = await sharp({ create: { width: 120, height: 90, channels: 3, background: 'white' } }).png().toBuffer();
  vi.mocked(askSparkJson).mockReset();
  vi.mocked(musePaint).mockReset().mockResolvedValue(png); vi.mocked(museEdit).mockReset().mockResolvedValue(png); start.mockClear();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('concept previews are bounded thumbnails, deduplicate in flight and never start a build', async () => {
  const input = { idea: 'A night market', scene: 'A lantern keeper holding an unlit lantern' };
  const results = await Promise.all([runAction('idea_preview', input, ctx), runAction('idea_preview', input, ctx)]) as Array<{ image: string }>;
  expect(musePaint).toHaveBeenCalledTimes(1); expect(museEdit).not.toHaveBeenCalled();
  expect(results[0]).toEqual(results[1]);
  const meta = await sharp(Buffer.from(results[0].image.split(',')[1], 'base64')).metadata();
  expect(meta).toMatchObject({ width: 480, height: 360, format: 'jpeg' });
  expect(vi.mocked(musePaint).mock.calls[0][1].prompt).toContain(input.scene);
  expect(start).not.toHaveBeenCalled();
});

test('style comparisons use the same subject and original references', async () => {
  const input = { idea: 'A night market', scene: 'A lantern keeper holding an unlit lantern', references: [png.toString('base64')] };
  for (const style of ['pencil on paper', 'paper cutouts']) await runAction('idea_preview', { ...input, style }, ctx);
  expect(museEdit).toHaveBeenCalledTimes(2); expect(musePaint).not.toHaveBeenCalled();
  const requests = vi.mocked(museEdit).mock.calls.map(([, request]) => request);
  for (const request of requests) { expect(request.images).toHaveLength(1); expect(request.prompt).toContain(input.scene); }
  expect(requests[0].prompt).toContain('pencil on paper'); expect(requests[1].prompt).toContain('paper cutouts');
});

test('a painter outage is retryable and does not create a world', async () => {
  vi.mocked(musePaint).mockRejectedValueOnce(new Error('outage'));
  const input = { idea: 'A night market', scene: 'A keeper' };
  await expect(runAction('idea_preview', input, ctx)).rejects.toThrow('outage');
  await expect(runAction('idea_preview', input, ctx)).resolves.toHaveProperty('image');
  expect(start).not.toHaveBeenCalled();
});


test('a creator-written style stays verbatim and needs no interpretation call', async () => {
  const words = 'Blue pencil on grainy paper; warm lanterns, no gradients.';
  expect(await runAction('idea_style', { words }, ctx)).toEqual({ title: 'Your style', description: words });
  expect(await runAction('idea_style', { words: 'anime' }, ctx)).toMatchObject({ description: 'Visual style: anime' });
  await expect(runAction('idea_style', { words: '   ' }, ctx)).rejects.toThrow();
  expect(askSparkJson).not.toHaveBeenCalled(); expect(musePaint).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
});

test('a style reference is separate from story pictures, retained for a build and superseded by a restyle', async () => {
  const description = 'Cobalt ink on grainy paper with warm amber light.';
  vi.mocked(askSparkJson).mockResolvedValue({ title: 'Blue ink', description });
  const style = await runAction('idea_style', { words: 'Keep it cobalt blue', reference: { name: 'look.png', data: png.toString('base64') } }, ctx) as { reference: string };
  const saved = fs.readFileSync(styleReferencePath(root, style.reference));
  expect(vi.mocked(askSparkJson).mock.calls[0][1]).toMatchObject({ images: [saved], personal: true, prompt: expect.stringContaining('STYLE reference only') });
  await runAction('idea_preview', { idea: 'An owl on a tram', scene: 'An owl with a ticket', style: description, styleReference: style.reference, references: [png.toString('base64')] }, ctx);
  expect(vi.mocked(museEdit).mock.calls[0][1]).toMatchObject({ images: [expect.any(Buffer), saved], prompt: expect.stringContaining('LAST image is separate') });
  const files = new WorldFiles('blue-tram', root);
  seedIdea(files.dir, 'An owl on a tram', { answers: [], style: description, styleReference: style.reference }, [], [], { title: 'Blue tram', slug: 'blue-tram', places: 2, language: 'English' }, root);
  expect(worldStyleReference(files, description)).toEqual(saved);
  expect(worldStyleReference(files, 'Pastel chalk instead')).toBeUndefined();
  expect(fs.existsSync(files.path('drawings'))).toBe(false);
  expect(start).not.toHaveBeenCalled();
  await expect(runAction('idea_preview', { idea: '', scene: 'owl', styleReference: '../outside' }, ctx)).rejects.toThrow();
});
