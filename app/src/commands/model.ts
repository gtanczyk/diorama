// diorama model <slug> [key]: a character as a rigged 3D model, painted by Muse from four sides. Without a
// key, everyone the sprites plan needs (the hero, NPCs who speak): the model is where their poses come from.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { autoRig, reconstruct } from '../model/build.ts';
import { fitViews, refitIfOld } from '../model/fit.ts';
import { badModel, lean, readShape, standUp } from '../model/glb.ts';
import { paintViews } from '../model/views.ts';
import { planSprites } from '../model/plan.ts';
import { Story } from '../story/schema.ts';
import { fixedLooks, readCastFixes } from '../scene/cast-fixes.ts';
import { readBodies } from '../scene/cast.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'model',
  usage: 'model <slug> [key]       Muse paints each character who needs sprites (or [key]) from 4 sides, TRELLIS + auto-rig make a 3D model (cast/<key>/model/) [--glb rigged.glb: skip TRELLIS and the rig] [--take N] [--refit: only fit the views onto the model again, no calls]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const given = takeOption(args, 'glb', '');
    const refit = args.includes('--refit');
    const [slug, keyArg] = args.filter((a) => a !== '--refit');
    if (!slug) throw new Error('usage: diorama model <slug> [key] [--glb rigged.glb] [--refit]');
    if (refit) {
      const files = new WorldFiles(slug);
      const castDir = files.path('cast');
      for (const key of keyArg ? [keyArg] : fs.readdirSync(castDir).filter((k) => fs.existsSync(files.path('cast', k, 'model', 'model.json')))) {
        await refitIfOld(files.path('cast', key, 'model'), true);
        console.log(`${key}: views fitted again, slice by slice`);
      }
      return;
    }
    if (given && !keyArg) throw new Error('--glb needs the key of the character it is');
    const files = new WorldFiles(slug);
    const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : undefined;
    // Everyone the sprites plan needs, and whoever the person asked to animate (cast_animate, cast/fixes.json).
    const asked = Object.entries(readCastFixes(files)).filter(([, f]) => f.animate).map(([k]) => k);
    const keys = keyArg ? [keyArg] : [...new Set([...(await planSprites(files, story)).map((p) => p.key), ...asked])];
    for (const key of keys) await buildModel(files, key, take, given);
    console.log(`calls sent: muse ${files.memo.sent.muse}, space ${files.memo.sent.space}`);
  },
});

async function buildModel(files: WorldFiles, key: string, take: number, given: string) {
  const world = files.world();
  const found = [world.hero, ...world.places.flatMap((p) => p.things)].find((w) => w.key === key);
  if (!found) throw new Error(`no hero or NPC called ${key}`);
  const who = fixedLooks(files, found);
  const painting = fs.readFileSync(files.path('cast', `${key}-painting.png`));
  const out = (name: string) => files.path('cast', key, 'model', name);

  // Not a person on two legs (cast/figures.json): painted as it is, no skeleton; it hops and squashes as one body.
  const creature = readBodies(files, fs.existsSync)[key]?.upright === false;
  const views = await paintViews(files.memo, key, who.looks ?? '', painting, take, creature);
  for (const [name, png] of Object.entries(views)) files.write(out(`${name}.png`), png);
  // TRELLIS sometimes makes a flat card of a flat drawing: other seeds, then the front alone (depth guessed),
  // and with none of them a body, no model: the character walks with its 2D rig.
  const all = [views.front, views.back, views.left, views.right];
  const tries = [[1, all], [2, all], [3, all], [1, [views.front]]] as const;
  let shell: Buffer | undefined;
  for (const [seed, from] of tries) {
    if (given) break;
    const made = await reconstruct(files.memo, key, [...from], seed);
    const bad = badModel(readShape(made));
    if (!bad) { shell = made; break; }
    console.log(`${key}: TRELLIS (seed ${seed}${from.length === 1 ? ', front only' : ''}) made a model that is ${bad}`);
  }
  const rejected = out('model.json');
  if (!given && !shell) {
    // An older model of this character (a flat one, kept before this gate) must not stay in the game.
    if (fs.existsSync(rejected)) fs.renameSync(rejected, out('model-rejected.json'));
    console.log(`${key}: no 3D model: every try was flat; ${creature ? 'the painted figure hops as it is' : 'the game walks the 2D rig'}`);
    return;
  }
  if (creature) {
    // Make-It-Animatable rigs a person's skeleton only; a creature keeps TRELLIS's mesh as it came (no standing up:
    // a cat or a frog is not meant to be straight up and down).
    const mesh = given ? fs.readFileSync(given) : shell!;
    files.write(out('model.glb'), mesh);
    const fits = await fitViews(mesh, views);
    files.write(out('model.json'), { glb: 'model.glb', creature: true, views: fits });
    console.log(`${key}: ${out('model.glb')} · a creature, no skeleton: hops, squashes and blinks as one body · views ${Object.entries(fits).map(([v, f]) => `${v} ${f.iou}`).join(', ')}`);
    return;
  }
  const built = given ? fs.readFileSync(given) : await autoRig(files.memo, key, shell!);
  const tilt = lean(readShape(built));
  const rigged = standUp(built);
  files.write(out('model.glb'), rigged);

  const fits = await fitViews(rigged, views);
  files.write(out('model.json'), { glb: 'model.glb', views: fits });
  const degrees = (slope: number) => Math.round(Math.atan(slope) * 180 / Math.PI * 10) / 10;
  console.log(`${key}: ${out('model.glb')} · stood up ${degrees(tilt.z)}° forward, ${degrees(tilt.x)}° sideways · views ${Object.entries(fits).map(([v, f]) => `${v} ${f.iou}`).join(', ')}`);
}
