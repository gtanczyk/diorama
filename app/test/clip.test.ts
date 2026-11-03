import { describe, expect, it } from 'vitest';
import { audioPlan, clipSound, cropFor, pickShots, shotSeconds, shotStarts, type Take } from '../src/film/clip.ts';
import type { SoundData } from '../src/play/sound.ts';

// The paper-boat-storm run as the game take logged it: a floor click, then the route to the boat.
const game: Take = {
  duration: 47,
  place: 'quay',
  hero: Array.from({ length: 470 }, (_, i) => ({ t: i / 10, x: 600 + (i % 100) * 6 })),
  events: [
    { kind: 'click', t: 1.0, x: 1250, y: 950, place: 'quay' },
    { kind: 'click', t: 1.74, x: 1500, y: 700, place: 'quay', action: { kind: 'go', via: 'quay-steps' } },
    { kind: 'use', t: 4.2, thing: 'quay-steps' },
    { kind: 'exit', t: 6.0, from: 'quay', to: 'mill' },
    { kind: 'enter', t: 7.0, place: 'mill' },
    { kind: 'click', t: 9.34, x: 800, y: 600, place: 'mill', action: { kind: 'do', thing: 'mill-house', verb: 'take' } },
    { kind: 'use', t: 10.6, thing: 'mill-house' },
    { kind: 'say', t: 10.7, text: 'A lantern!', who: 'girl' },
    { kind: 'click', t: 17.87, x: 300, y: 800, place: 'mill', action: { kind: 'go', via: 'wooden-bridge' } },
    { kind: 'use', t: 19.5, thing: 'wooden-bridge' },
    { kind: 'exit', t: 20.0, from: 'mill', to: 'quay' },
    { kind: 'enter', t: 21.0, place: 'quay' },
    { kind: 'click', t: 23.55, x: 200, y: 500, place: 'quay', action: { kind: 'do', thing: 'lamp-post', verb: 'use', with: 'lantern' } },
    { kind: 'use', t: 29.5, thing: 'lamp-post' },
    { kind: 'say', t: 29.6, text: 'It glows.', who: 'girl' },
    { kind: 'click', t: 34.86, x: 900, y: 900, place: 'quay', action: { kind: 'do', thing: 'oar', verb: 'take' } },
    { kind: 'use', t: 36.0, thing: 'oar' },
    { kind: 'click', t: 40.04, x: 1300, y: 900, place: 'quay', action: { kind: 'go', via: 'boat' } },
    { kind: 'use', t: 41.5, thing: 'boat' },
    { kind: 'exit', t: 43.8, from: 'quay', to: 'rock' },
    { kind: 'enter', t: 44.8, place: 'rock' },
  ],
};
const end: Take = { duration: 12, place: 'rock', hero: [{ t: 1, x: 900 }], events: [{ kind: 'click', t: 1.2, x: 1300, y: 1150, place: 'rock' }] };
const input = { game, end, seconds: 25, firstPlace: 'quay', lastPlace: 'rock', caption: 'Send me your sketch.', explodeFirst: 6, explodeLast: 6 };

