// What the play page gets to mix a world's sound, and the mixing rules as pure functions.
// No Node imports: the browser bundles this file.

export type SoundKind = 'music' | 'bed' | 'loop' | 'step' | 'shot';

export type SoundData = {
  /** Sound id → file (relative to the world) and how loud it sits. */
  files: Record<string, { file: string; kind: SoundKind; level: number; slices?: Array<[number, number]> }>;
  music?: string;
  places: Record<string, {
    bed?: string;
    loops: Array<{ id: string; thing: string; level: number; when: string[] }>;
    /** Footstep sound id per floor index (the digit in geometry.zone). */
    zones: Array<string | null>;
  }>;
  /** Trigger ("take", "click", "exit:cliff-path", "use:cold-lamp", "talk", "ending") → sound id. */
  shots: Record<string, string>;
  /** Spoken lines (diorama voices): the text the page says → its recording. */
  lines?: Record<string, { file: string; seconds: number }>;
};

/** Mixer gain per kind and level, before distance: the bed sits under loops, music under both. */
export const BUS: Record<SoundKind, number> = { music: 0.32, bed: 0.55, loop: 0.8, step: 0.55, shot: 0.85 };
const LEVEL = [0, 0.55, 1, 1.5];

export const levelGain = (kind: SoundKind, level: number) => BUS[kind] * (LEVEL[level] ?? 1);

/**
 * Where a thing's loop sits for a hero at (hx, hy): pan from where the thing is on screen,
 * gain falling off with distance in hero heights, never fully silent so the place still has it.
 */
export function placeSound(thingX: number, thingY: number, hx: number, hy: number, viewX: number, width: number, heroPx: number): { pan: number; gain: number } {
  const pan = Math.max(-0.8, Math.min(0.8, (thingX - viewX) / (width / 2)));
  const d = Math.hypot(thingX - hx, (thingY - hy) * 1.6) / Math.max(40, heroPx);
  const gain = 0.2 + 0.8 / (1 + (d / 2.5) ** 2);
  return { pan: Math.round(pan * 1000) / 1000, gain: Math.round(gain * 1000) / 1000 };
}

/** The floor index under (x, y) from geometry.zone, or -1. */
export function zoneAt(zone: string[] | undefined, cell: number, x: number, y: number): number {
  const row = zone?.[Math.floor(y / cell)];
  const ch = row?.[Math.floor(x / cell)];
  return ch && ch >= '0' && ch <= '9' ? Number(ch) : -1;
}
