import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import '../src/actions/idea-preview.ts';
import { runAction, type ActionContext } from '../src/actions/registry.ts';
import { museEdit, musePaint } from '../src/meta/muse.ts';
import { Events } from '../src/studio/events.ts';

vi.mock('../src/meta/muse.ts', () => ({ museEdit: vi.fn(), musePaint: vi.fn() }));
let root: string, ctx: ActionContext, png: Buffer;
const start = vi.fn();
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-idea-preview-'));
  ctx = { root, by: 'user', events: new Events(), jobs: { start } } as unknown as ActionContext;
  png = await sharp({ create: { width: 120, height: 90, channels: 3, background: 'white' } }).png().toBuffer();
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
