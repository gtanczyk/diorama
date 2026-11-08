// Walk-cycle sprites of a figure: the rigged model (cast/<key>/model/) walks in a grid of frames for one
// facing, Muse draws that sheet again by hand in the world's painted style, keeping every pose and
// position, and each painted frame is cut out and lined up with the frame it was drawn over. The
// model gives the poses; everything seen in the game is Muse's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import type { AnimationSettings } from './animation.ts';
import { chromium } from '../commands/explore.ts';
import { museEdit } from '../meta/muse.ts';
import { askSparkJson } from '../meta/spark.ts';
import type { Memo } from '../meta/memo.ts';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { components, dilate, maskBox, maskIou } from '../image/raster.ts';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web');

/** The five facings drawn; the three facing left are these mirrored. yaw 0 faces the viewer, PI/2 screen right. */

/** Below this mean pose IoU a walk take has frames facing the wrong way or legs that hardly walk. */
export const POSE_OK = 0.85;
export const FACINGS = { front: 0, 'front-right': Math.PI / 4, right: Math.PI / 2, 'back-right': (3 * Math.PI) / 4, back: Math.PI } as const;
export type Facing = keyof typeof FACINGS;

/** One sheet: 8 frames of a full walk cycle in 4 columns and 2 rows, Muse's own size. */
export const SHEET = { cols: 4, rows: 2, width: 1200, height: 896, feetAt: 0.95, px: 385, elevation: 0.18 } as const;
/** One extra cell is reserved for standing; talk uses the same cell dimensions and grid. */
export function modelSheet(frames: number) {
  if (![8, 16, 32].includes(frames)) throw new Error('Model sprites require 8, 16 or 32 walk frames');
  const rows = Math.ceil((frames + 1) / SHEET.cols);
  // Keep painted 8-cell guides unchanged. Direct UV sheets have no provider size limit:
  // render each cell at 1.5x in both axes to retain finer facial and hand detail.
  const scale = 1.5;
  return { ...SHEET, rows, frames, width: SHEET.width * scale, height: rows * (SHEET.height / SHEET.rows) * scale, px: SHEET.px * scale };
}

const GREY = { r: 217, g: 217, b: 217 };

