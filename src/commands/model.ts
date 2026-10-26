// diorama model <slug> [key]: the hero as a rigged 3D model, painted by Muse from four sides.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { fitView, VIEWS, type ViewName } from '../model/fit.ts';
import { normalise, readShape } from '../model/glb.ts';
import { paintViews } from '../model/views.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'model',
  usage: 'model <slug> [key]       Muse paints the figure from 4 sides, fits them to a rigged 3D model (cast/<key>/model/) --glb rigged.glb [--take N]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const given = takeOption(args, 'glb', '');
    const [slug, keyArg] = args;
    if (!slug || !given) throw new Error('usage: diorama model <slug> [key] --glb rigged.glb');
    const files = new WorldFiles(slug);
    const world = files.world();
    const who = [world.hero, ...world.places.flatMap((p) => p.things)].find((w) => w.key === (keyArg ?? world.hero.key));
    if (!who) throw new Error(`no hero or NPC called ${keyArg}`);
    const key = who.key;
    const painting = fs.readFileSync(files.path('cast', `${key}-painting.png`));
    const out = (name: string) => files.path('cast', key, 'model', name);

    const views = await paintViews(files.memo, key, who.looks ?? '', painting, take);
    for (const [name, png] of Object.entries(views)) files.write(out(`${name}.png`), png);
    // The rigged model comes from TRELLIS (front view) + Make-It-Animatable, run outside for now.
    const rigged = fs.readFileSync(given);
    files.write(out('model.glb'), rigged);

    const shape = normalise(readShape(rigged));
    const fits: Record<string, { image: string; iou: number }> = {};
    for (const v of Object.keys(VIEWS) as ViewName[]) fits[v] = { image: `${v}.png`, ...(await fitView(shape, v, views[v])) };
    files.write(out('model.json'), { glb: 'model.glb', views: fits });
    console.log(`${key}: ${out('model.glb')} · views ${Object.entries(fits).map(([v, f]) => `${v} ${f.iou}`).join(', ')}`);
    console.log(`calls sent: muse ${files.memo.sent.muse}`);
  },
});