describe('pickShots', () => {
  const shots = pickShots(input);
  const total = shots.reduce((n, s) => n + shotSeconds(s), 0);

  it('opens 0.2 s before the first click, with the first place coming apart next', () => {
    expect(shots[0]).toMatchObject({ source: 'game', from: 0.8, to: 1.6 });
    expect(shots[1]).toMatchObject({ source: 'explode-first', place: 'quay', speed: 2 });
    expect(shotStarts(shots)[1]).toBeCloseTo(0.8, 5);
  });

  it('ends on the last place, then its explode under the end card', () => {
    expect(shots.at(-2)).toMatchObject({ source: 'end', place: 'rock' });
    expect(shots.at(-1)).toMatchObject({ source: 'explode-last', place: 'rock', caption: 'Send me your sketch.', hold: 0.4 });
  });

  it('keeps to the target length, with every place of the run in it', () => {
    expect(total).toBeLessThanOrEqual(25.05);
    expect(total).toBeGreaterThan(18);
    expect(new Set(shots.map((s) => s.place))).toEqual(new Set(['quay', 'mill', 'rock']));
  });

  it('cuts round each click, never into a fade, never overlapping', () => {
    const story = shots.filter((s) => s.source === 'game').slice(1);
    expect(story.length).toBeGreaterThanOrEqual(3);
    for (const [i, s] of story.entries()) {
      expect(s.to - s.from).toBeGreaterThanOrEqual(1.2);
      expect(s.to - s.from).toBeLessThanOrEqual(4.01);
      for (const [d0, d1] of [[6, 7.45], [20, 21.45], [43.8, 44.8 + 0.45]]) expect(s.to <= d0 || s.from >= d1).toBe(true);
      if (i > 0) expect(s.from).toBeGreaterThanOrEqual(story[i - 1].to);
    }
    // The lamp: a long walk after the click, so the shot is round the hero using it, not the cursor.
    const lamp = story.find((s) => s.why.includes('lamp-post'));
    if (lamp) expect(lamp.from).toBeGreaterThan(27);
    // The oar: the effect comes soon, so the shot starts half a second before the click.
    const oar = story.find((s) => s.why.includes('oar'));
    if (oar) expect(oar.from).toBeCloseTo(34.36, 2);
  });

  it('drops the least telling shots first when the target is short', () => {
    const short = pickShots({ ...input, seconds: 15 });
    expect(short.reduce((n, s) => n + shotSeconds(s), 0)).toBeLessThanOrEqual(15.6);
    expect(short.filter((s) => s.source === 'game').length).toBeLessThan(shots.filter((s) => s.source === 'game').length);
  });

  it('works without the explode takes: the end shot carries the caption', () => {
    const plain = pickShots({ ...input, explodeFirst: undefined, explodeLast: undefined });
    expect(plain.some((s) => s.source.startsWith('explode'))).toBe(false);
    expect(plain.at(-1)).toMatchObject({ source: 'end', caption: 'Send me your sketch.' });
  });
});

describe('cropFor', () => {
  it('keeps the 1080 crop inside the 2400 frame, round the hero and the click', () => {
    expect(cropFor(undefined)).toBe(660);
    expect(cropFor(0)).toBe(0);
    expect(cropFor(1920)).toBe(1320);
    expect(cropFor(960, 1100)).toBe(Math.round(((960 + 1100) / 2) * 1.25 - 540));
    // Too far apart to show both: the hero wins.
    expect(cropFor(200, 1800)).toBe(0);
  });
});

