// What a world-wide build step works from and what it made so far, card by card, for the Studio's live step view
// (a click on that step's segment of the build bar): item icons (where SAM cuts each one from, the icon), plates
// (what goes, the place without it), weather and reactions (each place, what was read for it). Free, reads files only.
import fs from 'node:fs';
import { z } from 'zod';
import { maskFromPng } from '../image/mask.ts';
import { maskBox } from '../image/raster.ts';
import { Reactions } from '../play/reactions.ts';
import { Weather } from '../play/weather.ts';
import { itemSources, ItemsInfo } from '../scene/icons.ts';
import { removableThings } from '../story/engine.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { defineAction } from './registry.ts';

export type Pic = { file: string; v: number | null };
/** A crop of a place's painting: the box as fractions of the picture, the SAM mask that was cut, and what lies over it. */
export type Shot = { painting: Pic; box?: [number, number, number, number]; mask?: Pic; over?: Pic };
export type WorkCard = {
  key: string; title: string; place?: string;
  /** What the step works from, and what it made (null: not yet). */
  from: Shot | null; made: Shot | Pic | null;
  /** How it is made or what was read, in a few words each. */
  words: string[];
  /** When its result was written (ms), to tell this run's result from the earlier build's. */
  at: number | null;
};

export const WORK_STEPS = ['icons', 'plates', 'weather', 'reactions'] as const;

const stamp = (file: string) => (fs.existsSync(file) ? Math.round(fs.statSync(file).mtimeMs) : null);
const boxes = new Map<string, [number, number, number, number] | undefined>();

