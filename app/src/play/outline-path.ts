// The hover outline as smooth closed lines along the edge of a cut-out's alpha: marching squares, then Chaikin.
export type Loop = Array<[number, number]>;

/**
 * The closed contours of where `alpha` (w x h, one byte per pixel) is at least `threshold`, in pixel units (pixel
 * centres at +0.5). Specks smaller than `minArea` px and holes smaller than `minHole` px are dropped, so a cut-out's
 * speckled inside (rain, a halo of light) gives one clean line round it; the rest are smoothed by `smooth` rounds of
 * corner cutting. Outer loops run clockwise on screen (positive area), holes the other way.
 */
export function outlineLoops(alpha: ArrayLike<number>, w: number, h: number, { threshold = 128, minArea = 60, minHole = 60, smooth = 3 }: { threshold?: number; minArea?: number; minHole?: number; smooth?: number } = {}): Loop[] {
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : alpha[y * w + x]);
  const inside = (x: number, y: number) => at(x, y) >= threshold;
  // Where the edge crosses between two pixel centres, by their values.
  const cross = (a: number, b: number) => {
    const t = (threshold - a) / (b - a || 1);
    return Math.max(0.05, Math.min(0.95, t));
  };
  // Segments between edge points keyed by "x,y" of the point; each cell of 2x2 pixel centres gives 0-2 of them.
  // Points sit on cell sides: H (between (x,y) and (x+1,y)) or V (between (x,y) and (x,y+1)).
  const next = new Map<string, string>();
  const pos = new Map<string, [number, number]>();
  const point = (kind: 'h' | 'v', x: number, y: number): string => {
    const key = `${kind}${x},${y}`;
    if (!pos.has(key)) {
      pos.set(key, kind === 'h' ? [x + 0.5 + cross(at(x, y), at(x + 1, y)), y + 0.5] : [x + 0.5, y + 0.5 + cross(at(x, y), at(x, y + 1))]);
    }
    return key;
  };
  // Oriented so the inside is always on the same side: loops chain head to tail.
  const link = (a: string, b: string) => next.set(a, b);
  for (let y = -1; y < h; y++) {
    for (let x = -1; x < w; x++) {
      const tl = inside(x, y), tr = inside(x + 1, y), br = inside(x + 1, y + 1), bl = inside(x, y + 1);
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const top = () => point('h', x, y), right = () => point('v', x + 1, y), bottom = () => point('h', x, y + 1), left = () => point('v', x, y);
      switch (c) {
        case 1: link(left(), bottom()); break;
        case 2: link(bottom(), right()); break;
        case 3: link(left(), right()); break;
        case 4: link(right(), top()); break;
        case 5: link(left(), top()); link(right(), bottom()); break;
        case 6: link(bottom(), top()); break;
        case 7: link(left(), top()); break;
        case 8: link(top(), left()); break;
        case 9: link(top(), bottom()); break;
        case 10: link(top(), right()); link(bottom(), left()); break;
        case 11: link(top(), right()); break;
        case 12: link(right(), left()); break;
        case 13: link(right(), bottom()); break;
        case 14: link(bottom(), left()); break;
      }
    }
  }
  const loops: Loop[] = [];
  const seen = new Set<string>();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop: Loop = [];
    let k: string | undefined = start;
    while (k && !seen.has(k)) {
      seen.add(k);
      loop.push(pos.get(k)!);
      k = next.get(k);
    }
    const a = loop.length >= 3 ? area(loop) : 0;
    if (a >= minArea || -a >= minHole) loops.push(chaikin(loop, smooth));
  }
  return loops;
}

/** Signed area (shoelace). */
export function area(loop: Loop): number {
  let s = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0] = loop[i];
    const [x1, y1] = loop[(i + 1) % loop.length];
    s += x0 * y1 - x1 * y0;
  }
  return s / 2;
}

/** Corner cutting on a closed loop: each round keeps 1/4 and 3/4 along every side. */
export function chaikin(loop: Loop, rounds: number): Loop {
  let pts = loop;
  for (let r = 0; r < rounds; r++) {
    const out: Loop = [];
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i];
      const [x1, y1] = pts[(i + 1) % pts.length];
      out.push([0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1], [0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1]);
    }
    pts = out;
  }
  return pts;
}

/**
 * The alpha of a cut-out made ready for its outline: a box blur of radius `r` (twice, near a gaussian) rounds the
 * jagged steps of a mask and swallows hairline gaps, so the line follows the shape and not its pixels.
 */
export function softAlpha(alpha: ArrayLike<number>, w: number, h: number, r = 2): Uint8Array {
  let a = Float32Array.from(alpha as ArrayLike<number>);
  for (let pass = 0; pass < 2; pass++) {
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = -r; x <= r; x++) s += x >= 0 && x < w ? a[y * w + x] : 0;
      for (let x = 0; x < w; x++) {
        tmp[y * w + x] = s / (2 * r + 1);
        const add = x + r + 1, sub = x - r;
        if (add < w) s += a[y * w + add];
        if (sub >= 0) s -= a[y * w + sub];
      }
    }
    const out = new Float32Array(w * h);
    for (let x = 0; x < w; x++) {
      let s = 0;
      for (let y = -r; y <= r; y++) s += y >= 0 && y < h ? tmp[y * w + x] : 0;
      for (let y = 0; y < h; y++) {
        out[y * w + x] = s / (2 * r + 1);
        const add = y + r + 1, sub = y - r;
        if (add < h) s += tmp[add * w + x];
        if (sub >= 0) s -= tmp[sub * w + x];
      }
    }
    a = out;
  }
  return Uint8Array.from(a, (v) => Math.round(v));
}
