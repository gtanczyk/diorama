// What sprites each character needs, read from the world and its story, so nothing is drawn that the game
// never shows: walk facings only where the hero's routes go, a talking sheet only for who speaks, in the
// one facing each conversation is held in, with only the gestures its lines use.
import fs from 'node:fs';
import { askSparkJson } from '../meta/spark.ts';
import type { Memo } from '../meta/memo.ts';
import { GESTURES, gestureIndex } from '../play/gestures.ts';
import { Geometry } from '../play/geometry.ts';
import { WalkGrid, type Point } from '../play/path.ts';
import type { Story } from '../story/schema.ts';
import type { WorldFiles } from '../world/files.ts';
import { readBodies } from '../scene/cast.ts';
import { speakerOf } from '../story/engine.ts';
import { FACINGS, SHEET, type Facing } from './sprites.ts';

export type CharacterPlan = {
  key: string;
  /** Walk sheets: the facings the routes use (the left ones mirrored). Empty for someone who never walks. */
  walk: Facing[];
  /** Talking sheets by facing, each with its gestures (cell order; `listen` first). */
  talk: Partial<Record<Facing, string[]>>;
  /** Gesture for each line this character says, by its text. */
  lines: Record<string, string>;
};

/** Facing for a yaw (0 faces the viewer, PI/2 screen right); left-facing yaws mirror onto the right ones. */
export function facingOf(yaw: number): Facing {
  const a = Math.abs(Math.atan2(Math.sin(yaw), Math.cos(yaw)));
  return (Object.keys(FACINGS) as Facing[]).reduce((best, f) => (Math.abs(FACINGS[f] - a) < Math.abs(FACINGS[best] - a) ? f : best));
}

/** A share of the walked distance below this does not earn a sheet; the nearest drawn facing stands in. */
const WALK_SHARE = 0.08;

/** Walked distance per facing over every route between the start and the spots where things are used, in every place. */
export function walkFacings(geometries: Geometry[]): Facing[] {
  const length: Partial<Record<Facing, number>> = {};
  for (const g of geometries) {
    const grid = new WalkGrid(g);
    const spots: Point[] = [[g.start[0], g.start[1]], ...g.things.map((t) => [t.stand[0], t.stand[1]] as Point)];
    for (let i = 0; i < spots.length; i++) {
      for (let j = i + 1; j < spots.length; j++) {
        let at = spots[i];
        for (const next of grid.route(spots[i], spots[j])) {
          const [dx, dy] = [next[0] - at[0], next[1] - at[1]];
          const f = facingOf(Math.atan2(dx, dy));
          length[f] = (length[f] ?? 0) + Math.hypot(dx, dy);
          at = next;
        }
      }
    }
  }
  const total = Object.values(length).reduce((a, b) => a + b, 0);
  const used = (Object.keys(FACINGS) as Facing[]).filter((f) => (length[f] ?? 0) >= total * WALK_SHARE);
  return used.length ? used : ['right'];
}

/** Facings across a conversation: the hero at the NPC's stand spot, each turned to the other. */
function conversationFacings(g: Geometry, npc: string): { hero: Facing; npc: Facing } {
  const t = g.things.find((x) => x.key === npc);
  if (!t) return { hero: 'right', npc: 'front-right' };
  const feet: Point = [(t.box[0] + t.box[2]) / 2, t.box[3]];
  const [dx, dy] = [feet[0] - t.stand[0], feet[1] - t.stand[1]];
  // Standing right next to each other (or the spot is under the feet): side by side, the NPC a little towards the viewer.
  if (Math.hypot(dx, dy) < 40) return { hero: 'right', npc: 'front-right' };
  // Someone talked to from behind still turns their face to the viewer: a talk sheet never shows a back.
  const faces = facingOf(Math.atan2(-dx, -dy));
  return { hero: facingOf(Math.atan2(dx, dy)), npc: faces === 'back' ? 'front' : faces === 'back-right' ? 'front-right' : faces };
}

type SpokenLine = { speaker: string; text: string };

/** Spark picks a gesture for each spoken line, from the gestures the model can do. */
async function gesturesFor(memo: Memo, lines: SpokenLine[]): Promise<string[]> {
  if (!lines.length) return [];
  const menu = GESTURES.map((g) => `- ${g.name}: ${g.means}`).join('\n');
  const asked = lines.map((l, i) => `${i}. ${l.speaker}: "${l.text}"`).join('\n');
  const reply = await askSparkJson<{ gestures: string[] }>(memo, {
    label: 'sprites-gestures',
    prompt: `Characters in a point-and-click game say these lines. For each line pick the one gesture the speaker makes while saying it, from this list:\n${menu}\n\nLines:\n${asked}\n\n` +
      'Use "listen" for plain lines; keep it small, the same few gestures across a character are better than many. Answer JSON only: {"gestures": ["<name for line 0>", ...]} with exactly one name per line.',
  });
  return lines.map((_, i) => (gestureIndex(reply.gestures?.[i] ?? '') >= 0 ? reply.gestures[i] : 'listen'));
}

/** Each character who needs sprites: the hero, and NPCs who speak (a conversation or their own talk lines). */
export async function planSprites(files: WorldFiles, story: Story | undefined): Promise<CharacterPlan[]> {
  const world = files.world();
  const hero = world.hero.key;
  const geometry = (place: string): Geometry | undefined => {
    const at = files.place(place, 'geometry.json');
    return fs.existsSync(at) ? Geometry.parse(JSON.parse(fs.readFileSync(at, 'utf8'))) : undefined;
  };
  const geometries = world.places.map((p) => geometry(p.key)).filter((g): g is Geometry => !!g);
  const plans = new Map<string, CharacterPlan>([[hero, { key: hero, walk: walkFacings(geometries), talk: {}, lines: {} }]]);

  // Who says what, and facing which way while saying it.
  const spoken: (SpokenLine & { facing: Facing })[] = [];
  for (const d of story?.dialogues ?? []) {
    const g = geometry(d.place);
    const facing = g ? conversationFacings(g, d.npc) : { hero: 'right' as Facing, npc: 'front-right' as Facing };
    if (!plans.has(d.npc)) plans.set(d.npc, { key: d.npc, walk: [], talk: {}, lines: {} });
    for (const l of d.lines) {
      spoken.push({ speaker: d.npc, text: l.says, facing: facing.npc });
      for (const c of l.choices) spoken.push({ speaker: hero, text: c.text, facing: facing.hero });
    }
  }
  // A person's own talk lines, without a conversation, are said to the hero the same way.
  for (const it of story?.interactions ?? []) {
    if (speakerOf(world, it) === hero) continue;
    const g = geometry(it.place);
    if (!plans.has(it.thing)) plans.set(it.thing, { key: it.thing, walk: [], talk: {}, lines: {} });
    spoken.push({ speaker: it.thing, text: it.say, facing: (g ? conversationFacings(g, it.thing) : { npc: 'front-right' as Facing }).npc });
  }
  const gestures = await gesturesFor(files.memo, spoken);
  spoken.forEach((l, i) => {
    const plan = plans.get(l.speaker)!;
    plan.lines[l.text] = gestures[i];
    const sheet = (plan.talk[l.facing] ??= ['listen']);
    if (!sheet.includes(gestures[i]) && sheet.length < SHEET.cols * SHEET.rows) sheet.push(gestures[i]);
  });
  // A cat or a horse has no person's poses to draw over: it stays its painted figure (cast/figures.json).
  const bodies = readBodies(files, fs.existsSync);
  return [...plans.values()].filter((p) => bodies[p.key]?.upright !== false);
}
