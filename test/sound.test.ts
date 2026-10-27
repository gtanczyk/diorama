import { expect, test } from 'vitest';
import { placeSound, zoneAt } from '../src/play/sound.ts';
import { loopProblem, pitchHz, RATE, seamless, steps, type Pcm } from '../src/sound/pcm.ts';
import { planIssues, soundIds, type SoundPlan } from '../src/sound/plan.ts';
import { designDescriptions, heardMatch, heardOk, needsDesign, storyLines, voiceCandidates } from '../src/sound/voices.ts';
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

test('conversations, intro and endings are spoken; the hero\'s remarks on things only with all', () => {
  const world = { hero: { key: 'girl' } } as unknown as World;
  const story = {
    intro: 'Fog.', interactions: [{ say: 'A can.' }], locks: [], items: [{ key: 'can', name: 'can', nope: 'Cans open nothing.' }],
    dialogues: [{ npc: 'liss', lines: [{ says: 'Hello, love.', choices: [{ text: 'Hi.' }] }] }],
    endings: [{ text: 'Light.' }],
  } as unknown as Story;
  expect(storyLines(world, story)).toEqual([
    { speaker: 'narrator', text: 'Fog.' }, { speaker: 'girl', text: 'A can.' }, { speaker: 'liss', text: 'Hello, love.' },
    { speaker: 'girl', text: 'Hi.' }, { speaker: 'narrator', text: 'Light.' },
  ].filter((l) => l.text !== 'A can.'));
  expect(storyLines(world, story, true).map((l) => l.text)).toEqual(expect.arrayContaining(['A can.', 'Cans open nothing.']));
});

test('a short line may be two letters off, a long one 10%', () => {
  expect(heardOk('Tell me of fog.', heardMatch('Tell me of fog.', 'Tell me a fog.'))).toBe(true);
  expect(heardOk('Tell me of fog.', heardMatch('Tell me of fog.', 'Tell me.'))).toBe(false);
});

test('a voice is cast from who speaks: a boy never gets a woman or an old man, a child gets the youngest voices', () => {
  const v = (id: string, gender: string, age: string) => ({ voice_id: id, name: id, labels: { gender, age } });
  const stock = [v('old-man', 'male', 'old'), v('young-man', 'male', 'young'), v('mid-man', 'male', 'middle_aged'), v('young-woman', 'female', 'young'), v('river', 'neutral', 'middle_aged')];
  expect(voiceCandidates(stock, { gender: 'male', age: 'child', sound: '' }).map((x) => x.voice_id)).toEqual(['young-man']);
  expect(voiceCandidates(stock, { gender: 'female', age: 'old', sound: '' }).map((x) => x.voice_id)).toEqual(['river']);
  expect(voiceCandidates(stock, { gender: 'male', age: 'old', sound: '' }).map((x) => x.voice_id)).toEqual(['old-man']);
});

test('children and the old get a designed voice, described without the words ElevenLabs refuses', () => {
  const kid = { gender: 'female' as const, age: 'child' as const, sound: 'bright, 10-year-old, little child, eager' };
  expect(needsDesign(kid)).toBe(true);
  expect(needsDesign({ ...kid, age: 'middle_aged' })).toBe(false);
  const [d, plain] = designDescriptions(kid);
  expect(d).toMatch(/youthful high-pitched female/i);
  expect(d).not.toMatch(/child|girl|boy|\d|year|little/i);
  expect(d).toMatch(/eager/);
  expect(plain).not.toMatch(/eager/);
  expect(designDescriptions({ gender: 'male', age: 'old', sound: 'gravelly' })[0]).toMatch(/very old man.*gravelly/);
});

test('pitch is measured in Hz, so a designed child voice pitched like an adult is caught', () => {
  const voiced = (hz: number) => pcm((t) => 0.3 * Math.sin(2 * Math.PI * hz * t) + 0.1 * Math.sin(4 * Math.PI * hz * t), 1);
  expect(Math.abs(pitchHz(voiced(120)) - 120)).toBeLessThan(6);
  expect(Math.abs(pitchHz(voiced(300)) - 300)).toBeLessThan(15);
});

test('hiss: white noise is mostly hiss, a low tone is not; the low-pass takes the hiss off', async () => {
  const { hiss, lowpass, RATE } = await import('../src/sound/pcm.ts');
  const n = RATE;
  const noise = { left: new Float32Array(n).map(() => Math.random() - 0.5), right: new Float32Array(n).map(() => Math.random() - 0.5) };
  const tone = { left: new Float32Array(n).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / RATE)), right: new Float32Array(n).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / RATE)) };
  expect(hiss(noise)).toBeGreaterThan(1.5);
  expect(hiss(tone)).toBeLessThan(0.01);
  expect(hiss(lowpass(noise, 2500))).toBeLessThan(0.4);
});
