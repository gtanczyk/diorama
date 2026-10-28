// diorama model <slug> [key]: a character as a rigged 3D model, painted by Muse from four sides. Without a
// key, everyone the sprites plan needs (the hero, NPCs who speak): the model is where their poses come from.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { autoRig, reconstruct } from '../model/build.ts';
import { fitViews, refitIfOld } from '../model/fit.ts';
import { lean, readShape, standUp } from '../model/glb.ts';
import { paintViews } from '../model/views.ts';
import { planSprites } from '../model/plan.ts';
import { Story } from '../story/schema.ts';
import { fixedLooks } from '../scene/cast-fixes.ts';
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
    const keys = keyArg ? [keyArg] : (await planSprites(files, story)).map((p) => p.key);
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

  const views = await paintViews(files.memo, key, who.looks ?? '', painting, take);
  for (const [name, png] of Object.entries(views)) files.write(out(`${name}.png`), png);
  const built = given ? fs.readFileSync(given) : await autoRig(files.memo, key, await reconstruct(files.memo, key, [views.front, views.back, views.left, views.right]));
  const tilt = lean(readShape(built));
  const rigged = standUp(built);
  files.write(out('model.glb'), rigged);

  const fits = await fitViews(rigged, views);
  files.write(out('model.json'), { glb: 'model.glb', views: fits });
  const degrees = (slope: number) => Math.round(Math.atan(slope) * 180 / Math.PI * 10) / 10;
  console.log(`${key}: ${out('model.glb')} · stood up ${degrees(tilt.z)}° forward, ${degrees(tilt.x)}° sideways · views ${Object.entries(fits).map(([v, f]) => `${v} ${f.iou}`).join(', ')}`);
}