type RoutePage = {
  route(url: string, fn: (route: { request(): { url(): string }; fulfill(o: { status?: number; contentType?: string; body: string | Buffer }): Promise<void> }) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(js: string): Promise<T>;
  on(event: 'pageerror', fn: (e: { message: string }) => void): void;
};

/**
 * Mean `same` (cutSheet) above this means Muse gave the 3D guide back with a filter over it instead of
 * drawing it again. On foghorn's walk sheets, sheets drawn again scored 0.22-0.37 and traced ones 0.60-0.78;
 * pose IoU did not tell them apart (a drawn sheet can follow the pose as closely as a traced one).
 */
export const TRACED = 0.5;

/**
 * A walk cell whose painted figure is shorter than this share of the sheet's usual one is not a step (a
 * crouch, a sit). Walk frames vary by under 6% (5 worlds, 18 sheets); lamp-quarter's crouches were 0.73-0.78.
 */
export const OFF_GAIT = 0.88;

/**
 * The model walking (or, given `gestures`, standing in those talking poses of src/play/gestures.ts, one
 * per cell), one transparent sheet per facing, rendered in headless Chromium with WebGL.
 */
export async function renderGuides(modelDir: string, facings: Facing[], gestures?: number[], /** grey clay, no textures */ plain = false, animation?: AnimationSettings, /** model.json fields to override */ over: Record<string, unknown> = {}): Promise<Record<string, Buffer>> {
  const info = { ...JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8')), ...over };
  if (animation) {
    info.texture = animation.texture;
    if (animation.coatCorrection !== undefined) info.coatCorrection = animation.coatCorrection;
  }
  const js = (await build({ entryPoints: [path.join(WEB, 'sheet.ts')], bundle: true, format: 'esm', write: false, target: 'es2022' })).outputFiles[0].text;
  const browser = await (await chromium()).launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  try {
    const page = (await browser.newPage()) as unknown as RoutePage;
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('http://sprites.local/**', async (route) => {
      const file = new URL(route.request().url()).pathname.slice(1);
      if (!file) return route.fulfill({ contentType: 'text/html', body: `<!doctype html><script type="module">${js}</script>` });
      const at = path.join(modelDir, path.basename(file));
      if (!fs.existsSync(at)) return route.fulfill({ status: 404, body: '' });
      return route.fulfill({ contentType: file.endsWith('.png') ? 'image/png' : 'application/octet-stream', body: fs.readFileSync(at) });
    });
    await page.goto('http://sprites.local/');
    const out: Record<string, Buffer> = {};
    const direct = animation?.texture === 'model';
    for (const facing of facings) {
      const ask = { info, base: 'http://sprites.local', yaw: FACINGS[facing], gestures, plain, ...SHEET, ...(direct && modelSheet(animation.frames)), stand: direct && !gestures };
      const url = await page.evaluate<string>(`window.renderSheet(${JSON.stringify(ask)})`);
      if (errors.length) throw new Error(`sheet page: ${errors.join('; ')}`);
      out[facing] = Buffer.from(url.split(',')[1], 'base64');
    }
    return out;
  } finally {
    await browser.close();
  }
}

/** The guide on Muse's plain grey, which is what it is asked to keep. */
export const onGrey = (guide: Buffer) => sharp(guide).flatten({ background: GREY }).png().toBuffer();

/** The guide as flat colour blocks (median filter, 8 colours): the render's shading is gone, nothing to trace. */
export const flatGuide = async (grey: Buffer) =>
  sharp(await sharp(grey).median(9).png().toBuffer()).png({ palette: true, colours: 8, dither: 0 }).toBuffer();

const SEEN: Record<Facing, string> = {
  front: 'walking towards the viewer, face to the viewer',
  'front-right': 'walking diagonally towards the viewer and to the right of the picture (three-quarter view), face visible',
  right: 'walking to the right of the picture, seen exactly from the side in profile',
  'back-right': 'walking diagonally away from the viewer and to the right of the picture, seen three-quarters from behind: back of the head, hardly any face',
  back: 'walking straight away from the viewer, seen from behind: back of the head and back of the clothes, no face',
};

/**
 * Muse draws the sheet again from scratch over the guide. `refs`: the character (Muse's painted view for
 * that side) and, for consistency across facings, a sheet already painted. `style`: the world's style, named
 * once the world was given another one than it was made in (style_set); else the painterly gouache it was made for.
 */
export function paintSheet(memo: Memo, key: string, facing: Facing, looks: string, guide: Buffer, refs: Buffer[], take = 0, talkFrames = 0, style?: string): Promise<Buffer> {
  const talk = talkFrames > 0; // the sheet is always full: Muse redraws a half-empty grid as a few big figures
  const what = talk
    ? `a talking sprite sheet: eight frames of one character standing still and talking, ${SEEN[facing].replace(/^walking/, 'turned')}, gesturing with empty hands (holding nothing) and the head, mouth slightly open in some frames; where the guide's coat bulges around a hand, it is only the hand gesture`
    : `a walk-cycle sprite sheet: eight frames of one character ${SEEN[facing]}`;
  return museEdit(memo, {
    label: `${key}-${talk ? 'talk' : 'sprites'}-${facing}`, take, size: `${SHEET.width}x${SHEET.height}`, images: [guide, ...refs],
    prompt: `The first image is only a rough 3D pose guide for ${what}. ` +
      `Draw this sheet again from scratch as a hand-painted 2D game sprite sheet of the character in the other pictures (${looks}): same face, hair, headwear, clothes, patches, footwear and colours, ${style ? `in their style: ${style}` : 'in their painterly gouache style'}. ` +
      // Said for people, "boots" and "clothing folds" dressed an oil-pastel dinosaur in a vest and boots (anoti).
      'Only what the character wears in those pictures: an animal or a creature that wears nothing there stays bare, with its own skin, claws and feet. ' +
      `Each frame: exactly the same position, size, facing and body pose as the guide (same leg, arm and hand positions), but clean anatomy: one face, natural hands or paws, feet or footwear that keep their shape, smooth readable shapes, no patchy textures, no 3D or CG look. ` +
      // A thing the model's views left standing at the feet is fused to a boot in the guide: a plank or a case swinging with the leg.
      'Anything in the guide that lies on the ground or sticks out flat from the feet (a slab, a plank, a box, a case) is not part of the character: leave it out. ' +
      'Plain flat light grey background, no ground shadows, nothing on the ground, nothing else.',
  });
}

type Rgba = { data: Buffer; width: number; height: number };
const rgba = async (png: Buffer, size?: [number, number]): Promise<Rgba> => {
  let img = sharp(png).ensureAlpha();
  if (size) img = img.resize(size[0], size[1], { fit: 'fill' });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
};

/** Background of a painted cell: pixels joined to its border that are close to the border's median colour. */
function background(img: Rgba, [x0, y0, w, h]: number[], tolerance = 26): Mask {
  const px = (x: number, y: number) => ((y0 + y) * img.width + x0 + x) * 4;
  const border: number[][] = [];
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) border.push([...img.data.subarray(px(x, y), px(x, y) + 3)]);
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) border.push([...img.data.subarray(px(x, y), px(x, y) + 3)]);
  const med = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  const near = (i: number) => {
    const o = px(i % w, Math.floor(i / w));
    return Math.hypot(img.data[o] - med[0], img.data[o + 1] - med[1], img.data[o + 2] - med[2]) < tolerance;
  };
  const bg = emptyMask(w, h);
  const stack: number[] = [];
  const push = (i: number) => {
    if (!bg.bits[i] && near(i)) { bg.bits[i] = 1; stack.push(i); }
  };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop()!;
    const x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < w * (h - 1)) push(i + w);
  }
  return bg;
}

