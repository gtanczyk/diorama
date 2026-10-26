// diorama sprites <slug> [key]: walk and talk sprite sheets drawn by Muse over the rigged model's poses,
// only those the world and its story use (src/model/plan.ts).
import fs from 'node:fs';
import { gestureIndex } from '../play/gestures.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { planSprites, type CharacterPlan } from '../model/plan.ts';
import { cutSheet, FACINGS, onGrey, paintSheet, renderGuides, SHEET, TRACED, type Facing } from '../model/sprites.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

const LEGS_OK = 0.6;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

defineCommand({
  name: 'sprites',
  usage: 'sprites <slug> [key]     walk and talk sheets for what the story uses: the 3D model poses, Muse draws each sheet again (cast/<key>/sprites/; needs `diorama model` first) [--plan: only print what would be drawn] [--take N] [--tries N: up to N takes per walk facing while a frame has its legs wrong]',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const tries = Number(takeOption(args, 'tries', '1'));
    const planOnly = args.includes('--plan');
    const [slug, keyArg] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama sprites <slug> [key]');
    const files = new WorldFiles(slug);
    const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : undefined;
    const plans = (await planSprites(files, story)).filter((p) => !keyArg || p.key === keyArg);
    if (!plans.length) throw new Error(keyArg ? `${keyArg} needs no sprites (not the hero, says no lines)` : 'nobody needs sprites');
    files.write(files.path('cast', 'sprites-plan.json'), plans);
    for (const p of plans) {
      const talk = Object.entries(p.talk).map(([f, g]) => `${f} [${g.join(', ')}]`).join('; ');
      console.log(`${p.key}: walk ${p.walk.join(', ') || '-'} · talk ${talk || '-'} · ${p.walk.length + Object.keys(p.talk).length} Muse sheets`);
    }
    if (planOnly) return;
    for (const p of plans) {
      if (!fs.existsSync(files.path('cast', p.key, 'model', 'model.json'))) {
        console.log(`${p.key}: no model yet, skipped (diorama model ${slug} ${p.key})`);
        continue;
      }
      await drawCharacter(files, p, take, tries);
    }
    console.log(`calls sent: muse ${files.memo.sent.muse}, spark ${files.memo.sent.spark}`);
  },
});

