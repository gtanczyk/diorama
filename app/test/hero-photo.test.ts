import sharp from 'sharp';
import { expect, test } from 'vitest';
import type { Memo } from '../src/meta/memo.ts';
import { notStanding, photoStandPrompt } from '../src/scene/cast.ts';
import { poseWords } from '../src/scene/photo.ts';
import type { World } from '../src/world/schema.ts';

test('looks that describe the photo, not the person, are caught', () => {
  const bed = 'Adult man seen from chest up lying back against a headboard, short dark hair, dark navy crew-neck t-shirt, lower body, pants and shoes are not visible in the photo';
  expect(poseWords(bed)).toEqual(expect.arrayContaining(['chest up', 'lying', 'headboard', 'not visible', 'in the photo']));
  expect(poseWords('a stocky man with short dark hair, a navy sweatshirt, dark grey jeans and black trainers')).toEqual([]);
});

test('a hero painted from a sitting photo is painted standing, with nothing they sat on', () => {
  const p = photoStandPrompt({ style: 'gouache' } as World, { key: 'dev', looks: 'navy sweatshirt, grey jeans, black trainers' });
  expect(p).toMatch(/standing upright on both feet/);
  expect(p).toMatch(/no bed, headboard/);
  expect(p).toContain('grey jeans');
});

const figure = (w: number, h: number) => sharp({ create: { width: w, height: h, channels: 4, background: { r: 20, g: 20, b: 60, alpha: 1 } } }).png().toBuffer();
const noCalls = { remember: () => { throw new Error('no Spark call expected'); } } as unknown as Memo;

test('a tall cut-out counts as standing without asking Spark', async () => {
  expect(await notStanding(noCalls, 'dev', await figure(280, 600))).toBeUndefined();
});

test('a squat cut-out is looked at, and a seated one is named', async () => {
  const asked: string[] = [];
  const memo = { remember: async (_k: string, label: string) => (asked.push(label), Buffer.from('{"standing": false, "why": "sitting with knees up"}')) } as unknown as Memo;
  expect(await notStanding(memo, 'dev', await figure(800, 600))).toBe('sitting with knees up');
  expect(asked).toEqual(['figure-standing:dev#0']);
});