/**
 * How closely the drawn figure keeps the guide's own shading: the correlation of the two images' edge
 * strength (Sobel on luminance) inside both figures, away from the outline. A sheet drawn again has its
 * own folds, hair and face, about 0.2-0.4; the guide with a filter over it keeps the render's edges, 0.6+.
 * Colour alone does not tell them apart: Muse repaints a traced figure in other colours just as often.
 */
function sameEdges(guide: Buffer, drawn: Buffer, W: number, [x0, y0, cw, ch]: number[]): number {
  const lum = (d: Buffer, x: number, y: number) => { const i = ((y0 + y) * W + x0 + x) * 4; return 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; };
  const edge = (d: Buffer, x: number, y: number) => {
    const p = (dx: number, dy: number) => lum(d, x + dx, y + dy);
    const gx = p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1);
    const gy = p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1);
    return Math.hypot(gx, gy);
  };
  const inside = (x: number, y: number) => {
    const i = ((y0 + y) * W + x0 + x) * 4 + 3;
    return guide[i] > 40 && drawn[i] > 0;
  };
  const a: number[] = [];
  const b: number[] = [];
  for (let y = 4; y < ch - 4; y++) for (let x = 4; x < cw - 4; x++) {
    if (!inside(x, y) || !inside(x + 3, y) || !inside(x - 3, y) || !inside(x, y + 3) || !inside(x, y - 3)) continue;
    a.push(edge(guide, x, y));
    b.push(edge(drawn, x, y));
  }
  if (a.length < 50) return 0;
  const [ma, mb] = [a.reduce((s, v) => s + v, 0) / a.length, b.reduce((s, v) => s + v, 0) / b.length];
  let [ab, aa, bb] = [0, 0, 0];
  for (let i = 0; i < a.length; i++) { ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; }
  return aa && bb ? ab / Math.sqrt(aa * bb) : 0;
}

/**
 * Cuts each painted frame out of its grey and lines it up with its guide frame: same feet line, same
 * centre, same height. Returns the transparent sheet and how well each frame kept the guide's pose (IoU)
 * and its look (`same`, sameEdges).
 */
