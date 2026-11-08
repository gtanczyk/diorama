// diorama sprites <slug> [key]: walk and talk sprite sheets drawn by Muse over the rigged model's poses,
// only those the world and its story use (src/model/plan.ts).
import { readDrawn } from '../world/drawings.ts';
import fs from 'node:fs';
import sharp from 'sharp';
import { bindExistingAnimation, bindAnimation } from '../scene/animation-source.ts';
import path from 'node:path';
import { gestureIndex } from '../play/gestures.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { planSprites, type CharacterPlan } from '../model/plan.ts';
import { cutSheet, FACINGS, flatGuide, onGrey, paintSheet, POSE_OK, renderGuides, modelSheet, SHEET, TRACED, uvFaceLost, type Facing } from '../model/sprites.ts';
import { animationSettings, animationOptions, saveAnimationSettings, type AnimationSettings } from '../model/animation.ts';
import { Story } from '../story/schema.ts';
import { fixedLooks, readCastFixes } from '../scene/cast-fixes.ts';
import { refitIfOld } from '../model/fit.ts';
import { modelProblem } from '../model/glb.ts';
import { castStyle, readStyled } from '../world/styled.ts';
import { WorldFiles } from '../world/files.ts';

const LEGS_OK = 0.6;
// Walk takes painted again at most, while the best one is traced or left the pose.
const RETAKES = 4;
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

defineCommand({
  name: 'sprites',
  usage: 'sprites <slug> [key]     walk and talk sheets for what the story uses: automatic UV/16 for new textured models, painted/8 fallback (cast/<key>/sprites/; needs `diorama model` first) [--texture model|views] [--coat-correction on|off] [--frames 8|16|32: model texture only; choices persist per character] [--plan: only print what would be drawn] [--take N] [--tries N: up to N takes per walk facing while a frame has its legs wrong]',
  async run(args) {
    const options = animationOptions(takeOption(args, 'texture', ''), takeOption(args, 'frames', ''), takeOption(args, 'coat-correction', ''));
    const takeArg = takeOption(args, 'take', '');
    const tries = Number(takeOption(args, 'tries', '1'));
    const planOnly = args.includes('--plan');
    const [slug, keyArg] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama sprites <slug> [key]');
    const files = new WorldFiles(slug);
    const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : undefined;
    const plans = (await planSprites(files, story)).filter((p) => !keyArg || p.key === keyArg);
    if (!plans.length) throw new Error(keyArg ? `${keyArg} needs no sprites (not the hero, says no lines)` : 'nobody needs sprites');
    const settings = new Map(plans.map((p) => [p.key, animationSettings(files, p.key, options)]));
    if (!planOnly) files.write(files.path('cast', 'sprites-plan.json'), plans);
    // Whether a usable 3D model is there: a creature without one (flat reconstructions) moves as its cut-out.
    const modelled = (key: string) => fs.existsSync(files.path('cast', key, 'model', 'model.json')) && !modelProblem(files.path('cast', key, 'model'));
    for (const p of plans) {
      const talk = Object.entries(p.talk).map(([f, g]) => `${f} [${g.join(', ')}]`).join('; ');
      console.log(p.creature ? `${p.key}: a creature · 0 Muse sheets (${modelled(p.key) ? 'its 3D model moves' : 'no usable 3D model: the cut-out moves as one piece'})` : `${p.key}: ${settings.get(p.key)!.texture === 'model' ? `UV ${settings.get(p.key)!.frames} frames` : 'painted 8 frames'} · walk ${p.walk.join(', ') || '-'} · talk ${talk || '-'} · ${settings.get(p.key)!.texture === 'model' ? 0 : p.walk.length + Object.keys(p.talk).length} Muse sheets`);
    }
    if (planOnly) return;
    for (const p of plans) {
      // A creature has no walk or gestures to paint: its 3D model hops, squashes and blinks in the game itself.
      if (p.creature) {
        console.log(modelled(p.key) ? `${p.key}: a creature, no sheets: it moves as its 3D model` : `${p.key}: a creature, no sheets and no usable 3D model: the cut-out moves as one piece (cast_animate, or diorama model ${slug} ${p.key}, tries a model)`);
        continue;
      }
      if (!fs.existsSync(files.path('cast', p.key, 'model', 'model.json'))) {
        console.log(`${p.key}: no model yet, skipped (diorama model ${slug} ${p.key})`);
        continue;
      }
      const bad = modelProblem(files.path('cast', p.key, 'model'));
      if (bad) {
        console.log(`${p.key}: model is ${bad}, skipped: walks with the 2D rig (diorama model ${slug} ${p.key} tries again)`);
        continue;
      }
      bindExistingAnimation(files, p.key);
      const selected = settings.get(p.key)!;
      if (selected.texture === 'model') await drawModelCharacter(files, p, selected);
      else {
        // The person's sprites_redo rounds (cast/fixes.json) start past the takes painted before, also in a rebuild.
        const take = takeArg ? Number(takeArg) : (RETAKES + 1) * (readCastFixes(files)[p.key]?.spriteTake ?? 0);
        await drawCharacter(files, p, take, tries, selected);
      }
      if (selected.texture === 'model' || Object.keys(options).length || fs.existsSync(files.path('cast', p.key, 'animation.json'))) saveAnimationSettings(files, p.key, selected);
      const modelFile = files.path('cast', p.key, 'model', 'model.json');
      const model = files.readJson(modelFile) as Record<string, unknown>;
      if (selected.texture === 'model') model.texture = 'model';
      else delete model.texture;
      if (selected.coatCorrection !== undefined) model.coatCorrection = selected.coatCorrection;
      files.write(modelFile, model);
      bindAnimation(files, p.key, 'sprites');
    }
    console.log(`calls sent: muse ${files.memo.sent.muse}, spark ${files.memo.sent.spark}`);
  },
});

