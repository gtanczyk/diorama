// weather.json: what falls on a place and where water drips, written by the weather step, read by the page.
// Rain and snow fall over the whole frame (the "all" pseudo-mask); drops ring on water and puddles, splash on
// the floors, and drip from the edges Spark names (eaves, a gutter, a cave ceiling).
// No Node imports: the browser bundles this file.
import { z } from 'zod';

const XY = z.tuple([z.number(), z.number()]);

export const Weather = z.object({
  /** What falls from the sky now; none for a dry place (drips may still run, a leaking pipe in a cave). */
  fall: z.enum(['none', 'rain', 'snow']),
  /** 0.3 drizzle, 0.6 rain, 1 a downpour (or a blizzard). */
  strength: z.number().min(0).max(1),
  /** How far the fall slants: px across per px down, + to the right. */
  wind: z.number().min(-1).max(1),
  /** How much mist drifts over the place, 0 clear .. 1 thick fog. */
  fog: z.number().min(0).max(1).default(0),
  /** Edges water drips from: points along the edge, and where each drop lands (the floor row under it). */
  drips: z.array(z.object({ phrase: z.string(), from: z.array(XY), to: z.array(z.number()) })).default([]),
  /** Mask (relative to the place folder) of water and puddles, where drops ring. */
  ripples: z.string().optional(),
});
export type Weather = z.infer<typeof Weather>;

/** How the author wants a place's weather: places/<key>/weather-wish.json, set by the weather_set action, kept across rebuilds. */
export const WeatherWish = z.object({
  /** auto: as Spark reads the picture and the mood; otherwise this, whatever the picture says. */
  fall: z.enum(['auto', 'none', 'rain', 'snow']).default('auto'),
  strength: z.number().min(0).max(1).optional(),
  /** Mist the author wants, 0..1; unset: as Spark reads it. */
  fog: z.number().min(0).max(1).optional(),
  /** What the author said ("water drips from the tavern sign"), handed to Spark. */
  hint: z.string().optional(),
});
export type WeatherWish = z.infer<typeof WeatherWish>;

/** Whether a place's words say something falls (rain, snow, a storm), so its painting leaves the fall to the page. */
export function fallsIn(text: string): boolean {
  return /\b(rain\w*|drizzl\w*|downpour|storm\w*|snow\w*|sleet|blizzard|shower\w*|deszcz\w*|ulew\w*|śnieg\w*|mżawk\w*)/i.test(text);
}

/** A small seeded random source (mulberry32), so a recorded run rains the same every time. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
