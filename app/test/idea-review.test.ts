import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import '../src/actions/idea-review.ts';
import '../src/actions/start.ts';
import { runAction, type ActionContext } from '../src/actions/registry.ts';
import { askSparkJson } from '../src/meta/spark.ts';
import { Events } from '../src/studio/events.ts';
import { CreativeChoices, refinedIdea } from '../src/world/idea-review.ts';
import { drawingsBrief, KIDS_STYLE } from '../src/world/drawings.ts';

vi.mock('../src/meta/spark.ts', () => ({ askSparkJson: vi.fn() }));
const ask = vi.mocked(askSparkJson);
const review = { understanding: 'Smok szuka domu.', questions: [{ question: 'Czyj to klucz?', why: 'Ustali cel zadania.', options: ['Smoka', 'Sowy'] }], styles: [{ title: 'Rysunek ołówkiem', description: 'Cienka czarna kreska na jasnym tle, zachowaj dziecięce proporcje.' }] };
let root: string, ctx: ActionContext;
const start = vi.fn();
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-review-'));
  ctx = { root, by: 'user', events: new Events(), jobs: { start } } as unknown as ActionContext;
  ask.mockReset(); start.mockReset(); start.mockResolvedValue({ id: 'test-job' });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

test('review examines photos and saved video evidence without building or changing source material', async () => {
  const id = 'b'.repeat(32), dir = path.join(root, '.start', 'videos', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'upload.json'), JSON.stringify({ name: 'kitchen.mp4', size: 6, received: 6, duration: 40 }));
  for (let i = 0; i < 2; i++) fs.writeFileSync(path.join(dir, `part-${i}.json`), JSON.stringify({ reading: { observations: 'Unclear which drawing owns the key' }, speech: { text: 'To jego klucz' } }));
  const before = fs.readFileSync(path.join(dir, 'part-1.json'), 'utf8');
  const data = (await sharp({ create: { width: 12, height: 12, channels: 3, background: 'white' } }).png().toBuffer()).toString('base64');
  ask.mockResolvedValue({ ...review, questions: [{ ...review.questions[0], photo: 0, video: { id, seconds: 30 } }] });
  const result = await runAction('idea_review', { idea: 'Smok szuka domu', photos: [{ name: 'key.png', data }], videos: [id], places: 3, language: 'Polish' }, ctx);
  expect(result).toMatchObject({ questions: [{ photo: 0, video: { seconds: 30 } }] });
  const request = ask.mock.calls[0][1];
  expect(request.images).toHaveLength(1); expect(request.personal).toBe(true);
  expect(request.prompt).toContain('To jego klucz'); expect(request.prompt).toContain('kitchen.mp4');
  expect(request.prompt).toContain('"places":3');
  expect(start).not.toHaveBeenCalled();
  expect(fs.readdirSync(root)).toEqual(['.start']);
  expect(fs.readFileSync(path.join(dir, 'part-1.json'), 'utf8')).toBe(before);
});

test('an already clear brief can return no questions or style changes', async () => {
  ask.mockResolvedValue({ understanding: 'All clear.', questions: [], styles: [] });
  expect(await runAction('idea_review', { idea: 'A blue pencil dragon brings a letter home.' }, ctx)).toMatchObject({ questions: [], styles: [] });
  expect(start).not.toHaveBeenCalled();
});

test('follow-ups receive the answer and cannot repeat the same question', async () => {
  const choices = { answers: [{ question: review.questions[0].question, answer: 'Sowy' }] };
  ask.mockResolvedValueOnce(review).mockResolvedValueOnce({ ...review, questions: [] });
  expect(await runAction('idea_review', { idea: 'Smok szuka domu', choices }, ctx)).toMatchObject({ questions: [] });
  expect(ask.mock.calls[0][1].prompt).toContain(JSON.stringify(choices));
  expect(ask.mock.calls[1][1].prompt).toContain('already answered');
  expect(start).not.toHaveBeenCalled();
});