async function drawCharacter(files: WorldFiles, plan: CharacterPlan, take: number, tries: number, settings: AnimationSettings) {
  const { key } = plan;
  const world = files.world();
  const who = [world.hero, ...world.places.flatMap((p) => p.things)].find((w) => w.key === key);
  const looks = who ? fixedLooks(files, who).looks : '';
  // A world given another style names it, so the sheets follow the restyled character, not the gouache they were made for.
  // A restyled world, or one made from drawings (its style is the drawings' medium, not the default gouache).
  const style = readStyled(files).from || readDrawn(files).length ? castStyle(files, world, key) : undefined;
  const modelDir = files.path('cast', key, 'model');
  const projected: AnimationSettings = { ...settings, texture: 'views', frames: 8 };
  // An older model's views were fitted on the whole silhouette only: the guides would show the profile's face twice.
  if (await refitIfOld(modelDir)) console.log(`${key}: views fitted again, slice by slice`);
  const view = (name: string) => fs.readFileSync(`${modelDir}/${name}.png`);
  const out = (name: string) => files.path('cast', key, 'sprites', name);

  // Walking: the first facing (the profile when it is used) is painted first; the others also see it,
  // so patches and colours stay the same. Muse often hands the textured guide back with a filter over it
  // (mean `same` above TRACED): that sheet looks like the 3D render, and as the first facing it passes the
  // look on to every other facing. So a take that is traced or left the pose is painted again, up to
  // RETAKES times, and the first drawn take that keeps the pose wins. Retakes cycle through three guides,
  // because no one of them works for every facing (foghorn, 3 takes each): over a grey clay figure Muse
  // draws the back view every time but turns the three-quarter back into a profile; over flat colour
  // blocks it keeps the pose about half the time; over the textured render it traces about 3 takes in 4.
  // A frame whose legs do not follow the guide makes the walk skip: with --tries, more takes, and the
  // whole take whose legs follow best wins (frames mixed from several takes do not match).
  const facings: Record<string, { sheet: string; yaw: number; stand: number; off: number[]; iou: number[]; legs: number[]; same: number[] }> = {};
  if (plan.walk.length) {
    const guides = await renderGuides(modelDir, plan.walk, undefined, false, projected);
    const clay = await renderGuides(modelDir, plan.walk, undefined, true, projected);
    const shown: Record<string, Buffer[]> = {};
    for (const f of plan.walk) {
      const grey = await onGrey(guides[f]);
      files.write(out(`guide-${f}.png`), grey);
      shown[f] = [grey, await onGrey(clay[f]), await flatGuide(grey)];
    }
    const first: Facing = plan.walk.includes('right') ? 'right' : plan.walk[0];
    const refsFor = (f: Facing, painted?: Buffer) => [f.startsWith('back') ? view('back') : view('front'), painted ?? view('right')];
    const painted: Record<string, Buffer> = {};
    const walk = async (f: Facing, refs: Buffer[]) => {
      type Take = Awaited<ReturnType<typeof cutSheet>> & { painted: Buffer; n: number; faded: number[] };
      const takes: Take[] = [];
      let n = take;
      const another = async () => {
        const p = await paintSheet(files.memo, key, f, looks, shown[f][(n - take) % shown[f].length], refs, n, 0, style);
        // Always measured against the textured guide: that is the look a traced sheet keeps.
        const cut = await cutSheet(guides[f], p);
        takes.push({ ...cut, painted: p, n: n++, faded: await fadedFrames(cut.sheet) });
      };
      const traced = (t: Take) => mean(t.same) > TRACED;
      // A take that left the pose (Muse turned some frames to another facing) is worst, then traced takes;
      // among drawn takes the legs that follow best win, among traced ones the least traced.
      // A take with frames gone grey (Muse drained the colour from a few cells) flickers as it walks: below traced.
      // Before any pose ranking: a creature's guide is often never matched closely, so every take may be 0 there.
      const rank = (t: Take) => (t.faded.length ? 0 : 3) + (mean(t.iou) < POSE_OK ? 0 : traced(t) ? 1 : 2);
      const pick = () => takes.reduce((a, b) => {
        if (rank(a) !== rank(b)) return rank(b) > rank(a) ? b : a;
        return traced(a) ? (mean(b.same) < mean(a.same) ? b : a) : (mean(b.legs) > mean(a.legs) ? b : a);
      });
      await another();
      for (let t = 1; t <= RETAKES && rank(pick()) < 5; t++) await another();
      for (let t = 1; t < tries && Math.min(...pick().legs) < LEGS_OK; t++) await another();
      const best = pick();
      painted[f] = best.painted;
      files.write(out(`painted-${f}.png`), best.painted);
      files.write(out(`${f}.png`), best.sheet);
      facings[f] = { sheet: `${f}.png`, yaw: FACINGS[f], stand: best.stand, off: best.off, iou: best.iou, legs: best.legs, same: best.same };
      console.log(`${key} walk ${f}: take ${best.n + 1} (${['textured', 'clay', 'flat'][(best.n - take) % 3]} guide, ${takes.length} painted), pose IoU ${mean(best.iou).toFixed(3)}, legs ${mean(best.legs).toFixed(3)} (worst ${Math.min(...best.legs)}), same ${mean(best.same).toFixed(3)}${best.off.length ? `, off the walk: cell ${best.off.join(', ')}` : ''}${best.faded.length ? `  <- frames ${best.faded.join(', ')} lost their colour, try --take` : ''}${traced(best) ? '  <- Muse kept the 3D look, try --take' : mean(best.iou) < POSE_OK ? '  <- frames left the pose, try --take' : ''}`);
    };
    await walk(first, [view('front'), view('right')]);
    await Promise.all(plan.walk.filter((f) => f !== first).map((f) => walk(f, refsFor(f, painted[first]))));
  }

  // Talking: the gestures this character's lines use, in the facing its conversation is held in. The
  // painted views are the reference, not a walk sheet: with a walk sheet Muse draws the legs walking.
  const talk: Record<string, { sheet: string; yaw: number; gestures: string[]; iou: number[]; same: number[] }> = {};
  await Promise.all(Object.entries(plan.talk).map(async ([facing, names]) => {
    const f = facing as Facing;
    const used = names.map(gestureIndex);
    // Muse redraws a half-empty grid as a few big figures, so the used gestures repeat to fill all 8
    // cells (the sheet costs the same); cell i < used.length is gestures[i].
    const cells = Array.from({ length: SHEET.cols * SHEET.rows }, (_, i) => used[i % used.length]);
    const guide = (await renderGuides(modelDir, [f], cells, false, projected))[f];
    const g = await onGrey(guide);
    files.write(out(`talk-guide-${f}.png`), g);
    const refs = [view('front'), view('right')];
    let p = await paintSheet(files.memo, key, f, looks, g, refs, take, used.length, style);
    let cut = await cutSheet(guide, p);
    const score = () => mean(cut.same.slice(0, used.length));
    // From some angles the hands hide in front of the body and Muse hands the guide back unchanged.
    for (let t = 1; t <= 2 && score() > TRACED; t++) {
      p = await paintSheet(files.memo, key, f, looks, g, refs, take + t, used.length, style);
      cut = await cutSheet(guide, p);
    }
    files.write(out(`talk-painted-${f}.png`), p);
    files.write(out(`talk-${f}.png`), cut.sheet);
    talk[f] = { sheet: `talk-${f}.png`, yaw: FACINGS[f], gestures: names, iou: cut.iou.slice(0, used.length), same: cut.same.slice(0, used.length) };
    console.log(`${key} talk ${f} [${names.join(', ')}]: pose IoU ${mean(cut.iou.slice(0, used.length)).toFixed(3)}, same ${score().toFixed(3)}${score() > TRACED ? '  <- Muse kept the 3D look, try --take' : ''}`);
  }));

  files.write(out('sprites.json'), {
    cols: SHEET.cols, rows: SHEET.rows, frames: SHEET.cols * SHEET.rows, width: SHEET.width, height: SHEET.height,
    // In each cell the feet stand at (cell width / 2, cell height * feetAt); the figure is about `px` tall.
    feetAt: SHEET.feetAt, px: SHEET.px,
    // Walk sheets: 8 frames of a full cycle; `stand` is the frame shown standing still; a walk skips the `off` cells.
    facings,
    // Talk sheets: cell i is gestures[i]; cell 0 is `listen` (also how an NPC stands when idle).
    talk,
    // The gesture for each line this character says, by its text.
    lines: plan.lines,
  });
}

