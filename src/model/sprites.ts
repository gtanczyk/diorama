// Walk-cycle sprites of a figure: the rigged model (cast/<key>/model/) walks in a grid of frames for one
// facing, Muse draws that sheet again by hand in the world's painted style, keeping every pose and
// position, and each painted frame is cut out and lined up with the frame it was drawn over. The
// model gives the poses; everything seen in the game is Muse's.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import sharp from 'sharp';
import { chromium } from '../commands/explore.ts';
import { museEdit } from '../meta/muse.ts';
import type { Memo } from '../meta/memo.ts';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { components, dilate, maskBox, maskIou } from '../image/raster.ts';

const WEB = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../web');

/** The five facings drawn; the three facing left are these mirrored. yaw 0 faces the viewer, PI/2 screen right. */
export const FACINGS = { front: 0, 'front-right': Math.PI / 4, right: Math.PI / 2, 'back-right': (3 * Math.PI) / 4, back: Math.PI } as const;
export type Facing = keyof typeof FACINGS;

/** One sheet: 8 frames of a full walk cycle in 4 columns and 2 rows, Muse's own size. */
export const SHEET = { cols: 4, rows: 2, width: 1200, height: 896, feetAt: 0.95, px: 385, elevation: 0.18 } as const;
const GREY = { r: 217, g: 217, b: 217 };

type RoutePage = {
  route(url: string, fn: (route: { request(): { url(): string }; fulfill(o: { status?: number; contentType?: string; body: string | Buffer }): Promise<void> }) => unknown): Promise<void>;
  goto(url: string): Promise<unknown>;
  evaluate<T>(js: string): Promise<T>;
  on(event: 'pageerror', fn: (e: { message: string }) => void): void;
};

/** The model walking, one transparent sheet per facing (rendered in headless Chromium with WebGL). */
export async function renderGuides(modelDir: string, facings: Facing[]): Promise<Record<string, Buffer>> {
  const info = JSON.parse(fs.readFileSync(path.join(modelDir, 'model.json'), 'utf8'));
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
    for (const facing of facings) {
      const ask = { info, base: 'http://sprites.local', yaw: FACINGS[facing], ...SHEET };
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

const SEEN: Record<Facing, string> = {
  front: 'walking towards the viewer, face to the viewer',
  'front-right': 'walking diagonally towards the viewer and to the right of the picture (three-quarter view), face visible',
  right: 'walking to the right of the picture, seen exactly from the side in profile',
  'back-right': 'walking diagonally away from the viewer and to the right of the picture, seen three-quarters from behind: back of the head, hardly any face',
  back: 'walking straight away from the viewer, seen from behind: back of the head and back of the clothes, no face',
};

/**
 * Muse draws the sheet again from scratch over the guide. `refs`: the character (Muse's painted view for
 * that side) and, for consistency across facings, a sheet already painted.
 */
export function paintSheet(memo: Memo, key: string, facing: Facing, looks: string, guide: Buffer, refs: Buffer[], take = 0): Promise<Buffer> {
  return museEdit(memo, {
    label: `${key}-sprites-${facing}`, take, size: `${SHEET.width}x${SHEET.height}`, images: [guide, ...refs],
    prompt: `The first image is only a rough 3D pose guide for a walk-cycle sprite sheet: eight frames of one character ${SEEN[facing]}. ` +
      `Draw this sheet again from scratch as a hand-painted 2D game sprite sheet of the character in the other pictures (${looks}): same face, hair, headwear, clothes, patches, boots and colours, in their painterly gouache style. ` +
      `Each frame: exactly the same position, size, facing and body pose as the guide (same leg and arm positions), but clean anatomy: one face, natural boots that keep their shape, smooth readable clothing folds, no patchy textures, no 3D or CG look. ` +
      'Plain flat light grey background, no ground shadows, nothing else.',
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
 * Cuts each painted frame out of its grey and lines it up with its guide frame: same feet line, same
 * centre, same height. Returns the transparent sheet and how well each frame kept the guide's pose (IoU).
 */
export async function cutSheet(guidePng: Buffer, paintedPng: Buffer): Promise<{ sheet: Buffer; iou: number[]; legs: number[]; stand: number }> {
  const { cols, rows, width: W, height: H } = SHEET;
  const guide = await rgba(guidePng, [W, H]);
  const painted = await rgba(paintedPng, [W, H]);
  const out = Buffer.alloc(W * H * 4);
  const [cw, ch] = [W / cols, H / rows];
  const iou: number[] = [];
  const legs: number[] = [];
  const spread: number[] = [];
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
    if (!gb || !pb) { iou.push(0); legs.push(0); spread.push(Infinity); continue; }
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
    iou.push(Number(maskIou(want, moved).toFixed(3)));
    // Muse sometimes draws the other leg forward: the legs alone (lowest third) catch that.
    const below = Math.round(gb[3] - (gb[3] - gb[1]) / 3);
    const low = (m: Mask) => ({ ...m, bits: m.bits.map((b, k) => (k >= below * cw ? b : 0)) });
    legs.push(Number(maskIou(low(want), low(moved)).toFixed(3)));
    const feet = maskBox(low(want));
    spread.push(feet ? feet[2] - feet[0] : Infinity);
  }
  // Standing still shows the frame whose feet are closest together (the legs passing each other).
  const stand = spread.indexOf(Math.min(...spread));
  return { sheet: await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer(), iou, legs, stand };
}

