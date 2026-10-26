import { expect, test } from 'vitest';
import { placeSound, zoneAt } from '../src/play/sound.ts';
import { loopProblem, RATE, seamless, steps, type Pcm } from '../src/sound/pcm.ts';
import { planIssues, soundIds, type SoundPlan } from '../src/sound/plan.ts';
import { heardMatch, storyLines } from '../src/sound/voices.ts';
import type { Story } from '../src/story/schema.ts';
import type { World } from '../src/world/schema.ts';

const pcm = (fn: (t: number) => number, secs: number): Pcm => {
  const left = new Float32Array(Math.round(secs * RATE)).map((_, i) => fn(i / RATE));
  return { left, right: left.slice() };
};
const noise = (t: number) => 0.2 * Math.sin(t * 2 * Math.PI * 220) * (0.8 + 0.2 * Math.sin(t * 3));

test('a steady take loops; one event in silence does not', () => {
  expect(loopProblem(pcm(noise, 6))).toBeUndefined();
  expect(loopProblem(pcm((t) => (t < 0.5 ? noise(t) : 0.0005 * Math.sin(t * 999)), 6))).toMatch(/dies out|one event/);
  expect(loopProblem(pcm(() => 0, 6))).toBe('nearly silent');
});

test('seamless folds the tail over the head, so the end runs on into the start', () => {
  const ramp = pcm((t) => t / 10, 4);
  const loop = seamless(ramp, 1);
  expect(loop.left.length).toBe(3 * RATE);
  // The last sample before the wrap and the first after it continue the original take.
  const last = loop.left[loop.left.length - 1];
  expect(Math.abs(loop.left[0] - ramp.left[3 * RATE])).toBeLessThan(1e-3);
  expect(Math.abs(last - ramp.left[3 * RATE - 1])).toBeLessThan(1e-6);
});

test('footsteps are cut at their onsets', () => {
  const hits = [0.3, 1.1, 1.9, 2.7];
  const take = pcm((t) => {
    const h = hits.find((s) => t >= s && t < s + 0.15);
    return h === undefined ? 0 : 0.5 * Math.exp(-(t - h) * 30) * Math.sin(t * 2 * Math.PI * 180);
  }, 3.2);
  const cut = steps(take);
  expect(cut.length).toBe(4);
  cut.forEach(([start], i) => expect(Math.abs(start - hits[i])).toBeLessThan(0.04));
});

test('ids depend on what a sound is for, not on its prompt', () => {
  expect(soundIds.loop('fog-harbour', 'dock-lantern')).toBe('fog-harbour-dock-lantern-loop');
  expect(soundIds.shot('exit:cliff-path')).toBe('shot-exit-cliff-path');
  expect(soundIds.step('Wet Wood')).toBe('step-wet-wood');
});

test('the plan must cover every place, floor and noisy moving thing', () => {
  const world = { places: [{ key: 'dock', shows: 'a dock', mood: 'calm', things: [{ key: 'brazier', role: 'prop', looks: 'iron fire basket' }], exits: [] }] } as unknown as World;
  const plan: SoundPlan = { music: { prompt: 'slow harp' }, places: { dock: { bed: 'sea and wind', loops: [], floors: { boards: 'wood' } } }, steps: {}, shots: [] };
  const sources = { dock: { brief: { looks: {}, alive: [{ key: 'brazier', as: 'fire' as const }] }, layout: { floors: [{ key: 'boards' }, { key: 'sand' }] } as never } };
  expect(planIssues(plan, world, sources)).toEqual([
    'dock: surface "wood" of boards has no footsteps in steps',
    'dock: floor sand has no surface',
    'dock: brazier is fire but makes no sound',
  ]);
});

test('a loop pans to its side of the view and fades with distance, never to silence', () => {
  const near = placeSound(900, 600, 880, 600, 600, 1200, 200);
  const far = placeSound(900, 600, 100, 800, 600, 1200, 200);
  expect(near.pan).toBeCloseTo(0.5);
  expect(near.gain).toBeGreaterThan(0.95);
  expect(far.gain).toBeLessThan(0.5);
  expect(far.gain).toBeGreaterThanOrEqual(0.2);
  expect(zoneAt(['..1', '0.1'], 10, 25, 5)).toBe(1);
  expect(zoneAt(['..1', '0.1'], 10, 15, 15)).toBe(-1);
});

test('a heard line matches by letters, so spelling and spacing cost little and missing words a lot', () => {
  expect(heardMatch('Open trapdoor to the harbour.', 'open trap door to the harbor')).toBeGreaterThan(0.95);
  expect(heardMatch('Fill your can from my barrel behind the crates.', 'Fill your can.')).toBeLessThan(0.5);
});

test('every story line has a speaker: NPC lines are theirs, choices and actions the hero, intro and endings the narrator', () => {
  const world = { hero: { key: 'girl' } } as unknown as World;
  const story = {
    intro: 'Fog.', interactions: [{ say: 'A can.' }], locks: [],
    dialogues: [{ npc: 'liss', lines: [{ says: 'Hello, love.', choices: [{ text: 'Hi.' }] }] }],
    endings: [{ text: 'Light.' }],
  } as unknown as Story;
  expect(storyLines(world, story)).toEqual([
    { speaker: 'narrator', text: 'Fog.' }, { speaker: 'girl', text: 'A can.' }, { speaker: 'liss', text: 'Hello, love.' },
    { speaker: 'girl', text: 'Hi.' }, { speaker: 'narrator', text: 'Light.' },
  ]);
});
