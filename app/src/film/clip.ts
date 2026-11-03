// The X clip's edit as pure functions: which spans of the recorded takes become shots (from the click log), where
// each shot sits in a 1080x1350 frame, and where the world's own sound files go under them. diorama clip records
// the takes and renders what these plan (src/commands/clip.ts).
import type { SoundData } from '../play/sound.ts';
import { spokenLine } from '../play/sound.ts';
import type { Action } from '../story/engine.ts';

/** What happened in a recorded take, in seconds from its first video frame; x, y in page pixels. */
export type TakeEvent =
  /** A cursor click: on a story action's target, or (no action) on the floor to set the hero walking. */
  | { kind: 'click'; t: number; x: number; y: number; place: string; action?: Action }
  /** The hero arrived at a thing and uses it (the page's 'use' event): the moment the click shows its effect. */
  | { kind: 'use'; t: number; thing: string }
  | { kind: 'say'; t: number; text: string; who: string }
  /** The fade out to another place starts. */
  | { kind: 'exit'; t: number; from: string; to: string }
  | { kind: 'enter'; t: number; place: string };

export type Take = {
  /** Seconds of video. */
  duration: number;
  /** The place the take starts in. */
  place: string;
  events: TakeEvent[];
  /** Where the hero is on the page over time (page x of a 1920 px wide page). */
  hero: Array<{ t: number; x: number }>;
};

export type ShotSource = 'game' | 'end' | 'explode-first' | 'explode-last';

export type Shot = {
  source: ShotSource;
  /** Span of the source video, seconds. */
  from: number;
  to: number;
  /** Playback speed (the explode takes run faster). */
  speed: number;
  place: string;
  /** Left edge of the 1080 px wide crop of the 2400x1350 frame, for the 1080x1350 version. */
  cropX: number;
  caption?: string;
  /** Seconds the last frame is held at the end. */
  hold?: number;
  why: string;
};

export const TALL = { scaledWidth: 2400, width: 1080 };
/** Seconds of the opening shot before the first click lands, and of the whole opening shot. */
export const OPEN_LEAD = 0.2;
export const OPEN_SHOT = 0.8;
const BEFORE = 0.5;
const AFTER = 2.5;
const LONGEST = 4;
const SHORTEST = 1.2;
/** After 'enter' the page is still fading in from black. */
const FADE_IN = 0.45;

/** Flat, the orbit-popout explode shows the place's painting this many times its frame size, in the middle of a render of EXPLODE_RENDER. */
export const EXPLODE_FLAT_SCALE = 1.06;
export const EXPLODE_RENDER = { width: 1920, height: 1080 };

export const shotSeconds = (s: Shot) => (s.to - s.from) / s.speed + (s.hold ?? 0);

/** Clip start of each shot. */
export function shotStarts(shots: Shot[]): number[] {
  const starts: number[] = [];
  let t = 0;
  for (const s of shots) {
    starts.push(t);
    t += shotSeconds(s);
  }
  return starts;
}

const targetOf = (a: Action | undefined) => (!a ? undefined : a.kind === 'go' ? a.via : a.kind === 'talk' ? a.npc : a.kind === 'do' ? a.thing : undefined);
const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * The left edge of the 1080 px crop that keeps the hero (and the click, when both fit) in a 2400 px wide frame.
 * `hero` and `click` are page x on a 1920 px wide page.
 */
export function cropFor(hero: number | undefined, click?: number): number {
  const k = TALL.scaledWidth / 1920;
  const max = TALL.scaledWidth - TALL.width;
  let centre = hero === undefined ? TALL.scaledWidth / 2 : hero * k;
  if (hero !== undefined && click !== undefined && Math.abs(click - hero) * k < TALL.width * 0.8) centre = ((hero + click) / 2) * k;
  else if (hero === undefined && click !== undefined) centre = click * k;
  return Math.round(Math.max(0, Math.min(max, centre - TALL.width / 2)));
}

function heroAt(take: Take, from: number, to: number): number | undefined {
  const xs = take.hero.filter((h) => h.t >= from && h.t <= to).map((h) => h.x).sort((a, b) => a - b);
  if (xs.length) return xs[Math.floor(xs.length / 2)];
  const near = [...take.hero].sort((a, b) => Math.abs(a.t - (from + to) / 2) - Math.abs(b.t - (from + to) / 2))[0];
  return near?.x;
}

/** Spans of a take where the page is black or fading: from each exit to just after the next enter. */
function darkSpans(take: Take): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const e of take.events) {
    if (e.kind !== 'exit') continue;
    const enter = take.events.find((n) => n.kind === 'enter' && n.t >= e.t);
    out.push([e.t, enter ? enter.t + FADE_IN : take.duration]);
  }
  return out;
}

