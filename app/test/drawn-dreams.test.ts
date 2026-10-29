// What the drawn-dreams build (a class's worth of children's drawings) showed: lines with sums, a busy transcriber,
// rejected ambience replayed from the shared cache, a job that said "verify" while models were still made.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { inputHash, Memo } from '../src/meta/memo.ts';
import { retakePrompt, hissy } from '../src/sound/make.ts';
import { loopProblem, RATE } from '../src/sound/pcm.ts';
import { numberWords, spokenText } from '../src/sound/spoken.ts';
import { heardOk, spokenMatch } from '../src/sound/voices.ts';
import { Jobs, type Job } from '../src/studio/jobs.ts';

const LINE = 'Na tablicy jest 10+10=20. Ale jest szara i smutna.';

test('a sum is read and checked as it is said', () => {
  expect(spokenText(LINE, 'Polish')).toBe('Na tablicy jest dziesięć plus dziesięć równa się dwadzieścia. Ale jest szara i smutna.');
  expect(spokenText('3 × 4 = 12 and 7-3=4', 'English')).toBe('three times four equals twelve and seven minus three equals four');
  // A dash between words, a time and a decimal are left to the actor.
  expect(spokenText('Godzina 10:30, waga 3.5 kg - koniec', 'Polish')).toBe('Godzina 10:30, waga 3.5 kg - koniec');
  expect(spokenText('22 000 i 1000', 'Polish')).toBe('dwadzieścia dwa tysiące i tysiąc');
  expect(numberWords(spokenText(LINE, 'Polish'), 'Polish')).toEqual(['dziesięć', 'dziesięć', 'dwadzieścia']);
});

test('a take saying the sum in words passes; another number fails however close the letters', () => {
  const said = spokenText(LINE, 'Polish');
  const good = spokenMatch(LINE, 'Na tablicy jest dziesięć plus dziesięć równa się dwadzieścia, ale jest szara i smutna.', 'Polish');
  expect(heardOk(said, good)).toBe(true);
  // A transcriber writing digits is read as words too.
  expect(heardOk(said, spokenMatch(LINE, 'Na tablicy jest 10 plus 10 równa się 20, ale jest szara i smutna', 'Polish'))).toBe(true);
  expect(heardOk(said, spokenMatch(LINE, 'Na tablicy jest dziesięć plus dziesięć równa się trzydzieści, ale jest szara i smutna.', 'Polish'))).toBe(false);
});

test('a forgotten take is gone from the cache every world shares, so the next run asks again', async () => {
  const cache = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-cache-'));
  const was = process.env.DIORAMA_CACHE;
  process.env.DIORAMA_CACHE = cache;
  try {
    const memo = new Memo(fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-memo-')));
    let asked = 0;
    const ask = async () => Buffer.from(`take ${++asked}`);
    const hash = inputHash('sfx', 'meadow');
    await memo.remember('sound', 'bed-1', hash, 'mp3', ask);
    memo.forget('sound', hash, 'mp3');
    expect(String(await memo.remember('sound', 'bed-1', hash, 'mp3', ask))).toBe('take 2');
  } finally {
    if (was === undefined) delete process.env.DIORAMA_CACHE;
    else process.env.DIORAMA_CACHE = was;
  }
});

test('crickets are not hiss, white noise is; a quiet room hum is a bed, not silence', () => {
  const n = RATE * 3;
  let seed = 3;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5) * 2;
  const of = (f: (t: number) => number) => { const l = Float32Array.from({ length: n }, (_, i) => f(i / RATE)); return { left: l, right: l }; };
  const crickets = of((t) => 0.1 * Math.sin(2 * Math.PI * 4500 * t) * ((t % 0.6) < 0.3 ? 1 : 0) + 0.03 * rnd());
  expect(hissy(crickets)).toBe(false);
  expect(hissy(of(() => 0.1 * rnd()))).toBe(true);
  expect(retakePrompt('Quiet bedroom, soft hum', 2, 'nearly silent')).not.toMatch(/no hiss/);
  const hum = { left: Float32Array.from({ length: n }, (_, i) => 0.002 * Math.sin(2 * Math.PI * 110 * i / RATE)), right: new Float32Array(n) };
  hum.right.set(hum.left);
  expect(loopProblem(hum)).toBeUndefined();
  expect(retakePrompt('Meadow', 2, 'mostly hiss')).toMatch(/no hiss/);
});

test('a job lists every step running at once, and a failed one says where it broke', () => {
  const jobs = new Jobs({ publish: () => {} } as never, { bin: '/bin/true' });
  const job: Job = { id: 'x', world: 'w', label: 'build', args: [], by: 'you', state: 'running', queuedAt: '', tail: [] };
  const line = (data: object) => (jobs as unknown as { line(j: unknown, s: string, l: string): void }).line(job, 'out', `@@diorama ${JSON.stringify(data)}`);
  line({ type: 'step.start', step: 'model' });
  line({ type: 'step.start', step: 'verify' });
  expect(job.steps).toEqual(['model', 'verify']);
  expect(job.step).toBe('model + verify');
  line({ type: 'step.end', step: 'verify' });
  expect(job.step).toBe('model');
  line({ type: 'step.fail', step: 'model', error: 'flat' });
  expect(job.step).toBe('model');
  expect(job.steps).toEqual([]);
});
