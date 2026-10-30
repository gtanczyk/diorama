// What changing a world's style redoes, and what that costs: the steps per scope, and an estimate of the model
// calls from what those steps sent when this world was built (a rough table when it has no record yet).
import fs from 'node:fs';
import { readBudget } from '../actions/budget.ts';
import { players } from './drawings.ts';
import type { WorldFiles } from './files.ts';
import type { World } from './schema.ts';

export const SCOPES = ['world', 'place', 'cast'] as const;
export type Scope = (typeof SCOPES)[number];

/** The place steps a new painting runs again; the restyle edit takes paint's place. Sound and voices stay as they are. */
export const PLACE_REDO = ['paint', 'masks', 'plates', 'icons', 'derive', 'backdrop', 'weather', 'reactions', 'verify'] as const;
/** The character steps; model and sprites only for those who had them. */
export const CAST_REDO = ['cast', 'model', 'sprites'] as const;

type Calls = Record<string, number>;
/** Calls one place (or one character) costs per step when the world has no record of its own. */
const ROUGH: Record<string, Calls> = {
  paint: { spark: 2, muse: 2 }, masks: { spark: 1, sam: 8 }, plates: { muse: 1 }, icons: { muse: 1 }, derive: { spark: 3 },
  backdrop: { muse: 1, sam: 2 }, weather: { spark: 1 }, reactions: { spark: 1 }, verify: {},
  cast: { muse: 1, sam: 1 }, model: { muse: 3 }, sprites: { muse: 5 },
};

/** Everyone the cast step paints: the hero, each NPC and the heroes for more gamepads. */
export const castKeys = (world: World, files: WorldFiles) => [...new Set([world.hero.key, ...world.places.flatMap((p) => p.things.filter((t) => t.role === 'npc').map((t) => t.key)), ...players(files).map((p) => p.key)])];

export type StylePlan = {
  scope: Scope;
  places: string[];
  cast: string[];
  /** Of the cast, who has a 3D model and sprite sheets to make again. */
  models: string[];
  sprites: string[];
  calls: Calls;
  usd: number | null;
  minutes: number;
};

export function stylePlan(files: WorldFiles, world: World, scope: Scope, key?: string): StylePlan {
  const places = scope === 'world' ? world.places.map((p) => p.key) : scope === 'place' ? [key!] : [];
  const cast = scope === 'place' ? [] : scope === 'cast' && key ? [key] : castKeys(world, files);
  const painted = places.filter((p) => fs.existsSync(files.place(p, 'painting.png')));
  const figures = cast.filter((k) => fs.existsSync(files.path('cast', `${k}-painting.png`)));
  const models = figures.filter((k) => fs.existsSync(files.path('cast', k, 'model', 'model.json')));
  const sprites = models.filter((k) => fs.existsSync(files.path('cast', k, 'sprites', 'sprites.json')));
  let log: { steps?: Record<string, { seconds?: number; sent?: Calls }> } = {};
  try {
    log = JSON.parse(fs.readFileSync(files.path('build.json'), 'utf8'));
  } catch {}
  const calls: Calls = {};
  let seconds = 0;
  // What a step sent for the whole world, shared out over the `of` it made then; the rough table is per place or character.
  const add = (step: string, count: number, of: number) => {
    const sent = log.steps?.[step]?.sent;
    const own = !!sent && Object.values(sent).some((n) => n > 0);
    const share = own ? count / Math.max(1, of) : count;
    for (const [m, n] of Object.entries(own ? sent : ROUGH[step] ?? {})) calls[m] = (calls[m] ?? 0) + n * share;
    // Places and characters are made side by side: a step takes about as long for one as for all.
    seconds += log.steps?.[step]?.seconds ?? 60;
  };
  if (painted.length) for (const step of PLACE_REDO) add(step, painted.length, world.places.length);
  if (figures.length) add('cast', figures.length, castKeys(world, files).length);
  // Model and sprites ran for fewer characters than the cast (those who walk and talk): shared out over theirs.
  const had = (part: string) => castKeys(world, files).filter((k) => fs.existsSync(files.path('cast', k, part))).length;
  if (models.length) add('model', models.length, had('model/model.json'));
  if (sprites.length) add('sprites', sprites.length, had('sprites/sprites.json'));
  for (const m of Object.keys(calls)) calls[m] = Math.ceil(calls[m]);
  for (const m of Object.keys(calls)) if (!calls[m]) delete calls[m];
  const { prices } = readBudget();
  const priced = Object.keys(calls).every((m) => (prices as Record<string, number | undefined>)[m] !== undefined);
  const usd = priced ? Math.round(Object.entries(calls).reduce((s, [m, n]) => s + n * ((prices as Record<string, number>)[m] ?? 0), 0) * 100) / 100 : null;
  return { scope, places: painted, cast: figures, models, sprites, calls, usd, minutes: Math.max(1, Math.round(seconds / 60)) };
}

/** One line for the person: what is redone and about what it costs. */
export function planLine(plan: StylePlan): string {
  const what = [
    plan.places.length && `${plan.places.length} place(s) repainted with the composition kept, then cut out and measured again`,
    plan.cast.length && `${plan.cast.length} character(s) repainted`,
    plan.models.length && `${plan.models.length} 3D model(s)`,
    plan.sprites.length && `${plan.sprites.length} sprite set(s)`,
  ].filter(Boolean).join(', ');
  const calls = Object.entries(plan.calls).map(([m, n]) => `${m} ${n}`).join(', ');
  return `${what || 'nothing painted yet: only the style is stored'}; about ${calls || 'no calls'}${plan.usd !== null ? ` (~$${plan.usd})` : ''}, ~${plan.minutes} min`;
}
