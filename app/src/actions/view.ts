// Looking at a place the way the fix tools see it: what the hero can and cannot reach and why, or what
// SAM cut out for each thing. The agent gets the picture as an image, so it never has to dig in files.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { maskFromPng } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import { maskBox } from '../image/raster.ts';
import { Geometry } from '../play/geometry.ts';
import { diagnose, diagnosisPicture } from '../scene/diagnose.ts';
import { readCorrections } from '../scene/corrections.ts';
import { Depth } from '../scene/layers.ts';
import { gridImage } from '../scene/locate.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

type Box = [number, number, number, number];

const iou = (a: Box, b: Box) => {
  const w = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
  const area = (r: Box) => (r[2] - r[0]) * (r[3] - r[1]);
  return (w * h) / (area(a) + area(b) - w * h || 1);
};

/** Each thing's mask against the box Spark saw it in: a mask far from its box has cut out the wrong thing. */
async function thingMasks(dir: string) {
  const read = <T>(f: string): T | null => (fs.existsSync(path.join(dir, f)) ? (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as T) : null);
  const made = read<{ things: Record<string, { kind?: string; phrase?: string; source?: string; coarse?: boolean }> }>('masks.json')?.things ?? {};
  const seen = read<{ things: Record<string, { box: Box | null }> }>('locate.json')?.things ?? {};
  // A box someone already fixed stands for where the thing is, not Spark's first guess.
  const fixed = readCorrections(dir).things;
  return Promise.all(Object.entries(made).map(async ([key, t]) => {
    const file = path.join(dir, 'masks', `${key}.png`);
    const mask = fs.existsSync(file) ? await maskFromPng(fs.readFileSync(file)) : null;
    const box = (mask && maskBox(mask)) as Box | undefined;
    const spark = (fixed[key]?.box as Box | undefined) ?? seen[key]?.box ?? null;
    const overlap = box && spark ? Math.round(iou(box, spark) * 100) / 100 : null;
    return { key, ...t, maskBox: box ?? null, expectedBox: spark, overlap, ...(overlap !== null && overlap < 0.3 && { suspect: 'the mask is not where the thing is: SAM may have cut out its neighbour; mask_fix box (the real box) or phrase' }), mask };
  }));
}