/** Where `place` holds at time t of the take. */
function placeAt(take: Take, t: number): string {
  let place = take.place;
  for (const e of take.events) if (e.kind === 'enter' && e.t <= t) place = e.place;
  return place;
}

type Candidate = { from: number; to: number; at: number; click?: number; priority: number; place: string; why: string; keep?: boolean };

export type ClipPlanInput = {
  game: Take;
  end?: Take;
  /** Target length in seconds. */
  seconds: number;
  /** Lengths of the explode takes, when made. */
  explodeFirst?: number;
  explodeLast?: number;
  firstPlace: string;
  lastPlace: string;
  caption: string;
};

/**
 * The shot list: the first click opens the clip 0.2 s in, the first place comes apart into its layers at ~0.8 s,
 * then a shot per story click (0.5 s before, 2-3 s after, or round its effect when the hero had far to walk), at
 * least one per place, trimmed to the target length, and the last place with its explode under the end card.
 */
export function pickShots(input: ClipPlanInput): Shot[] {
  const { game } = input;
  const clicks = game.events.filter((e): e is Extract<TakeEvent, { kind: 'click' }> => e.kind === 'click');
  if (!clicks.length) throw new Error('the game take has no clicks');
  const first = clicks[0];
  const open: Shot = {
    source: 'game', from: round(Math.max(0, first.t - OPEN_LEAD)), to: round(Math.max(0, first.t - OPEN_LEAD) + OPEN_SHOT), speed: 1, place: placeAt(game, first.t),
    cropX: cropFor(heroAt(game, first.t - OPEN_LEAD, first.t + OPEN_SHOT), first.x), why: 'opening click',
  };
  const head: Shot[] = [open];
  if (input.explodeFirst) {
    const to = Math.min(input.explodeFirst, 2.6);
    head.push({ source: 'explode-first', from: Math.min(0.3, to / 4), to, speed: 2, place: input.firstPlace, cropX: cropFor(undefined), why: 'the first place comes apart into its layers' });
  }
  const tail = endShots(input);
  const fixed = [...head, ...tail].reduce((n, s) => n + shotSeconds(s), 0);
  const budget = Math.max(0, input.seconds - fixed);
  const dark = darkSpans(game);
  // The last place is the end take's: the game take's few seconds there are left out.
  const middle = middleShots(game, clicks.slice(1), open.to, dark, budget, input.end ? input.lastPlace : undefined);
  return [...head, ...middle, ...tail];
}

function endShots(input: ClipPlanInput): Shot[] {
  const { end } = input;
  const out: Shot[] = [];
  const endHold = input.explodeLast ? 0 : 1.6;
  if (end) {
    const click = end.events.find((e): e is Extract<TakeEvent, { kind: 'click' }> => e.kind === 'click');
    const from = click ? Math.max(0, click.t - 0.3) : Math.min(1, end.duration / 4);
    const to = Math.min(end.duration, from + 3.2 + endHold);
    out.push({ source: 'end', from: round(from), to: round(to), speed: 1, place: input.lastPlace, cropX: cropFor(heroAt(end, from, to), click?.x), why: 'the last place', ...(!input.explodeLast && { caption: input.caption, hold: 0.4 }) });
  }
  if (input.explodeLast) {
    out.push({ source: 'explode-last', from: 0, to: Math.min(input.explodeLast, 4.4), speed: 1.6, place: input.lastPlace, cropX: cropFor(undefined), caption: input.caption, hold: 0.4, why: 'the last place comes apart under the end card' });
  }
  return out;
}

