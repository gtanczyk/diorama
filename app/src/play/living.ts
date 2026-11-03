// living: how the painted sea, waterfalls, animals and clouds move, as plain numbers for the page (app/web/living.ts)
// to draw with. Pure, so it is tested without a canvas.

/** How stormy a place is, 0 calm .. 1 a gale: from the weather's fall and wind. A calm place still swells a little. */
export function stormOf(w?: { fall: string; strength: number; wind: number }): number {
  if (!w) return 0;
  const wet = w.fall === 'none' ? 0 : Math.max(0, (w.strength - 0.3) / 0.6);
  return Math.min(1, 0.55 * wet + 0.6 * Math.abs(w.wind));
}

/**
 * The swell of still water (the sea, a lake) at a point of its box: u is the row's place down the water (0 far,
 * 1 near). Waves roll toward the viewer (their phase runs down the rows, wider apart near, as in perspective) and
 * slant a little across; near rows heave more. Returns where to read the texture from, relative to the point,
 * and how high on a crest it is (-1 trough .. 1 crest).
 */
export function swellAt(x: number, u: number, t: number, storm: number): { dx: number; dy: number; crest: number } {
  const wave = 5.5 * Math.log(1 + 6 * u) - 1.5 * t * (1 + 0.5 * storm) + x * 0.006 + 0.8 * Math.sin(x * 0.0021 + t * 0.23);
  const crest = Math.sin(wave);
  const big = 0.7 + 1.3 * storm;
  const dy = crest * (0.6 + 7.5 * u) * big;
  const dx = (Math.sin(t * 0.9 + u * 40 + x * 0.003) * (1.2 + 5 * u) + Math.sin(t * 0.37 + u * 11) * (1 + 3 * u)) * (0.8 + 0.8 * storm);
  return { dx, dy, crest };
}

/**
 * Points along the water's edge where it meets land, rock or a hull (not the horizon above it, not the frame's
 * edge), every `step` px: where foam churns. `alpha` is the water's soft mask, w x h, 0..255.
 */
export function shorePoints(alpha: Uint8Array | Uint8ClampedArray, w: number, h: number, step = 10, stride = 1): Array<{ x: number; y: number; nx: number; ny: number }> {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : alpha[(y * w + x) * stride + (stride - 1)]);
  const out: Array<{ x: number; y: number; nx: number; ny: number }> = [];
  const R = 8;
  for (let y = R; y < h - R; y += 3) {
    for (let x = R; x < w - R; x += 3) {
      if (at(x, y) < 160) continue;
      // The dry side: the neighbour R px away that is not water.
      let [nx, ny] = [0, 0];
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (at(x + dx * R, y + dy * R) >= 0 && at(x + dx * R, y + dy * R) < 40) [nx, ny] = [nx + dx, ny + dy];
      if (!nx && !ny) continue;
      // Land only above it, in the far third: that is the horizon or a far bank, no surf there.
      if (ny < 0 && !nx && y < h * 0.35) continue;
      if (out.some((p) => Math.abs(p.x - x) < step && Math.abs(p.y - y) < step)) continue;
      const len = Math.hypot(nx, ny);
      out.push({ x, y, nx: nx / len, ny: ny / len });
    }
  }
  return out;
}

/** A painted animal's swim (or flight) at time t: its offset, which way it faces now (scaleX, through 0 as it turns), its tilt, and a leap. */
export type Swim = { dx: number; dy: number; scaleX: number; rot: number; leap: number; sinceLeap: number };

/**
 * Swims back and forth about where it was painted, turning (a paper card flipping) at each end, bobbing, and now
 * and then (in the water) leaping out in an arc: `leap` is 0 in the water, 0..1 through the leap. `facing`: the way
 * it was painted (1 right). `k`: which animal, for its own phase. `width`: its size in px, for how far it goes.
 */
export function swimAt(t: number, k: number, facing: 1 | -1, width: number, medium: 'water' | 'air'): Swim {
  const reach = Math.max(14, Math.min(70, width * (medium === 'air' ? 1.2 : 0.55)));
  const w = (medium === 'air' ? 0.32 : 0.22) + 0.05 * ((k * 7) % 5) / 5;
  const ph = t * w + k * 2.3;
  const dx = reach * Math.sin(ph);
  const v = Math.cos(ph);
  const scaleX = facing * Math.max(-1, Math.min(1, 3 * v));
  const dy = (medium === 'air' ? 9 : 2.5) * Math.sin(t * 1.3 + k * 1.7);
  let rot = 0.05 * Math.sin(t * 2.1 + k);
  // A leap every 11..17 s, 1.1 s long, at its own time.
  let [leap, sinceLeap] = [0, Infinity];
  if (medium === 'water') {
    const period = 11 + ((k * 5) % 7);
    const at = (t + k * 3.7) % period;
    sinceLeap = at;
    if (at < 1.1) {
      leap = at / 1.1;
      rot += Math.sign(v || 1) * (leap - 0.5) * 0.9;
    }
  }
  return { dx, dy, scaleX, rot, leap, sinceLeap };
}

/** How high a leap carries, px, at 0..1 through it. */
export const leapHeight = (leap: number, height: number) => Math.sin(Math.PI * leap) * Math.max(30, height * 1.6);