describe('audioPlan', () => {
  const sound: SoundData = {
    files: {
      'quay-bed': { file: 'sound/quay-bed.mp3', kind: 'bed', level: 2 },
      'mill-bed': { file: 'sound/mill-bed.mp3', kind: 'bed', level: 2 },
      'mill-waterfall': { file: 'sound/mill-waterfall.mp3', kind: 'loop', level: 3 },
      'mill-gate': { file: 'sound/mill-gate.mp3', kind: 'loop', level: 2 },
      music: { file: 'sound/music.mp3', kind: 'music', level: 2 },
    },
    music: 'music',
    places: {
      quay: { bed: 'quay-bed', loops: [], zones: [] },
      mill: { bed: 'mill-bed', loops: [{ id: 'mill-waterfall', thing: 'waterfall', level: 3, when: [] }, { id: 'mill-gate', thing: 'gate', level: 2, when: ['gate-open'] }], zones: [] },
    },
    shots: {},
    lines: { 'A lantern!': { file: 'sound/voice/a.mp3', seconds: 1.5, speaker: 'girl' }, 'It glows.': { file: 'sound/voice/b.mp3', seconds: 1.2, speaker: 'girl' } },
  };
  const shots = pickShots(input);
  const cues = audioPlan(shots, { game, end }, sound, 'sound/music.mp3');
  const starts = shotStarts(shots);
  const total = shots.reduce((n, s) => n + shotSeconds(s), 0);

  it('lays each place\'s bed under its run of shots, and its always-on loops', () => {
    const mill = shots.findIndex((s) => s.place === 'mill');
    const bed = cues.find((c) => c.file === 'sound/mill-bed.mp3')!;
    expect(bed).toMatchObject({ kind: 'bed', lufs: -26, loop: true });
    expect(bed.at).toBeCloseTo(starts[mill], 3);
    expect(cues.find((c) => c.file === 'sound/mill-waterfall.mp3')).toMatchObject({ kind: 'loop', gain: 0.9, at: bed.at, seconds: bed.seconds });
    // A loop that plays only in some state of the place is left out.
    expect(cues.some((c) => c.file === 'sound/mill-gate.mp3')).toBe(false);
    // The quay's shots before and after the mill are separate runs, each with its own bed.
    expect(cues.filter((c) => c.file === 'sound/quay-bed.mp3').length).toBeGreaterThanOrEqual(2);
  });

  it('places a voice where it was said in a shot, on the clip clock', () => {
    const mill = shots.findIndex((s) => s.place === 'mill' && s.from <= 10.7 && s.to > 10.7);
    const voice = cues.find((c) => c.file === 'sound/voice/a.mp3');
    if (mill < 0) expect(voice).toBeUndefined();
    else expect(voice).toMatchObject({ kind: 'voice', lufs: -17, at: Math.round((starts[mill] + 10.7 - shots[mill].from) * 1000) / 1000 });
    // Never two voices at once.
    const voices = cues.filter((c) => c.kind === 'voice').sort((a, b) => a.at - b.at);
    for (let i = 1; i < voices.length; i++) expect(voices[i].at).toBeGreaterThanOrEqual(voices[i - 1].at + voices[i - 1].seconds - 0.05);
  });

  it('runs the music the whole clip, fading out over the end card', () => {
    expect(cues.find((c) => c.kind === 'music')).toMatchObject({ file: 'sound/music.mp3', at: 0, lufs: -21, fadeOut: 2.2 });
    expect(cues.find((c) => c.kind === 'music')!.seconds).toBeCloseTo(total, 2);
  });

  it('is silent but for the music when the world has no sound', () => {
    expect(audioPlan(shots, { game, end }, undefined, 'm.mp3').map((c) => c.kind)).toEqual(['music']);
    expect(audioPlan(shots, { game, end }, undefined, undefined)).toEqual([]);
  });
});

describe('clipSound', () => {
  it('takes beds and loops from what was made, each loop to the longest place key it starts with', () => {
    const made = {
      'sea-bed': { file: 'sound/sea-bed.mp3', kind: 'bed', level: 2 },
      'sea-boat-loop': { file: 'sound/sea-boat-loop.mp3', kind: 'loop', level: 2 },
      'sea-2-bed': { file: 'sound/sea-2-bed.mp3', kind: 'bed', level: 2 },
      'sea-2-rock-loop': { file: 'sound/sea-2-rock-loop.mp3', kind: 'loop', level: 3 },
      music: { file: 'sound/music.mp3', kind: 'music', level: 2 },
    };
    const page: SoundData = { files: {}, places: { 'sea-2': { loops: [{ id: 'sea-2-rock-loop', thing: 'rock', level: 3, when: ['lit'] }], zones: [] } }, shots: {}, lines: { Hi: { file: 'v.mp3', seconds: 1 } } };
    const s = clipSound(page, made, ['sea', 'sea-2']);
    expect(s.music).toBe('music');
    expect(s.places.sea).toMatchObject({ bed: 'sea-bed', loops: [{ id: 'sea-boat-loop', thing: 'boat', level: 2, when: [] }] });
    expect(s.places['sea-2']).toMatchObject({ bed: 'sea-2-bed', loops: [{ id: 'sea-2-rock-loop', thing: 'rock', when: ['lit'] }] });
    expect(s.lines).toEqual(page.lines);
  });
});