async function drawCharacter(files: WorldFiles, plan: CharacterPlan, take: number, tries: number) {
  const { key } = plan;
  const world = files.world();
  const who = [world.hero, ...world.places.flatMap((p) => p.things)].find((w) => w.key === key);
  const looks = who?.looks ?? '';
  const modelDir = files.path('cast', key, 'model');
  const view = (name: string) => fs.readFileSync(`${modelDir}/${name}.png`);
  const out = (name: string) => files.path('cast', key, 'sprites', name);

  // Walking: the first facing (the profile when it is used) is painted first; the others also see it,
  // so patches and colours stay the same. A frame whose legs do not follow the guide makes the walk
  // skip: with --tries, more takes, and the whole take whose legs follow best wins (frames mixed from
  // several takes do not match, and the take that traces the guide closest is the stiffest).
  const facings: Record<string, { sheet: string; yaw: number; stand: number; iou: number[]; legs: number[] }> = {};
  if (plan.walk.length) {
    const guides = await renderGuides(modelDir, plan.walk);
    const grey: Record<string, Buffer> = {};
    for (const f of plan.walk) files.write(out(`guide-${f}.png`), (grey[f] = await onGrey(guides[f])));
    const first: Facing = plan.walk.includes('right') ? 'right' : plan.walk[0];
    const refsFor = (f: Facing, painted?: Buffer) => [f.startsWith('back') ? view('back') : view('front'), painted ?? view('right')];
    const painted: Record<string, Buffer> = {};
    // Muse sometimes hands the guide back with only a filter over it (pose IoU above TRACED); that sheet
    // looks like the 3D render, and a traced first facing passes the look on to every other facing.
    const paintUntraced = async (f: Facing, refs: Buffer[]) => {
      let p = await paintSheet(files.memo, key, f, looks, grey[f], refs, take);
      for (let t = 1; t <= 2 && mean((await cutSheet(guides[f], p)).iou) > TRACED; t++) {
        p = await paintSheet(files.memo, key, f, looks, grey[f], refs, take + t);
      }
      return p;
    };
    painted[first] = await paintUntraced(first, [view('front'), view('right')]);
    await Promise.all(plan.walk.filter((f) => f !== first).map(async (f) => {
      painted[f] = await paintUntraced(f, refsFor(f, painted[first]));
    }));
    await Promise.all(plan.walk.map(async (f) => {
      files.write(out(`painted-${f}.png`), painted[f]);
      const takes = [await cutSheet(guides[f], painted[f])];
      const pick = () => takes.reduce((a, b) => (mean(b.legs) > mean(a.legs) ? b : a));
      let best = pick();
      for (let t = 1; t < tries && Math.min(...best.legs) < LEGS_OK; t++) {
        const refs = f === first ? [view('front'), view('right')] : refsFor(f, painted[first]);
        takes.push(await cutSheet(guides[f], await paintSheet(files.memo, key, f, looks, grey[f], refs, take + t)));
        best = pick();
      }
      files.write(out(`${f}.png`), best.sheet);
      facings[f] = { sheet: `${f}.png`, yaw: FACINGS[f], stand: best.stand, iou: best.iou, legs: best.legs };
      console.log(`${key} walk ${f}: take ${takes.indexOf(best) + 1} of ${takes.length}, pose IoU ${mean(best.iou).toFixed(3)}, legs ${mean(best.legs).toFixed(3)} (worst ${Math.min(...best.legs)})${mean(best.iou) > TRACED ? '  <- Muse kept the 3D look, try --take' : ''}`);
    }));
  }

  // Talking: the gestures this character's lines use, in the facing its conversation is held in. The
  // painted views are the reference, not a walk sheet: with a walk sheet Muse draws the legs walking.
  const talk: Record<string, { sheet: string; yaw: number; gestures: string[]; iou: number[] }> = {};
  await Promise.all(Object.entries(plan.talk).map(async ([facing, names]) => {
    const f = facing as Facing;
    const used = names.map(gestureIndex);
    // Muse redraws a half-empty grid as a few big figures, so the used gestures repeat to fill all 8
    // cells (the sheet costs the same); cell i < used.length is gestures[i].
    const cells = Array.from({ length: SHEET.cols * SHEET.rows }, (_, i) => used[i % used.length]);
    const guide = (await renderGuides(modelDir, [f], cells))[f];
    const g = await onGrey(guide);
    files.write(out(`talk-guide-${f}.png`), g);
    const refs = [view('front'), view('right')];
    let p = await paintSheet(files.memo, key, f, looks, g, refs, take, used.length);
    let cut = await cutSheet(guide, p);
    const score = () => mean(cut.iou.slice(0, used.length));
    // From some angles the hands hide in front of the body and Muse hands the guide back unchanged.
    for (let t = 1; t <= 2 && score() > TRACED; t++) {
      p = await paintSheet(files.memo, key, f, looks, g, refs, take + t, used.length);
      cut = await cutSheet(guide, p);
    }
    files.write(out(`talk-painted-${f}.png`), p);
    files.write(out(`talk-${f}.png`), cut.sheet);
    talk[f] = { sheet: `talk-${f}.png`, yaw: FACINGS[f], gestures: names, iou: cut.iou.slice(0, used.length) };
    console.log(`${key} talk ${f} [${names.join(', ')}]: pose IoU ${score().toFixed(3)}${score() > TRACED ? '  <- Muse kept the 3D look, try --take' : ''}`);
  }));

  files.write(out('sprites.json'), {
    cols: SHEET.cols, rows: SHEET.rows, frames: SHEET.cols * SHEET.rows, width: SHEET.width, height: SHEET.height,
    // In each cell the feet stand at (cell width / 2, cell height * feetAt); the figure is about `px` tall.
    feetAt: SHEET.feetAt, px: SHEET.px,
    // Walk sheets: 8 frames of a full cycle; `stand` is the frame shown standing still.
    facings,
    // Talk sheets: cell i is gestures[i]; cell 0 is `listen` (also how an NPC stands when idle).
    talk,
    // The gesture for each line this character says, by its text.
    lines: plan.lines,
  });
}
