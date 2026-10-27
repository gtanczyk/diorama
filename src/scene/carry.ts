// carry: after a small repaint, what the repaint did not reach keeps what was measured on it.
// Each place step keeps the painting it last ran on (places/<p>/.ran/<step>.png). On the next run the painting
// is compared with it, tile by tile. A question whose region no changed tile reaches is asked about the old
// painting again, which the memo answers with the old answer for nothing; only what the change reaches goes
// to the models. A big change (a new painting) carries nothing, and the step runs as before.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { Mask } from '../image/mask.ts';
import type { Rect } from '../image/raster.ts';
import { FRAME } from './layout.ts';

const { width: W, height: H } = FRAME;
/** Tiles of the comparison: a changed pixel marks its whole tile. */
const TILE = 24;
/** A pixel changed when a channel moved more than this: a repaint pastes exactly, untouched pixels match, and a feathered edge is part of the change. */
const NOISE = 0;
/** Past this share of the frame the painting is taken as new: nothing is carried. */
export const MOST = 0.35;

export type Carry = {
  /** The painting the step last ran on. */
  old: Buffer;
  /** The changed tiles, as rects. */
  tiles: Rect[];
  /** The share of the frame they cover. */
  share: number;
};

const rgb = (png: Buffer) => sharp(png).resize(W, H, { fit: 'fill' }).removeAlpha().raw().toBuffer();

/** The tiles where `b` differs from `a`. */
export async function changedTiles(a: Buffer, b: Buffer): Promise<Rect[]> {
  const [pa, pb] = await Promise.all([rgb(a), rgb(b)]);
  const tiles: Rect[] = [];
  for (let ty = 0; ty < H; ty += TILE) {
    for (let tx = 0; tx < W; tx += TILE) {
      let hit = false;
      for (let y = ty; y < Math.min(H, ty + TILE) && !hit; y++) {
        for (let x = tx, i = (y * W + tx) * 3; x < Math.min(W, tx + TILE); x++, i += 3) {
          if (Math.abs(pa[i] - pb[i]) > NOISE || Math.abs(pa[i + 1] - pb[i + 1]) > NOISE || Math.abs(pa[i + 2] - pb[i + 2]) > NOISE) {
            hit = true;
            break;
          }
        }
      }
      if (hit) tiles.push([tx, ty, Math.min(W, tx + TILE), Math.min(H, ty + TILE)]);
    }
  }
  return tiles;
}

const ranFile = (dir: string, step: string) => path.join(dir, '.ran', `${step}.png`);

/** What `step` can carry over from its last run in this place, or nothing (first run, same painting, a new painting). */
export async function carryFrom(dir: string, step: string, painting: Buffer): Promise<Carry | undefined> {
  const file = ranFile(dir, step);
  if (!fs.existsSync(file)) return undefined;
  return carryBetween(fs.readFileSync(file), painting);
}

/** What can be carried from `old` to `now`, any two pictures of the place (two backdrops), or nothing. */
export async function carryBetween(old: Buffer, now: Buffer): Promise<Carry | undefined> {
  // The same picture: the memo answers every question as it is.
  if (old.equals(now)) return undefined;
  const tiles = await changedTiles(old, now);
  const share = tiles.reduce((s, [x0, y0, x1, y1]) => s + (x1 - x0) * (y1 - y0), 0) / (W * H);
  return share > MOST ? undefined : { old, tiles, share };
}

/** Keeps the painting `step` ran on in this place. Steps that ran on the same painting share one file. */
export function ran(dir: string, step: string, painting: Buffer) {
  const file = ranFile(dir, step);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const twin = fs.readdirSync(path.dirname(file)).map((f) => path.join(path.dirname(file), f))
    .find((f) => f !== file && f.endsWith('.png') && fs.statSync(f).size === painting.length && fs.readFileSync(f).equals(painting));
  fs.rmSync(file, { force: true });
  if (twin) {
    try {
      fs.linkSync(twin, file);
      return;
    } catch {
      // No hard links here: a copy will do.
    }
  }
  fs.writeFileSync(file, painting);
}

/** What each place step leaves. */
const MADE: Record<string, string> = { masks: 'masks.json', plates: 'plates.json', derive: 'geometry.json', backdrop: 'backdrop.png' };

/**
 * For a place whose steps have not kept their painting (built before .ran/, or put back by an Undo that predates it):
 * each step that left its output takes the painting on disk as the one it ran on. File times say nothing here (an
 * Undo writes every file anew), and they need not: the carried questions are asked about this painting, a real one,
 * so the worst a wrong guess costs is the model calls it would have cost anyway. Called before a repaint replaces it.
 */
