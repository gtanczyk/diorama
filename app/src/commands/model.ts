// diorama model <slug> [key]: a character as a rigged 3D model, painted by Muse from four sides. Without a
// key, everyone the sprites plan needs (the hero, NPCs who speak): the model is where their poses come from.
import { castLanes, mapLimit } from '../world/pool.ts';
import fs from 'node:fs';
import { bindExistingAnimation, bindAnimation } from '../scene/animation-source.ts';
import { refusedByFilter } from '../scene/words.ts';
import { defineCommand, registry, takeOption } from '../registry.ts';
import { autoRig, reconstruct } from '../model/build.ts';
import { fitViews, refitIfOld } from '../model/fit.ts';
import { badModel, lean, readShape, rigProblem, standUp } from '../model/glb.ts';
import { findBlender, relaxPose, type RelaxReport } from '../model/blender.ts';
import { paintViews } from '../model/views.ts';
import { planSprites } from '../model/plan.ts';
import { animationSettings, animationOptions, saveAnimationSettings } from '../model/animation.ts';
import { Story } from '../story/schema.ts';
import { fixedLooks, readCastFixes } from '../scene/cast-fixes.ts';
import { readBodies } from '../scene/cast.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'model',
  usage: 'model <slug> [key]       with [key], also finishes its required sprites; Muse paints each character who needs sprites (or [key]) from 4 sides, TRELLIS + auto-rig make a 3D model (cast/<key>/model/) [--texture model|views: saved per character] [--glb rigged.glb: skip TRELLIS and the rig] [--coat-correction on|off: off for trousers] [--sprites: finish the character animation, used by Studio] [--take N] [--refit: only fit the views onto the model again, no calls] [--relax: only put existing models into a calm rest pose with a local Blender, no calls]',
  async run(args) {
    const options = animationOptions(takeOption(args, 'texture', ''), '', takeOption(args, 'coat-correction', ''));
    const take = Number(takeOption(args, 'take', '0'));
    const given = takeOption(args, 'glb', '');
    const refit = args.includes('--refit');
    const relaxOnly = args.includes('--relax');
    const [slug, keyArg] = args.filter((a) => a !== '--refit' && a !== '--sprites' && a !== '--relax');
    // An individual Animate request includes its sprites, including older Studio clients.
    const withSprites = !!keyArg || args.includes('--sprites');
    if (!slug) throw new Error('usage: diorama model <slug> [key] [--glb rigged.glb] [--refit]');
    if (refit) {
      if (Object.keys(options).length) throw new Error('--texture cannot be combined with --refit');
      const files = new WorldFiles(slug);
      const castDir = files.path('cast');
      for (const key of keyArg ? [keyArg] : fs.readdirSync(castDir).filter((k) => fs.existsSync(files.path('cast', k, 'model', 'model.json')))) {
        await refitIfOld(files.path('cast', key, 'model'), true);
        console.log(`${key}: views fitted again, slice by slice`);
      }
      return;
    }
    if (relaxOnly) {
      const blender = await findBlender();
      if (!blender) throw new Error('--relax needs Blender 3.6+ (install it, or set DIORAMA_BLENDER to its path)');
      const files = new WorldFiles(slug);
      const castDir = files.path('cast');
      const keys = keyArg ? [keyArg] : fs.readdirSync(castDir).filter((k) => fs.existsSync(files.path('cast', k, 'model', 'model.json')));
      for (const key of keys) console.log(`${key}: ${await relaxModel(files, key, true)}`);
      // Renders of the model itself follow it; painted sprites are redrawn by diorama sprites (Muse).
      for (const key of keys) if (animationSettings(files, key).texture === 'model') await registry.get('sprites')!.run([slug, key]);
      return;
    }
    if (given && !keyArg) throw new Error('--glb needs the key of the character it is');
    const files = new WorldFiles(slug);
    const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : undefined;
    // Everyone the sprites plan needs, and whoever the person asked to animate (cast_animate, cast/fixes.json).
    const asked = Object.entries(readCastFixes(files)).filter(([, f]) => f.animate).map(([k]) => k);
    const planned = keyArg ? [keyArg] : [...new Set([...(await planSprites(files, story)).map((p) => p.key), ...asked])];
    // A figure the cast step set aside (no painting: the game draws a stand-in) has nothing to build a body from; it
    // used to fail the whole step with ENOENT (anoti: the turtle and the long-neck timed out at cast). Cast retries them.
    const keys = keyArg ? planned : planned.filter((key) => fs.existsSync(files.path('cast', `${key}-painting.png`)));
    for (const key of planned) if (!keys.includes(key)) console.log(`${key}: not painted yet (a stand-in), no 3D model; diorama cast paints it`);
    for (const key of keys) if (Object.keys(options).length) saveAnimationSettings(files, key, animationSettings(files, key, options));
    await buildModels(files, keys, take, given, !!keyArg);
    console.log(`calls sent: muse ${files.memo.sent.muse}, space ${files.memo.sent.space}`);
    // UV sprites are renders of the model itself (no Muse): a new model without them leaves the game walking
    // the old body's sheets (a pole the new sides left out, an old face), so they are always rendered again.
    const uvSprites = (key: string) => {
      try {
        return animationSettings(files, key).texture === 'model' && fs.existsSync(files.path('cast', key, 'model', 'model.json'));
      } catch {
        return false;
      }
    };
    if (withSprites || keys.some(uvSprites)) {
      const plans = await planSprites(files, story);
      for (const key of keys) if ((withSprites || uvSprites(key)) && plans.some((p) => p.key === key && !p.creature)) await registry.get('sprites')!.run([slug, key]);
    }
  },
});