/** The thing's box in a mask PNG as fractions, grown so there is some of the place around it; cached by file time. */
async function boxOf(file: string): Promise<[number, number, number, number] | undefined> {
  const at = `${file}@${stamp(file)}`;
  if (boxes.has(at)) return boxes.get(at);
  let out: [number, number, number, number] | undefined;
  if (fs.existsSync(file)) {
    const m = await maskFromPng(fs.readFileSync(file));
    const b = maskBox(m);
    if (b) {
      // A square-ish view at least a fifth of the picture wide, so a small thing is still seen where it stands.
      const side = Math.max(b[2] - b[0], b[3] - b[1], m.width / 5) * 1.5;
      const [cx, cy] = [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
      const w = Math.min(m.width, side), h = Math.min(m.height, side);
      const x0 = Math.max(0, Math.min(m.width - w, cx - w / 2)), y0 = Math.max(0, Math.min(m.height - h, cy - h / 2));
      out = [x0 / m.width, y0 / m.height, (x0 + w) / m.width, (y0 + h) / m.height];
    }
  }
  boxes.set(at, out);
  return out;
}

const pic = (files: WorldFiles, rel: string): Pic | null => (fs.existsSync(files.path(rel)) ? { file: rel, v: stamp(files.path(rel)) } : null);
const readJson = <T,>(files: WorldFiles, rel: string, parse: (x: unknown) => T): T | null => {
  try {
    return fs.existsSync(files.path(rel)) ? parse(files.readJson(files.path(rel))) : null;
  } catch {
    return null;
  }
};

/** The painting where a thing stands, cropped to it, with the SAM mask that cut it out. */
async function thingShot(files: WorldFiles, place: string, thing: string): Promise<Shot | null> {
  const painting = pic(files, `places/${place}/painting.png`);
  if (!painting) return null;
  const mask = pic(files, `places/${place}/masks/${thing}.png`);
  return { painting, ...(mask && { mask, box: await boxOf(files.path(mask.file)) }) };
}

export async function stepWork(files: WorldFiles, step: string): Promise<WorkCard[]> {
  const story = readJson(files, 'story.json', (x) => Story.parse(x));
  if (step === 'icons') {
    if (!story) return [];
    const sources = itemSources(story);
    const info = readJson(files, 'items/items.json', (x) => ItemsInfo.parse(x)) ?? {};
    return Promise.all(story.items.map(async (item) => {
      const from = sources[item.key];
      const icon = pic(files, `items/${item.key}.png`);
      const how = info[item.key]?.how;
      return {
        key: item.key, title: item.name, place: from?.place,
        from: from ? await thingShot(files, from.place, from.thing) : null,
        made: icon,
        words: [from ? `picked up in ${from.place} (${from.thing})` : 'handed over: Muse Image paints it',
          ...(how ? [how === 'cut' ? 'cut from the painting with SAM\'s mask' : how === 'redraw' ? 'too small: Muse Image redrew the cut-out, SAM cut it' : 'painted by Muse Image, cut out by SAM'] : [])],
        at: icon?.v ?? null,
      };
    }));
  }
  if (step === 'plates') {
    if (!story) return [];
    const takes = removableThings(story).map(async ({ place, thing }) => {
      const from = await thingShot(files, place, thing);
      const plate = pic(files, `places/${place}/plates/${thing}.png`);
      return { key: `${place}/${thing}`, title: `${thing} taken`, place, from,
        made: plate && from ? { ...from, mask: undefined, over: plate } : null,
        words: [`${place}: the place once the hero takes the ${thing}`, 'Muse Image paints over where it stood'], at: plate?.v ?? null };
    });
    const changes = story.changes.map(async (c, i) => {
      const from = await thingShot(files, c.place, c.thing);
      const plate = pic(files, `places/${c.place}/changes/${i}.png`);
      return { key: `${c.place}/change-${i}`, title: `${c.thing} changes`, place: c.place, from,
        made: plate && from ? { ...from, mask: undefined, over: plate } : null,
        words: [`${c.place}: ${c.looks}`, `once ${c.when.join(', ')}`], at: plate?.v ?? null };
    });
    return Promise.all([...takes, ...changes]);
  }
  if (step === 'weather' || step === 'reactions') {
    return files.world().places.map((p) => {
      const painting = pic(files, `places/${p.key}/painting.png`);
      const from = painting && { painting };
      if (step === 'weather') {
        const rel = `places/${p.key}/weather.json`;
        const w = readJson(files, rel, (x) => Weather.parse(x));
        const ripples = pic(files, `places/${p.key}/weather/ripples.png`);
        const words = w ? [
          w.fall === 'none' ? 'nothing falls' : `${w.fall}, ${Math.round(w.strength * 100)}%${w.wind ? `, wind ${w.wind > 0 ? 'right' : 'left'}` : ''}`,
          ...(w.fog ? [`fog ${Math.round(w.fog * 100)}%`] : []),
          ...(ripples ? ['rings on water and puddles'] : []),
          ...w.drips.map((d) => `drips from ${d.phrase}`),
        ] : [];
        return { key: p.key, title: p.key, place: p.key, from, made: w && painting ? { painting, ...(ripples && { mask: ripples }) } : null, words, at: stamp(files.path(rel)) };
      }
      const rel = `places/${p.key}/reactions.json`;
      const r = readJson(files, rel, (x) => Reactions.parse(x));
      const words = r ? [
        ...r.areas.map((a) => `${a.key}: ${[a.step && `${a.step.kind} under each step`, a.enter && `${a.enter.kind} on entering`].filter(Boolean).join(', ')}`),
        ...r.interactions.map((i) => `${i.thing} (${i.action}): ${i.burst.kind}`),
      ] : [];
      if (r && !words.length) words.push('nothing reacts here (a clean, still place)');
      return { key: p.key, title: p.key, place: p.key, from, made: r && painting ? { painting } : null, words, at: stamp(files.path(rel)) };
    });
  }
  return [];
}

defineAction({
  name: 'step_work',
  reads: true,
  description: 'What a world-wide build step (icons, plates, weather, reactions) works from and what it made so far, card by card: '
    + 'for icons each item with the painting crop and SAM mask it is cut from and its icon; for plates each taken or changed thing and its plate; '
    + 'for weather and reactions each place and what was read for it. Free.',
  input: z.object({ slug: Slug, step: z.enum(WORK_STEPS) }),
  async run({ slug, step }, ctx) {
    return stepWork(new WorldFiles(slug, ctx.root), step);
  },
});
