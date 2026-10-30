// The painted lights of a place (layout.lights) come alive: a window's glow breathes, a lantern or a fire
// flickers, a town's far lights twinkle, a lighthouse lamp turns its beam round. Read by the light's name, so
// any new world gets it with no extra step and no model call.
import { z } from 'zod';
import { hashSeed } from './weather.ts';

export type GlowKind = 'beam' | 'flame' | 'window' | 'twinkle' | 'lamp';

export const Glow = z.object({ key: z.string(), x: z.number(), y: z.number(), colour: z.string(), kind: z.enum(['beam', 'flame', 'window', 'twinkle', 'lamp']) });
export type Glow = z.infer<typeof Glow>;

const KINDS: Array<[GlowKind, RegExp]> = [
  ['beam', /\b(beam|beacon|lighthouse|searchlight)\b/],
  ['twinkle', /\b(town|city|village|distant|far|stars?|lights)\b/],
  ['flame', /\b(fire|flame|candles?|torch|campfire|hearth|oven|brazier|lantern|embers?)\b/],
  ['window', /\b(windows?|porthole|shopfront|doorway|glass)\b/],
];

/** What kind of light a layout light is, by the words of its key ("hut-window", "lighthouse-lamp"). */
export function glowKind(key: string): GlowKind {
  const words = key.toLowerCase().replace(/[-_]+/g, ' ');
  return KINDS.find(([, re]) => re.test(words))?.[0] ?? 'lamp';
}

export function glowsOf(lights: Array<{ key: string; x: number; y: number; colour: string }>): Glow[] {
  return lights.map((l) => ({ ...l, kind: glowKind(l.key) }));
}

/**
 * How bright a glow is at time t, 0..1 around its rest of ~0.5: slow breathing for a window, a quick restless
 * flicker for a flame, short sparkles for far lights. Each light has its own phase, so a row of windows never
 * pulses together.
 */
export function glowLevel(g: Glow, t: number): number {
  const s = (hashSeed(g.key) % 1000) / 1000 * Math.PI * 2;
  switch (g.kind) {
    case 'flame': return 0.5 + 0.22 * Math.sin(t * 7.3 + s) + 0.14 * Math.sin(t * 12.9 + 2 * s) + 0.1 * Math.sin(t * 2.3 + s);
    case 'window': return 0.5 + 0.18 * Math.sin(t * 0.7 + s) + 0.08 * Math.sin(t * 2.9 + 3 * s) + (Math.sin(t * 0.21 + s) > 0.97 ? -0.25 : 0);
    case 'twinkle': return 0.5 + 0.3 * Math.sin(t * 3.7 + s) * Math.sin(t * 1.3 + 2 * s);
    case 'beam': return 0.5 + 0.15 * Math.sin(t * 1.1 + s);
    default: return 0.5 + 0.12 * Math.sin(t * 1.4 + s) + 0.05 * Math.sin(t * 5.1 + s);
  }
}

/** A turning beam: its angle at time t (one turn per BEAM_TURN s, from the light's own phase). */
export const BEAM_TURN = 9;
export function beamAngle(g: Glow, t: number): number {
  return ((hashSeed(g.key) % 360) * Math.PI) / 180 + (t / BEAM_TURN) * Math.PI * 2;
}
