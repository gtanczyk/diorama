// diorama sprites <slug> [key]: walk-cycle sprite sheets drawn by Muse over the rigged model's walk.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { cutSheet, FACINGS, onGrey, paintSheet, renderGuides, SHEET, type Facing } from '../model/sprites.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'sprites',
  usage: 'sprites <slug> [key]     walk sheets for 5 facings: the 3D model walks, Muse draws each sheet again (cast/<key>/sprites/; needs `diorama model` first) [--take N]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const [slug, keyArg] = args;
    if (!slug) throw new Error('usage: diorama sprites <slug> [key]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const who = [world.hero, ...world.places.flatMap((p) => p.things)].find((w) => w.key === (keyArg ?? world.hero.key));
    if (!who) throw new Error(`no hero or NPC called ${keyArg}`);
    const key = who.key;
    const modelDir = files.path('cast', key, 'model');
    if (!fs.existsSync(`${modelDir}/model.json`)) throw new Error(`no model for ${key}: run diorama model ${slug} ${key} first`);
    const view = (name: string) => fs.readFileSync(`${modelDir}/${name}.png`);
    const out = (name: string) => files.path('cast', key, 'sprites', name);
    const looks = who.looks ?? '';

    const facings = Object.keys(FACINGS) as Facing[];
    const guides = await renderGuides(modelDir, facings);
    const grey: Record<string, Buffer> = {};
    for (const f of facings) {
      grey[f] = await onGrey(guides[f]);
      files.write(out(`guide-${f}.png`), grey[f]);
    }
    // The profile first; every other facing also sees it, so patches and colours stay the same.
    const painted: Record<string, Buffer> = {};
    painted.right = await paintSheet(files.memo, key, 'right', looks, grey.right, [view('front'), view('right')], take);
    await Promise.all(facings.filter((f) => f !== 'right').map(async (f) => {
      const side = f.startsWith('back') ? view('back') : view('front');
      painted[f] = await paintSheet(files.memo, key, f, looks, grey[f], [side, painted.right], take);
    }));

    const sheets: Record<string, { sheet: string; yaw: number; iou: number[] }> = {};
    for (const f of facings) {
      files.write(out(`painted-${f}.png`), painted[f]);
      const { sheet, iou } = await cutSheet(guides[f], painted[f]);
      files.write(out(`${f}.png`), sheet);
      sheets[f] = { sheet: `${f}.png`, yaw: FACINGS[f], iou };
      const mean = iou.reduce((a, b) => a + b, 0) / iou.length;
      console.log(`${key} ${f}: pose kept, IoU ${mean.toFixed(3)} (min ${Math.min(...iou)})${mean < 0.75 ? '  <- check it, or try --take' : ''}`);
    }
    files.write(out('sprites.json'), {
      cols: SHEET.cols, rows: SHEET.rows, frames: SHEET.cols * SHEET.rows, width: SHEET.width, height: SHEET.height,
      // In each cell the feet stand at (cell width / 2, cell height * feetAt); the figure is about `px` tall.
      feetAt: SHEET.feetAt, px: SHEET.px, facings: sheets,
    });
    console.log(`calls sent: muse ${files.memo.sent.muse}`);
  },
});