function middleShots(game: Take, clicks: Array<Extract<TakeEvent, { kind: 'click' }>>, after: number, dark: Array<[number, number]>, budget: number, skip?: string): Shot[] {
  const cands: Candidate[] = [];
  const nextClick = (t: number) => clicks.find((c) => c.t > t + 0.01)?.t ?? game.duration;
  for (const c of clicks) {
    const a = c.action;
    // Answers are UI text, not the place: never a shot of their own.
    if (!a || a.kind === 'choose' || a.kind === 'leave') continue;
    const target = targetOf(a);
    const use = game.events.find((e) => e.kind === 'use' && e.t >= c.t && e.t <= nextClick(c.t) && e.thing === target);
    let from: number, to: number, at: number;
    if (!use || use.t - c.t <= AFTER) {
      from = c.t - BEFORE;
      to = Math.min(c.t + 3.5, Math.max(c.t + AFTER, use ? use.t + 1.2 : 0));
      at = c.t;
    } else {
      // A long walk: the shot is the hero arriving and using it, not the cursor.
      from = use.t - 1.8;
      to = use.t + 1.4;
      at = use.t;
    }
    const priority = a.kind === 'go' ? 3 : a.kind === 'do' && a.with ? 3 : a.kind === 'do' ? 2 : 1;
    cands.push({ from, to, at, click: from <= c.t ? c.x : undefined, priority, place: c.place, why: `${a.kind} ${target}` });
  }
  // One shot per place change: the hero just arrived, unless a click shot already opens soon after.
  for (const e of game.events) {
    if (e.kind !== 'enter') continue;
    const from = e.t + FADE_IN;
    if (cands.some((c) => c.from >= e.t && c.from - from < 2)) continue;
    cands.push({ from, to: from + 2.4, at: from, priority: 2.5, place: e.place, why: `arrive in ${e.place}` });
  }
  // Out of the dark and fades, after the opening shot, inside the take.
  const clean: Candidate[] = [];
  for (const c of cands) {
    let { from, to } = c;
    from = Math.max(from, after);
    to = Math.min(to, game.duration);
    for (const [d0, d1] of dark) {
      if (to <= d0 || from >= d1) continue;
      if (c.at < d0) to = Math.min(to, d0);
      else from = Math.max(from, d1);
    }
    const place = placeAt(game, (from + to) / 2);
    if (to - from >= SHORTEST && place !== skip) clean.push({ ...c, from, to, place });
  }
  clean.sort((a, b) => a.from - b.from);
  // No overlaps: a later shot starts where the earlier one ends; a stub left over goes.
  const shots: Candidate[] = [];
  for (const c of clean) {
    const prev = shots.at(-1);
    if (prev && c.from < prev.to) {
      if (c.priority > prev.priority && c.from - prev.from >= SHORTEST) prev.to = c.from;
      else c.from = prev.to;
    }
    if (c.to - c.from >= SHORTEST) shots.push(c);
  }
  // Each place keeps its best shot while others are dropped.
  for (const place of new Set(shots.map((s) => s.place))) {
    const best = shots.filter((s) => s.place === place).sort((a, b) => b.priority - a.priority || a.from - b.from)[0];
    best.keep = true;
  }
  const total = () => shots.reduce((n, s) => n + s.to - s.from, 0);
  // Over the budget: tails come in to 2.5 s, then the least telling shots go (the latest first among equals).
  for (const s of shots) if (total() > budget && s.to - s.from > 2.5) s.to = Math.max(s.from + 2.5, s.to - (total() - budget));
  while (total() > budget && shots.length) {
    const drop = [...shots].sort((a, b) => Number(!!a.keep) - Number(!!b.keep) || a.priority - b.priority || b.from - a.from)[0];
    if (drop.keep && total() - (drop.to - drop.from) < budget * 0.6) {
      // Only kept shots are left: shorten them all instead of losing a place.
      const k = budget / total();
      for (const s of shots) s.to = s.from + Math.max(SHORTEST, (s.to - s.from) * k);
      break;
    }
    shots.splice(shots.indexOf(drop), 1);
  }
  // Under the budget: tails grow up to LONGEST, never into the dark or the next shot.
  for (const [i, s] of shots.entries()) {
    const room = budget - total();
    if (room <= 0.05) break;
    const limit = Math.min(shots[i + 1]?.from ?? game.duration, ...dark.filter(([d0]) => d0 >= s.to).map(([d0]) => d0), s.from + LONGEST);
    s.to = Math.max(s.to, Math.min(limit, s.to + room));
  }
  return shots.map((s) => ({ source: 'game', from: round(s.from), to: round(s.to), speed: 1, place: s.place, cropX: cropFor(heroAt(game, s.from, s.to), s.click), why: s.why }));
}

/** One sound under the clip: a file at a clip time, normalised to `lufs`, then scaled by `gain`. */
export type Cue = { kind: 'bed' | 'loop' | 'voice' | 'music'; file: string; at: number; seconds: number; lufs: number; gain: number; loop: boolean; fadeIn: number; fadeOut: number };

/** Gain of a place's loop by its planned level (1 quiet, 3 loud). */
const LOOP_GAIN = [0, 0.35, 0.5, 0.9];
export const LEVELS = { bed: -26, voice: -17, music: -21, final: -14 };