defineAction({
  name: 'place_view',
  reads: true,
  description: 'Look at a place, as a picture you see plus the same in words; use it instead of reading files. '
    + 'layer "walk" (default): the painting with the 60 px cell grid floor_cells takes, reached floor green, unreached red, each gap to bridge '
    + 'as a yellow dashed line, unreachable stand spots red, the start green; in words per floor how much is reached, each unreached patch with '
    + 'the cells of its gap and the things in it, spots off the floor with the nearest reachable point. '
    + 'layer "masks": each thing\'s mask tinted and labelled, its mask box solid and the box it should be in dashed (the fixed box, else the one Spark saw); in words per thing its kind, '
    + 'SAM phrase, how the mask was found and how well it overlaps that box (low overlap: SAM cut out the wrong thing, fix with mask_fix box or phrase). '
    + 'layer "water": where the water moves (tinted magenta), with the grid water_area takes; in words which way it flows and the cells the author added or removed. '
    + 'layer "painting": the painting alone with the grid.',
  input: z.object({ slug: Slug, place: z.string().min(1), layer: z.enum(['walk', 'masks', 'water', 'painting']).optional() }),
  async run({ slug, place, layer = 'walk' }, ctx) {
    const dir = path.join(ctx.root, slug, 'places', place);
    const at = (f: string) => path.join(dir, f);
    const painting = ['painting.png', 'blockin.png'].map(at).find((f) => fs.existsSync(f));
    if (!painting) throw new ActionError(404, `${slug}/${place} has no painting yet: build it first`);
    const shown = async (picture: Buffer, file: string, words: Record<string, unknown>) => {
      // Kept beside the other review pictures, so the page can show what the agent looked at.
      fs.writeFileSync(at(file), picture);
      const jpeg = await sharp(picture).jpeg({ quality: 78 }).toBuffer();
      return { ...words, picture: `places/${place}/${file}`, images: [{ mimeType: 'image/jpeg', data: jpeg.toString('base64') }] };
    };
    if (layer === 'painting') return shown(await gridImage(fs.readFileSync(painting)), 'view-painting.png', { layer });
    if (layer === 'water') {
      const depth = Depth.parse(fs.existsSync(at('depth.json')) ? JSON.parse(fs.readFileSync(at('depth.json'), 'utf8')) : {});
      const water = fs.existsSync(at('layers.json')) ? (JSON.parse(fs.readFileSync(at('layers.json'), 'utf8')) as { water?: { mask: string; box: Box; flow?: [number, number] } }).water : undefined;
      const words = { layer, flow: depth.flow, flowHint: depth.flowHint, added: depth.waterAdd, removed: depth.waterRemove };
      const grid = await gridImage(fs.readFileSync(painting));
      if (!water || !fs.existsSync(at(water.mask))) return shown(grid, 'view-water.png', { ...words, moving: 'none: no water moves here (SAM found none, or the backdrop step has not run); water_area add marks it' });
      // The mask is white with the water as alpha, over the water's box.
      const alpha = await sharp(fs.readFileSync(at(water.mask))).ensureAlpha().extractChannel(3).toBuffer();
      const [x0, y0, x1, y1] = water.box;
      const tint = await sharp({ create: { width: x1 - x0, height: y1 - y0, channels: 3, background: { r: 255, g: 0, b: 200 } } }).joinChannel(await sharp(alpha).linear(0.55, 0).toBuffer()).png().toBuffer();
      const picture = await sharp(grid).composite([{ input: tint, left: x0, top: y0 }]).png().toBuffer();
      const [ux, uy] = water.flow ?? [1, 0];
      const way = !ux && !uy ? 'still (sways in place)' : `flowing ${Math.abs(ux) >= Math.abs(uy) ? (ux > 0 ? 'left to right' : 'right to left') : uy > 0 ? 'toward the viewer' : 'away into the picture'}`;
      return shown(picture, 'view-water.png', { ...words, moving: `${way}, in the box ${water.box.join(',')}` });
    }
    if (layer === 'masks') {
      if (!fs.existsSync(at('masks.json'))) throw new ActionError(404, `${slug}/${place} has no masks yet: build it up to masks first`);
      const things = await thingMasks(dir);
      const tints = things.filter((t) => t.mask).map((t, i) => ({ mask: t.mask!, rgb: PALETTE[i % PALETTE.length], alpha: 0.45 }));
      const svg = things.flatMap((t, i) => {
        const rgb = PALETTE[i % PALETTE.length];
        const out: string[] = [];
        if (t.maskBox) out.push(`<rect x="${t.maskBox[0]}" y="${t.maskBox[1]}" width="${t.maskBox[2] - t.maskBox[0]}" height="${t.maskBox[3] - t.maskBox[1]}" fill="none" stroke="rgb(${rgb.join(',')})" stroke-width="3"/>`);
        if (t.expectedBox) out.push(`<rect x="${t.expectedBox[0]}" y="${t.expectedBox[1]}" width="${t.expectedBox[2] - t.expectedBox[0]}" height="${t.expectedBox[3] - t.expectedBox[1]}" fill="none" stroke="rgb(${rgb.join(',')})" stroke-width="2" stroke-dasharray="8 6"/>`);
        const anchor = t.maskBox ?? t.expectedBox;
        if (anchor) out.push(svgLabel(anchor[0] + 4, anchor[1] + 18, `${t.key}${t.suspect ? ' ?' : ''}`, rgb));
        return out;
      }).join('');
      const picture = await tintOver(await gridImage(fs.readFileSync(painting)), tints, svg);
      return shown(picture, 'view-masks.png', { layer, things: things.map(({ mask: _, ...t }) => t) });
    }
    if (!fs.existsSync(at('geometry.json'))) throw new ActionError(404, `${slug}/${place} has no geometry.json yet: build it up to derive first`);
    const g = Geometry.parse(JSON.parse(fs.readFileSync(at('geometry.json'), 'utf8')));
    const diagnosis = diagnose(g);
    return shown(await diagnosisPicture(fs.readFileSync(painting), g, diagnosis), 'diagnose.png', { layer, diagnosis });
  },
});