/** Direct UV sheets keep anatomy tied to the mesh; no Muse repainting or silhouette fitting. */
export async function drawModelCharacter(files: WorldFiles, plan: CharacterPlan, settings: AnimationSettings) {
  const modelDir = files.path('cast', plan.key, 'model');
  const grid = modelSheet(settings.frames);
  // TRELLIS often bakes a blank face: then the front painting goes on it (Spark compares the two heads once).
  const modelFile = path.join(modelDir, 'model.json');
  if (fs.existsSync(modelFile) && fs.existsSync(path.join(modelDir, 'front.png'))) {
    const fromViews = await uvFaceLost(files.memo, plan.key, modelDir, settings).catch((error) => {
      console.log(`${plan.key}: face check failed (${error instanceof Error ? error.message : String(error)}); the model texture's face stays`);
      return false;
    });
    const info = files.readJson(modelFile) as Record<string, unknown>;
    if (fromViews) info.face = 'views';
    else delete info.face;
    files.write(modelFile, info);
    console.log(`${plan.key}: face ${fromViews ? 'from the front painting (the UV face came out blank)' : 'from the model texture'}`);
  }
  const facings: Record<string, { sheet: string; yaw: number; stand: number; off: number[] }> = {};
  const talk: Record<string, { sheet: string; yaw: number; gestures: string[] }> = {};
  const images: Record<string, Buffer> = {};
  // Finish rendering everything before replacing any active sheet or its metadata.
  if (plan.walk.length) {
    const walk = await renderGuides(modelDir, plan.walk, undefined, false, settings);
    for (const f of plan.walk) {
      const sheet = `model-${settings.frames}-${f}.png`;
      images[sheet] = walk[f];
      facings[f] = { sheet, yaw: FACINGS[f], stand: settings.frames, off: [] };
    }
  }
  for (const [facing, names] of Object.entries(plan.talk)) {
    const f = facing as Facing;
    const gestures = names.map(gestureIndex);
    if (gestures.some((i) => i < 0)) throw new Error(`${plan.key}: unknown talking gesture`);
    const sheet = `model-${settings.frames}-talk-${f}.png`;
    images[sheet] = (await renderGuides(modelDir, [f], gestures, false, settings))[f];
    talk[f] = { sheet, yaw: FACINGS[f], gestures: names };
  }
  const out = (name: string) => files.path('cast', plan.key, 'sprites', name);
  for (const [name, image] of Object.entries(images)) files.write(out(name), image);
  const { elevation: _elevation, ...layout } = grid;
  files.write(out('sprites.json'), { ...layout, facings, talk, lines: plan.lines });
  console.log(`${plan.key}: UV sprites · ${settings.frames} walk frames + standing · ${Object.keys(talk).length} talk sheets`);
}