/**
 * The soundtrack from the world's own files: each place's bed and its always-on loops under that place's shots,
 * the voiced lines where they were said in a shot that plays at normal speed (never two at once), and the music
 * under all of it, fading out over the end card.
 */
export function audioPlan(shots: Shot[], takes: Partial<Record<ShotSource, Take>>, sound: SoundData | undefined, music: string | undefined): Cue[] {
  const starts = shotStarts(shots);
  const total = shots.reduce((n, s) => n + shotSeconds(s), 0);
  const cues: Cue[] = [];
  // Consecutive shots in one place share one bed, so it does not restart at each cut.
  const spans: Array<{ place: string; from: number; to: number }> = [];
  shots.forEach((s, i) => {
    const prev = spans.at(-1);
    const to = starts[i] + shotSeconds(s);
    if (prev && prev.place === s.place) prev.to = to;
    else spans.push({ place: s.place, from: starts[i], to });
  });
  for (const span of spans) {
    const p = sound?.places[span.place];
    if (!p) continue;
    const seconds = round(span.to - span.from);
    const fade = (n: number) => Math.min(n, seconds / 4);
    const bed = p.bed && sound.files[p.bed];
    if (bed) cues.push({ kind: 'bed', file: bed.file, at: round(span.from), seconds, lufs: LEVELS.bed, gain: 0.9, loop: true, fadeIn: fade(0.25), fadeOut: fade(0.3) });
    for (const l of p.loops) {
      const f = sound.files[l.id];
      if (!f || l.when.length) continue;
      cues.push({ kind: 'loop', file: f.file, at: round(span.from), seconds, lufs: LEVELS.bed, gain: LOOP_GAIN[l.level] ?? 0.5, loop: true, fadeIn: fade(0.25), fadeOut: fade(0.3) });
    }
  }
  let free = 0;
  shots.forEach((s, i) => {
    const take = (s.source === 'game' || s.source === 'end') && s.speed === 1 ? takes[s.source] : undefined;
    for (const e of take?.events ?? []) {
      if (e.kind !== 'say' || e.t < s.from || e.t >= s.to) continue;
      const line = spokenLine(sound, e.text, e.who);
      if (!line) continue;
      const at = starts[i] + (e.t - s.from);
      if (at < free - 0.05 || total - at < 0.6) continue;
      const seconds = Math.min(line.seconds, total - at);
      cues.push({ kind: 'voice', file: line.file, at: round(at), seconds: round(seconds), lufs: LEVELS.voice, gain: 1, loop: false, fadeIn: 0.02, fadeOut: seconds < line.seconds ? 0.3 : 0.05 });
      free = at + line.seconds;
    }
  });
  if (music) cues.push({ kind: 'music', file: music, at: 0, seconds: round(total), lufs: LEVELS.music, gain: 1, loop: true, fadeIn: 0.2, fadeOut: Math.min(2.2, total / 4) });
  return cues;
}

/**
 * The world's sound for a clip, from what was made (sound/sounds.json) rather than what the page would play: the page
 * leaves out a bed whose prompt the plan has since changed, but the file made is still that place's sound. Each
 * place gets its `<place>-bed` and its `<place>-<thing>-loop` files (a loop belongs to the longest place key it starts
 * with); a loop keeps the conditions the page knows for it, else plays always. Spoken lines come from `page`.
 */
export function clipSound(page: SoundData | undefined, made: Record<string, { file: string; kind: string; level: number }>, places: string[]): SoundData {
  const files: SoundData['files'] = {};
  for (const [id, s] of Object.entries(made)) {
    if (s.kind === 'music' || s.kind === 'bed' || s.kind === 'loop' || s.kind === 'step' || s.kind === 'shot') files[id] = { file: s.file, kind: s.kind, level: s.level };
  }
  const owner = (id: string) => [...places].sort((a, b) => b.length - a.length).find((p) => id.startsWith(`${p}-`));
  const out: SoundData = { ...(page ?? { shots: {} }), files, music: files.music ? 'music' : page?.music, places: {} };
  for (const place of places) {
    const bed = files[`${place}-bed`]?.kind === 'bed' ? `${place}-bed` : page?.places[place]?.bed;
    const loops = Object.keys(files).filter((id) => files[id].kind === 'loop' && id.endsWith('-loop') && owner(id) === place).map((id) => {
      const thing = id.slice(place.length + 1, -'-loop'.length);
      const known = page?.places[place]?.loops.find((l) => l.id === id);
      return { id, thing, level: files[id].level, when: known?.when ?? [] };
    });
    out.places[place] = { bed, loops, zones: page?.places[place]?.zones ?? [] };
  }
  return out;
}
