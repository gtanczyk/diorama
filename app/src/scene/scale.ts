// How tall the hero is at each spot: a 1.62 m person is pxPerY * (feetY - horizonY) px tall.
// Spark judges a person's height at eight floor points, asked three ways (median per point), from the painting's perspective; that has
// been the steadiest source. Object heights are a fallback: Spark's guesses at metres are worse.
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { FRAME } from './layout.ts';

export const PERSON_M = 1.62;

export type Scale = { horizonY: number; pxPerY: number; source: 'spark' | 'anchors' | 'layout' };
/** A person `px` tall with feet at `y`. */
export type Sample = { x?: number; y: number; px: number };

/** Least squares px = c * (y - h). Undefined when the points can't give a line. */
export function fitLine(samples: Sample[]): { c: number; h: number } | undefined {
  if (samples.length < 2) return undefined;
  const n = samples.length;
  const my = samples.reduce((s, p) => s + p.y, 0) / n;
  const mp = samples.reduce((s, p) => s + p.px, 0) / n;
  const syy = samples.reduce((s, p) => s + (p.y - my) ** 2, 0);
  if (syy < 1) return undefined;
  const c = samples.reduce((s, p) => s + (p.y - my) * (p.px - mp), 0) / syy;
  if (c <= 0) return undefined;
  return { c, h: my - mp / c };
}

/** Least squares c with the horizon fixed. */
export function fitSlope(samples: Sample[], horizonY: number): number | undefined {
  const usable = samples.filter((s) => s.y - horizonY > 20);
  const den = usable.reduce((s, p) => s + (p.y - horizonY) ** 2, 0);
  return den > 0 ? usable.reduce((s, p) => s + p.px * (p.y - horizonY), 0) / den : undefined;
}

const SLOPE = { min: 0.2, max: 4 };

/**
 * A scale from samples, or a reason it can't be trusted. The horizon has to sit above the highest
 * floor (`topY`) with a margin, or the hero would shrink to nothing or flip at the back.
 */
export function scaleFrom(samples: Sample[], topY: number, layoutHorizon: number, source: Scale['source']): { scale?: Scale; why?: string } {
  const line = fitLine(samples);
  if (line && line.c > SLOPE.min && line.c < SLOPE.max && line.h <= topY - 20) {
    return { scale: { horizonY: Math.round(line.h), pxPerY: round3(line.c), source } };
  }
  // Points that disagree on the horizon: keep the layout's horizon (if it is high enough) and fit the slope.
  const horizonY = Math.min(layoutHorizon, topY - 40);
  const c = fitSlope(samples, horizonY);
  if (c && c > SLOPE.min && c < SLOPE.max) return { scale: { horizonY, pxPerY: round3(c), source } };
  return { why: line ? `line px = ${line.c.toFixed(2)} * (y - ${Math.round(line.h)}) is implausible` : `${samples.length} usable point(s)` };
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Eight probe points on the floor: two per depth, from the far rows to the near ones. Spark's
 * guesses scatter by tens of percent; more points give the line fit something to average.
 */
export function probePoints(floorRows: { y: number; xs: number[] }[]): { x: number; y: number }[] {
  if (floorRows.length === 0) return [];
  const sorted = [...floorRows].sort((a, b) => a.y - b.y);
  return [0.08, 0.38, 0.68, 0.95].flatMap((q) => {
    const row = sorted[Math.min(sorted.length - 1, Math.round(q * (sorted.length - 1)))];
    const xs = [...row.xs].sort((a, b) => a - b);
    return [0.3, 0.7].map((f) => ({ x: Math.round(xs[Math.floor(f * (xs.length - 1))]), y: Math.round(row.y) }));
  }).filter((p, i, all) => all.findIndex((o) => o.y === p.y && o.x === p.x) === i);
}

const People = z.object({ people: z.array(z.object({ x: z.number(), y: z.number(), px: z.number() })) });

/** A thing measured on its mask, to give Spark something to compare a person with. */
export type Reference = { key: string; x: number; footY: number; px: number; metres: number };

/** Spark's answers to one question drift by ±15% from run to run of the pipeline (a moved point is a new
 * question). Asking the same points in a few orders and taking each point's median holds the scale still. */
export const SCALE_ASKS = 3;

export async function sparkPeople(memo: Memo, label: string, painting: Buffer, points: { x: number; y: number }[], refs: Reference[] = []): Promise<Sample[]> {
  const orders = [points, [...points].reverse(), [...points.filter((_, i) => i % 2), ...points.filter((_, i) => i % 2 === 0)]].slice(0, SCALE_ASKS);
  const takes = await Promise.all(orders.map((order, k) => askPeople(memo, k ? `${label}#${k}` : label, painting, order, refs).catch(() => [] as Sample[])));
  return medianPeople(points, takes);
}

/** Each point's median answer over the takes; a take that skipped a point just has no say on it. */
export function medianPeople(points: { x: number; y: number }[], takes: Sample[][]): Sample[] {
  return points.flatMap((p) => {
    const px = takes.flatMap((take) => take.filter((s) => Math.abs((s.x ?? p.x) - p.x) <= 4 && Math.abs(s.y - p.y) <= 4).slice(0, 1).map((s) => s.px)).sort((a, b) => a - b);
    if (!px.length) return [];
    const mid = px.length >> 1;
    return [{ x: p.x, y: p.y, px: px.length % 2 ? px[mid] : (px[mid - 1] + px[mid]) / 2 }];
  });
}

async function askPeople(memo: Memo, label: string, painting: Buffer, points: { x: number; y: number }[], refs: Reference[]): Promise<Sample[]> {
  const known = refs.length
    ? `\nFor reference, measured in this painting (the real heights are rough guesses):\n${refs.map((r) => `- ${r.key}: stands at (${Math.round(r.x)}, ${Math.round(r.footY)}), ${Math.round(r.px)} px tall, roughly ${r.metres} m`).join('\n')}\n`
    : '';
  const prompt = `This is a painted background for a 2D adventure game (${FRAME.width}x${FRAME.height} px, x right, y down). Judge its perspective from the things in it (doors, boats, steps, furniture, trees, planks): things farther away are smaller, and a person is drawn smaller the higher their feet are in the picture.${known}
For each point on the ground below, how tall in pixels would an adult ${PERSON_M} m tall be, standing with their feet there?
Points: ${points.map((p) => `(${p.x}, ${p.y})`).join(', ')}

Reply with JSON only: {"people": [{"x": 0, "y": 0, "px": 0}]}`;
  const { people } = People.parse(await askSparkJson(memo, { label, prompt, images: [painting] }));
  return people.filter((p) => p.px > 10 && p.px < 900);
}