/**
 * Cells of a cut walk sheet whose colour faded: the mean chroma of their figure under 60% of the sheet's
 * median cell (anoti's oil-pastel dinosaur walked three of eight frames in grey).
 */
export async function fadedFrames(sheet: Buffer): Promise<number[]> {
  const { data, info } = await sharp(sheet).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [cw, ch] = [info.width / SHEET.cols, info.height / SHEET.rows];
  const chroma: number[] = [];
  for (let cell = 0; cell < SHEET.cols * SHEET.rows; cell++) {
    const [x0, y0] = [Math.floor((cell % SHEET.cols) * cw), Math.floor(Math.floor(cell / SHEET.cols) * ch)];
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y0 + ch; y += 2) for (let x = x0; x < x0 + cw; x += 2) {
      const i = (Math.floor(y) * info.width + Math.floor(x)) * 4;
      if (data[i + 3] < 200) continue;
      sum += Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]);
      n++;
    }
    chroma.push(n > 50 ? sum / n : NaN);
  }
  const known = chroma.filter((c) => !Number.isNaN(c)).sort((a, b) => a - b);
  const median = known[Math.floor(known.length / 2)] ?? 0;
  return chroma.flatMap((c, i) => (median > 25 && c < median * 0.6 ? [i] : []));
}