test('invalid references get one correction then a skippable failure, never a build', async () => {
  ask.mockResolvedValue({ ...review, questions: [{ ...review.questions[0], photo: 3, video: { id: 'invented', seconds: 30 } }] });
  await expect(runAction('idea_review', { idea: 'Smok szuka domu' }, ctx)).rejects.toThrow('skip and build');
  expect(ask).toHaveBeenCalledTimes(2);
  expect(ask.mock.calls[1][1].prompt).toContain('photo not supplied');
  expect(start).not.toHaveBeenCalled();
  ask.mockResolvedValue({ understanding: 'All clear.', questions: [], styles: [] });
  await runAction('idea_review', { idea: 'Smok szuka domu' }, ctx);
  expect(ask.mock.calls[2][1].prompt).toContain('Fresh review after 1 rejected batches');
});

test('an unfinished movie never triggers a paid review', async () => {
  const id = 'b'.repeat(32), dir = path.join(root, '.start', 'videos', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'upload.json'), JSON.stringify({ name: 'kitchen.mp4', size: 6, received: 6, duration: 40 }));
  await expect(runAction('idea_review', { idea: 'Smok szuka domu', videos: [id] }, ctx)).rejects.toThrow('Finish interpreting');
  expect(ask).not.toHaveBeenCalled();
});

test('visual options must map to real input pictures and keep their option order', async () => {
  ask.mockResolvedValueOnce({ ...review, questions: [{ ...review.questions[0], visuals: [{ scene: 'an owl', photo: 99 }] }] })
    .mockResolvedValueOnce({ ...review, questions: [{ ...review.questions[0], visuals: [{ scene: 'a dragon' }, { scene: 'an owl' }] }] });
  const got = await runAction('idea_review', { idea: 'Smok szuka domu' }, ctx);
  expect(got).toMatchObject({ questions: [{ visuals: [{ scene: 'a dragon' }, { scene: 'an owl' }] }] });
  expect(ask.mock.calls[1][1].prompt).toContain('one visual per option');
  expect(ask.mock.calls[1][1].prompt).toContain('photo not supplied');
});

test('only creator choices are retained and reach both classification and the build job', async () => {
  ask.mockResolvedValue({ title: 'Dom smoka', slug: 'dragon-home', places: 3, language: 'Polish' });
  const idea = 'Smok szuka domu';
  const choices = { answers: [{ question: 'Czyj to klucz?', answer: 'Sowy' }], style: review.styles[0].description, note: 'Bez walki.' };
  await runAction('world_new', { idea, choices }, ctx);
  const brief = start.mock.calls[0][1][2];
  expect(brief).toContain(idea); expect(brief).toContain('Sowy'); expect(brief).toContain('Bez walki.'); expect(brief).toContain(choices.style);
  expect(ask.mock.calls[0][1].prompt).toContain(brief);
  expect(JSON.parse(fs.readFileSync(path.join(root, 'dragon-home', 'creative-brief.json'), 'utf8'))).toEqual({ idea, choices });
  expect(refinedIdea(idea)).toBe(idea);
  expect(refinedIdea(idea, { answers: [] })).toBe(idea);
  expect(CreativeChoices.safeParse({ answers: [{ question: 'Who?', answer: '   ' }] }).success).toBe(false);
});

test('a chosen drawing style replaces the hardcoded crayon instruction without dropping drawing fidelity', () => {
  expect(drawingsBrief([])).toContain(KIDS_STYLE);
  const brief = drawingsBrief([{ file: 'key.png', key: 'key', kind: 'item', looks: 'a long crooked key' }], review.styles[0].description);
  expect(brief).not.toContain(KIDS_STYLE);
  expect(brief).toContain(review.styles[0].description);
  expect(brief).toContain('looking as drawn'); expect(brief).toContain('a long crooked key');
});
