import { describe, expect, it } from 'vitest';
import { audioPlan, clipSound, cropFor, explodeFrame, fillFrame, pickShots, shotSeconds, shotStarts, type Take } from '../src/film/clip.ts';
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
const input = { game, end, seconds: 38, firstPlace: 'quay', lastPlace: 'rock', caption: 'Send me your sketch.', explodes: { quay: 4, mill: 4, rock: 4 } };

describe('pickShots', () => {
  const shots = pickShots(input);
  const total = shots.reduce((n, s) => n + shotSeconds(s), 0);

  it('opens 0.2 s before the first click and lets the hero walk two seconds before the first place comes apart', () => {
    expect(shots[0]).toMatchObject({ source: 'game', from: 0.8, to: 3.0, place: 'quay' });
    expect(shots[1]).toMatchObject({ source: 'explode', place: 'quay', from: 0, to: 4, speed: 1 });
    expect(shotStarts(shots)[1]).toBeCloseTo(2.2, 5);
    expect(shots[2]).toMatchObject({ source: 'game', place: 'quay' });
  });

  it('puts an explode before the first shot of each later place, once a place', () => {
    const firstMill = shots.findIndex((s) => s.source === 'game' && s.place === 'mill');
    expect(firstMill).toBeGreaterThan(0);
    expect(shots[firstMill - 1]).toMatchObject({ source: 'explode', place: 'mill' });
    const story = shots.filter((s) => s.source === 'explode' && s.place !== 'rock').map((s) => s.place);
    expect(story).toEqual(['quay', 'mill']);
    // Back on the quay: no second quay explode.
    const back = shots.findIndex((s, i) => i > firstMill && s.source === 'game' && s.place === 'quay');
    if (back > 0) expect(shots[back - 1].source).toBe('game');
  });

  it('ends on the last place after its explode, then its explode again under the end card', () => {
    expect(shots.at(-3)).toMatchObject({ source: 'explode', place: 'rock' });
    expect(shots.at(-2)).toMatchObject({ source: 'end', place: 'rock' });
    expect(shots.at(-1)).toMatchObject({ source: 'explode', place: 'rock', from: 0, to: 4, speed: 1, caption: 'Send me your sketch.', hold: 0.5 });
  });

  it('keeps to the target length, explodes whole, with every place of the run in it', () => {
    expect(total).toBeLessThanOrEqual(38.05);
    expect(total).toBeGreaterThan(32);
    for (const s of shots.filter((s) => s.source === 'explode')) expect(shotSeconds(s)).toBeGreaterThanOrEqual(4);
    expect(new Set(shots.map((s) => s.place))).toEqual(new Set(['quay', 'mill', 'rock']));
  });

  it('cuts round each click, never into a fade, never overlapping', () => {
    const story = shots.filter((s) => s.source === 'game').slice(1);
    expect(story.length).toBeGreaterThanOrEqual(3);
    for (const [i, s] of story.entries()) {
      expect(s.to - s.from).toBeGreaterThanOrEqual(1.2);
      expect(s.to - s.from).toBeLessThanOrEqual(4.01);
      for (const [d0, d1] of [[6, 7.45], [20, 21.45], [43.8, 44.8 + 0.45]]) expect(s.to <= d0 || s.from >= d1).toBe(true);
      expect(s.from).toBeGreaterThanOrEqual(i > 0 ? story[i - 1].to : shots[0].to);
    }
    // The lamp: a long walk after the click, so the shot is round the hero using it, not the cursor.
    const lamp = story.find((s) => s.why.includes('lamp-post'));
    if (lamp) expect(lamp.from).toBeGreaterThan(27);
    // The oar: the effect comes soon, so the shot starts half a second before the click.
    const oar = story.find((s) => s.why.includes('oar'));
    if (oar) expect(oar.from).toBeCloseTo(34.36, 2);
  });

  it('drops the least telling story shots first when the target is short, never an explode', () => {
    const short = pickShots({ ...input, seconds: 28 });
    expect(short.reduce((n, s) => n + shotSeconds(s), 0)).toBeLessThanOrEqual(28.6);
    expect(short.filter((s) => s.source === 'game').length).toBeLessThan(shots.filter((s) => s.source === 'game').length);
    expect(short.filter((s) => s.source === 'explode').length).toBe(4);
    // Far too short: the story still gets a little of every place.
    const tiny = pickShots({ ...input, seconds: 10 });
    expect(new Set(tiny.filter((s) => s.source === 'game').map((s) => s.place))).toEqual(new Set(['quay', 'mill']));
  });

  it('works without the explode takes: the end shot carries the caption', () => {
    const plain = pickShots({ ...input, explodes: undefined, seconds: 25 });
    expect(plain.some((s) => s.source === 'explode')).toBe(false);
    expect(plain.at(-1)).toMatchObject({ source: 'end', caption: 'Send me your sketch.', hold: 0.5 });
    expect(plain.reduce((n, s) => n + shotSeconds(s), 0)).toBeLessThanOrEqual(25.05);
  });
});

describe('fillFrame', () => {
  it('shows a 4:3 frame whole at full height in 16:9, the sides the same frame blurred and darkened', () => {
    const f = fillFrame({ width: 1440, height: 1080 }, 1920, 1080);
    expect(f).toContain('scale=-2:1080');
    expect(f).toContain('scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=45,eq=brightness=-0.22:saturation=0.8');
    expect(f).toContain('overlay=(W-w)/2:(H-h)/2');
  });

  it('shows it at full width (1080x810) in 1080x1350, the fill above and below', () => {
    const f = fillFrame({ width: 1440, height: 1080 }, 1080, 1350);
    expect(f).toContain('scale=1080:-2');
    expect(f).toContain('crop=1080:1350,gblur=sigma=45');
  });
});

describe('explodeFrame', () => {
  it('cuts the render round the flat painting (1200x896 shows 1272x950), as the approved cut does', () => {
    expect(explodeFrame({ width: 1200, height: 896 }, 1920, 1080)).toBe('crop=1688:950:116:65,scale=1920:1080:flags=lanczos');
    expect(explodeFrame({ width: 1200, height: 896 }, 1080, 1350)).toBe('crop=1272:1080:324:0,scale=1080:-2:flags=lanczos,pad=1080:1350:0:(oh-ih)/2:color=0x090a10');
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