/** Said when a character is left in 2D because the 3D service did not answer: cast_animate tries it again. */
export const SERVICE_DOWN = 'the 3D service did not answer';
/** Pauses before asking TRELLIS again after an error; tests shorten them. */
export const SERVICE_PAUSES = { ms: [10_000, 30_000, 60_000] };
/** Errors that asking again will not mend: no quota left, no access, a refused picture. */
const lasting = (message: string) => /quota|\b40[13]\b|unauthori[sz]ed|forbidden|NSFW|not allowed/i.test(message);

/** An unavailable service for one character must not prevent the rest of the cast being attempted. */
export async function buildModels(files: WorldFiles, keys: string[], take: number, given: string, requireModel = false) {
  const failures: string[] = [];
  // Characters side by side (a few at once): each waits on Muse, Claude and the Spaces, never on another character.
  // The Spaces keep their own small lanes (model/build.ts), so a busy GPU queue is not asked twice as hard.
  await mapLimit(keys, castLanes(), async (key) => {
    try {
      const made = await buildModel(files, key, take, given);
      if (!made && requireModel) failures.push(`${key}: no usable 3D model (${attemptReason(files, key)}); see cast status`);
    } catch (error) {
      const reason = `${key}: ${error instanceof Error ? error.message : String(error)}`;
      console.error(reason);
      failures.push(reason);
    }
  });
  if (failures.length) throw new Error(`3D models failed: ${failures.join('; ')}`);
}

function attemptReason(files: WorldFiles, key: string): string {
  try {
    return String((files.readJson(files.path('cast', key, 'model', 'attempt.json')) as { reason?: unknown }).reason ?? 'unknown');
  } catch {
    return 'unknown';
  }
}

export async function buildModel(files: WorldFiles, key: string, take: number, given: string): Promise<boolean> {
  const attempt = files.path('cast', key, 'model', 'attempt.json');
  bindExistingAnimation(files, key);
  try {
    const reason = await makeModel(files, key, take, given);
    if (!reason) bindAnimation(files, key, 'model');
    files.write(attempt, { state: reason ? 'fallback' : 'ready', reason, at: new Date().toISOString() });
    return !reason;
  } catch (error) {
    files.write(attempt, { state: 'failed', reason: error instanceof Error ? error.message : String(error), at: new Date().toISOString() });
    throw error;
  }
}