export function seedRan(dir: string): string[] {
  const file = path.join(dir, 'painting.png');
  if (!fs.existsSync(file)) return [];
  let painting: Buffer | undefined;
  const seeded: string[] = [];
  for (const [step, made] of Object.entries(MADE)) {
    if (fs.existsSync(ranFile(dir, step)) || !fs.existsSync(path.join(dir, made))) continue;
    ran(dir, step, (painting ??= fs.readFileSync(file)));
    seeded.push(step);
  }
  // The far flats and the water were cut from the backdrop on disk.
  if (fs.existsSync(ranFile(dir, 'backdrop')) && !fs.existsSync(ranFile(dir, 'backdrop-made')) && fs.existsSync(path.join(dir, 'backdrop.png'))) {
    ran(dir, 'backdrop-made', fs.readFileSync(path.join(dir, 'backdrop.png')));
  }
  return seeded;
}

/** Whether the change reaches a region (a mask, a box, or several), grown by `margin` px. No region is never reached. */
export function reaches(carry: Carry, region: Mask | Rect | Array<Mask | Rect | undefined> | undefined, margin = 16): boolean {
  if (!region) return false;
  if (Array.isArray(region) && (region.length === 0 || typeof region[0] !== 'number')) return (region as Array<Mask | Rect | undefined>).some((r) => reaches(carry, r, margin));
  for (const [tx0, ty0, tx1, ty1] of carry.tiles) {
    const [x0, y0, x1, y1] = [Math.max(0, tx0 - margin), Math.max(0, ty0 - margin), Math.min(W, tx1 + margin), Math.min(H, ty1 + margin)];
    if (Array.isArray(region)) {
      const [rx0, ry0, rx1, ry1] = region as Rect;
      if (rx0 < x1 && rx1 > x0 && ry0 < y1 && ry1 > y0) return true;
      continue;
    }
    const m = region as Mask;
    for (let y = y0; y < y1; y++) {
      for (let x = x0, i = y * m.width + x0; x < x1; x++, i++) if (m.bits[i]) return true;
    }
  }
  return false;
}

/** A thing or floor this big (px) is masked again only when the change covers a good part of it. */
const BIG = 20_000;
const GRAZE = 0.3;

/**
 * Whether a repaint changes a mask's outline: it lies on the changed tiles (grown by 8 px), and it is small or a good
 * part of it changed. A thermos repainted on a jetty changes the thermos, not where the jetty is.
 */
export function remakes(carry: Carry, mask: Mask): boolean {
  let total = 0;
  for (let i = 0; i < mask.bits.length; i++) total += mask.bits[i];
  let on = 0;
  const seen = new Uint8Array(mask.bits.length);
  for (const [tx0, ty0, tx1, ty1] of carry.tiles) {
    for (let y = Math.max(0, ty0 - 8); y < Math.min(mask.height, ty1 + 8); y++) {
      for (let x = Math.max(0, tx0 - 8), i = y * mask.width + x; x < Math.min(mask.width, tx1 + 8); x++, i++) {
        if (mask.bits[i] && !seen[i]) (seen[i] = 1, on++);
      }
    }
  }
  return on > 0 && (total < BIG || on / total > GRAZE);
}

/** The painting to ask a question about a region with: the old one when the change does not reach the region. */
export function paintingFor(carry: Carry | undefined, painting: Buffer, region: Parameters<typeof reaches>[1], margin?: number): Buffer {
  return carry && !reaches(carry, region, margin) ? carry.old : painting;
}

/** `made` (built from the old painting) with the changed tiles taken from the new painting, except inside `keep`. */
export async function withChange(made: Buffer, painting: Buffer, carry: Carry, keep?: Mask): Promise<Buffer> {
  const [out, now] = await Promise.all([rgb(made), rgb(painting)]);
  for (const [x0, y0, x1, y1] of carry.tiles) {
    for (let y = y0; y < y1; y++) {
      if (!keep) {
        now.copy(out, (y * W + x0) * 3, (y * W + x0) * 3, (y * W + x1) * 3);
        continue;
      }
      for (let x = x0, i = y * W + x0; x < x1; x++, i++) if (!keep.bits[i]) now.copy(out, i * 3, i * 3, i * 3 + 3);
    }
  }
  return sharp(out, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer();
}

export const tilesLine = (carry: Carry) => `${Math.round(carry.share * 100)}% of the painting changed (${carry.tiles.length} tiles)`;