export async function cutSheet(guidePng: Buffer, paintedPng: Buffer): Promise<{ sheet: Buffer; iou: number[]; legs: number[]; same: number[]; stand: number; off: number[] }> {
  const { cols, rows, width: W, height: H } = SHEET;
  const guide = await rgba(guidePng, [W, H]);
  const painted = await rgba(paintedPng, [W, H]);
  const out = Buffer.alloc(W * H * 4);
  const [cw, ch] = [W / cols, H / rows];
  const iou: number[] = [];
  const legs: number[] = [];
  const same: number[] = [];
  const spread: number[] = [];
  const tall: number[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const cell = [(i % cols) * cw, Math.floor(i / cols) * ch, cw, ch];
    const [x0, y0] = cell;
    const want = emptyMask(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) want.bits[y * cw + x] = guide.data[((y0 + y) * W + x0 + x) * 4 + 3] > 40 ? 1 : 0;
    const bg = background(painted, cell);
    const fig = emptyMask(cw, ch);
    for (let k = 0; k < fig.bits.length; k++) fig.bits[k] = 1 - bg.bits[k];
    // Keep blobs that overlap where the guide figure is (a stray speck or a neighbour's boot does not).
    const near = dilate(want, 14);
    const kept = emptyMask(cw, ch);
    for (const blob of components(fig)) {
      if (maskArea(blob) < 30 || !blob.bits.some((b, k) => b && near.bits[k])) continue;
      blob.bits.forEach((b, k) => { if (b) kept.bits[k] = 1; });
    }
    const gb = maskBox(want);
    const pb = maskBox(kept);
    if (!gb || !pb) { iou.push(0); legs.push(0); same.push(0); spread.push(Infinity); tall.push(0); continue; }
    tall.push(pb[3] - pb[1]);
    // Same height, same feet line, same centre across.
    const s = Math.min(1.2, Math.max(0.8, (gb[3] - gb[1]) / (pb[3] - pb[1])));
    const [gcx, pcx] = [(gb[0] + gb[2]) / 2, (pb[0] + pb[2]) / 2];
    const moved = emptyMask(cw, ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = Math.round((x - gcx) / s + pcx);
      const sy = Math.round((y - gb[3]) / s + pb[3]);
      if (sx < 0 || sy < 0 || sx >= cw || sy >= ch || !kept.bits[sy * cw + sx]) continue;
      moved.bits[y * cw + x] = 1;
      const from = ((y0 + sy) * W + x0 + sx) * 4;
      const to = ((y0 + y) * W + x0 + x) * 4;
      painted.data.copy(out, to, from, from + 3);
      out[to + 3] = 255;
    }
    same.push(Number(sameEdges(guide.data, out, W, cell).toFixed(3)));
    iou.push(Number(maskIou(want, moved).toFixed(3)));
    // Muse sometimes draws the other leg forward: the legs alone (lowest third) catch that.
    const below = Math.round(gb[3] - (gb[3] - gb[1]) / 3);
    const low = (m: Mask) => ({ ...m, bits: m.bits.map((b, k) => (k >= below * cw ? b : 0)) });
    legs.push(Number(maskIou(low(want), low(moved)).toFixed(3)));
    const feet = maskBox(low(want));
    spread.push(feet ? feet[2] - feet[0] : Infinity);
  }
  // Muse now and then paints one frame of a walk as a crouch (lamp-quarter: the courier set down his lantern
  // in the last cell of 3 of 4 sheets). Each cell is scaled to the guide's height above, so the cut sheet
  // hides it; the painted figure, a fifth shorter than the rest, does not. A walk steps over such a cell.
  const usual = [...tall].sort((a, b) => a - b)[Math.floor(tall.length / 2)];
  const off = tall.flatMap((t, i) => (t < OFF_GAIT * usual ? [i] : []));
  // Standing still shows the frame whose feet are closest together (the legs passing each other).
  const stand = spread.reduce((best, s, i) => (!off.includes(i) && (best < 0 || s < spread[best]) ? i : best), -1);
  return { sheet: await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), iou, legs, same, stand: Math.max(0, stand), off };
}


/**
 * Whether the model wears the front painting on its face (web/hero3d.ts `face: 'views'`) instead of its own
 * UV texture. TRELLIS often bakes the face to a blank smudge or a dark band over the eyes; the painting then
 * gives the face Muse drew. But the painting is fitted only by silhouette and can land a second pair of eyes
 * beside the model's, so Spark compares the two heads, as the sprites will show them, and picks.
 */
export async function uvFaceLost(memo: Memo, key: string, modelDir: string, animation: AnimationSettings): Promise<boolean> {
  const head = async (face: 'views' | undefined) => {
    const render = (await renderGuides(modelDir, ['front'], [0], false, animation, { face })).front;
    const trimmed = await sharp(render).trim().png().toBuffer({ resolveWithObject: true });
    return sharp(trimmed.data).extract({ left: 0, top: 0, width: trimmed.info.width, height: Math.max(1, Math.round(trimmed.info.height * 0.2)) })
      .flatten({ background: GREY }).resize({ width: 512 }).png().toBuffer();
  };
  const a = await askSparkJson<{ why?: unknown; better?: unknown }>(memo, {
    label: `uv-face:${key}`, images: [await head(undefined), await head('views'), fs.readFileSync(path.join(modelDir, 'front.png'))],
    prompt: 'Pictures 1 and 2 are the same 3D game character\'s head, rendered two ways; picture 3 is the painting of that character. Which render has the better face: '
      + 'two clear, separate eyes in the right place, one nose, one mouth, closest to the painting? A face with no eyes, a dark band or smudge over the eyes, '
      + 'or eyes doubled, shifted or cut by a seam is worse. Reply with JSON only: {"why": "a few words", "better": 1 or 2}.',
  });
  return Number(a.better) === 2;
}