async function makeModel(files: WorldFiles, key: string, take: number, given: string): Promise<string | null> {
  const finishSettings = (mesh: Buffer) => {
    const settings = animationSettings(files, key, {}, mesh);
    saveAnimationSettings(files, key, settings);
    return { ...(settings.texture === 'model' && { texture: 'model' as const }), ...(settings.coatCorrection !== undefined && { coatCorrection: settings.coatCorrection }) };
  };
  const world = files.world();
  const found = [world.hero, ...world.places.flatMap((p) => p.things)].find((w) => w.key === key);
  if (!found) throw new Error(`no hero or NPC called ${key}`);
  const supplied = given ? fs.readFileSync(given) : undefined;
  if (supplied) {
    const bad = badModel(readShape(supplied));
    if (bad) throw new Error(`${key}: supplied 3D model rejected: ${bad}`);
  }
  const who = fixedLooks(files, found);
  const painting = fs.readFileSync(files.path('cast', `${key}-painting.png`));
  const out = (name: string) => files.path('cast', key, 'model', name);

  // Not a person on two legs (cast/figures.json): painted as it is, no skeleton; it hops and squashes as one body.
  const creature = readBodies(files, fs.existsSync)[key]?.upright === false;
  // Each stage says its name ("<key>: ..."), and each side is written as it lands: Studio follows both live.
  console.log(`${key}: painting 4 sides`);
  let views: Awaited<ReturnType<typeof paintViews>>;
  try {
    views = await paintViews(files.memo, key, who.looks ?? '', painting, take, creature, (name, png) => files.write(out(`${name}.png`), png));
  } catch (error) {
    // A creature whose sides never showed one body: no model, the painted figure hops as it is (an older model too
    // was made from such sides, so it goes).
    const message = error instanceof Error ? error.message : String(error);
    if (creature && message.startsWith('its 4 sides do not show one creature')) {
      if (fs.existsSync(out('model.json'))) fs.renameSync(out('model.json'), out('model-rejected.json'));
      console.log(`${key}: no 3D model: ${message}; the painted figure hops as it is`);
      return message;
    }
    // Refused even in calm words: the model made before stays (a changed prompt reran it), else the 2D rig walks.
    if (!refusedByFilter(error)) throw error;
    if (fs.existsSync(out('model.json')) && fs.existsSync(out('model.glb'))) {
      console.log(`${key}: the image safety filter refused its 4 sides; the 3D model made before stays`);
      return null;
    }
    console.log(`${key}: no 3D model: the image safety filter refused its 4 sides; ${creature ? 'the painted figure hops as it is' : 'the game walks the 2D rig'}`);
    return 'the image safety filter refused its 4 sides';
  }
  // TRELLIS sometimes makes a flat card of a flat drawing: other seeds, then the front alone (depth guessed),
  // and with none of them a body, no model: the character walks with its 2D rig.
  const all = [views.front, views.back, views.left, views.right];
  const tries = [[1, all], [2, all], [3, all], [1, [views.front]]] as const;
  let shell: Buffer | undefined;
  // A Space that answers with an error (busy, restarting, a lost file) is asked again after a pause, on the next try;
  // one that keeps failing leaves the character in 2D, so the world is still built and playable.
  let unavailable: string | undefined;
  let failures = 0;
  let built: Buffer | undefined;
  let rigDown: string | undefined;
  let misplaced: string | undefined;
  for (const [seed, from] of tries) {
    if (given) break;
    console.log(`${key}: TRELLIS builds the body${seed > 1 || from.length === 1 ? ` (try ${seed + (from.length === 1 ? 3 : 0)})` : ''}`);
    let made: Buffer;
    try {
      made = await reconstruct(files.memo, key, [...from], seed);
    } catch (error) {
      unavailable = error instanceof Error ? error.message : String(error);
      console.log(`${key}: TRELLIS failed: ${unavailable}`);
      if (lasting(unavailable) || ++failures > SERVICE_PAUSES.ms.length) break;
      const pause = SERVICE_PAUSES.ms[failures - 1];
      console.log(`${key}: asking TRELLIS again in ${Math.round(pause / 1000)} s`);
      await new Promise((resolve) => setTimeout(resolve, pause));
      continue;
    }
    unavailable = undefined;
    const bad = badModel(readShape(made));
    if (bad) {
      console.log(`${key}: TRELLIS (seed ${seed}${from.length === 1 ? ', front only' : ''}) made a model that is ${bad}`);
      continue;
    }
    if (creature) { shell = made; break; }
    // The auto-rig guesses joints from the shape alone and is deterministic: a skeleton it misplaces (a long
    // robe hides the legs) comes back the same for the same body, so the next TRELLIS body gets the next try.
    console.log(`${key}: rigging the skeleton`);
    let skinned: Buffer;
    try {
      skinned = await autoRig(files.memo, key, made);
    } catch (error) {
      rigDown = error instanceof Error ? error.message : String(error);
      break;
    }
    misplaced = rigProblem(skinned) ?? undefined;
    if (!misplaced) { shell = made; built = skinned; break; }
    console.log(`${key}: auto-rig on TRELLIS seed ${seed}${from.length === 1 ? ', front only' : ''}: ${misplaced}`);
  }
  const rejected = out('model.json');
  const reject = (why: string) => {
    if (fs.existsSync(rejected)) fs.renameSync(rejected, out('model-rejected.json'));
    console.log(`${key}: no 3D model: ${why}; ${creature ? 'the painted figure hops as it is' : 'the game walks the 2D rig'}`);
    return why;
  };
  if (rigDown) return reject(`${SERVICE_DOWN}: ${rigDown}`);
  if (!given && !shell) {
    // An older model of this character (a flat one, kept before this gate) must not stay in the game.
    return reject(unavailable ? `${SERVICE_DOWN}: ${unavailable}` : misplaced ? `every skeleton the auto-rig made was misplaced (${misplaced})` : 'every reconstruction was flat or invalid');
  }
  if (creature) {
    // Make-It-Animatable rigs a person's skeleton only; a creature keeps TRELLIS's mesh as it came (no standing up:
    // a cat or a frog is not meant to be straight up and down).
    const mesh = supplied ?? shell!;
    files.write(out('model.glb'), mesh);
    const fits = await fitViews(mesh, views);
    files.write(out('model.json'), { glb: 'model.glb', creature: true, views: fits, ...finishSettings(mesh) });
    console.log(`${key}: ${out('model.glb')} · a creature, no skeleton: hops, squashes and blinks as one body · views ${Object.entries(fits).map(([v, f]) => `${v} ${f.iou}`).join(', ')}`);
    return null;
  }
  built ??= supplied!;
  const misrigged = rigProblem(built);
  if (misrigged) return reject(`rigged body rejected: ${misrigged}`);
  const bad = badModel(readShape(built));
  if (bad) return reject(`rigged body rejected: ${bad}`);
  const tilt = lean(readShape(built));
  const rigged = standUp(built);
  const standingProblem = badModel(readShape(rigged));
  if (standingProblem) return reject(`standing body rejected: ${standingProblem}`);
  files.write(out('model.glb'), rigged);

  const fits = await fitViews(rigged, views);
  files.write(out('model.json'), { glb: 'model.glb', views: fits, ...finishSettings(rigged) });
  console.log(`${key}: ${await relaxModel(files, key)}`);
  const degrees = (slope: number) => Math.round(Math.atan(slope) * 180 / Math.PI * 10) / 10;
  console.log(`${key}: ${out('model.glb')} · stood up ${degrees(tilt.z)}° forward, ${degrees(tilt.x)}° sideways · views ${Object.entries(fits).map(([v, f]) => `${v} ${f.iou}`).join(', ')}`);
  return null;
}

/**
 * What the Blender round trip broke, or null. The face is painted onto the surface from the views, so a head
 * that moved, or a mesh whose corners came apart (flat shading splits every triangle on export: faceted
 * normals, a blotchy torn face on the talk sprites), must not replace the rig that worked.
 */
export function relaxDamage(source: Buffer, relaxed: Buffer, report: RelaxReport): string | null {
  if ((report.headMove ?? 0) > 0.002) return `the head moved ${(report.headMove! * 100).toFixed(2)}% of the height`;
  const before = readShape(source).positions.length / 3, after = readShape(relaxed).positions.length / 3;
  if (after > before * 1.3) return `the mesh came apart on export (${before} -> ${after} corners)`;
  return null;
}

/**
 * With a local Blender, the model's rest pose becomes calm (arms down, feet under the hips): the game's walk
 * then turns bones a little from rest instead of 100 degrees from TRELLIS's raised arms, which pinched the
 * shoulders, glued sleeves to the chest and splayed the hands. model.source.glb keeps the rig as it came, so
 * this can run again; model.json says relaxed. Says what happened, in a line.
 */
export async function relaxModel(files: WorldFiles, key: string, again = false): Promise<string> {
  const out = (name: string) => files.path('cast', key, 'model', name);
  const info = files.readJson(out('model.json')) as { glb: string; relaxed?: boolean; creature?: boolean };
  if (info.creature) return 'a creature has no skeleton to relax';
  if (info.relaxed && !again) return 'rest pose already relaxed';
  const blender = await findBlender();
  if (!blender) return 'rest pose as TRELLIS built it (no local Blender; install Blender 3.6+ for calmer walks)';
  const source = fs.existsSync(out('model.source.glb')) ? fs.readFileSync(out('model.source.glb')) : fs.readFileSync(out(info.glb));
  const done = await relaxPose(source, (line) => console.log(`${key}: ${line}`));
  if (!done) return 'rest pose as TRELLIS built it (Blender could not relax it)';
  const problem = rigProblem(done.glb) ?? badModel(readShape(done.glb)) ?? relaxDamage(source, done.glb, done.report);
  if (problem) return `rest pose as TRELLIS built it (relaxed body rejected: ${problem})`;
  if (!fs.existsSync(out('model.source.glb'))) files.write(out('model.source.glb'), source);
  files.write(out('model.glb'), done.glb);
  files.write(out('model.json'), { ...info, glb: 'model.glb', relaxed: true });
  const arms = Object.values(done.report.armTurn ?? {}).map(Math.round).join('/');
  return `Blender ${blender.version} relaxed the rest pose (arms turned ${arms}° down, feet under the hips)`;
}
