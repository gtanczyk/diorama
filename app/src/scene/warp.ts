// The painted figure walked as one sheet of rubber, not cut into parts: a fine mesh over the painting, each point
// pulled by the bones near it (hip, thighs, shins, boots, arms), so a coat, an apron or a skirt stretches and swings
// with the legs instead of tearing, and a leg never comes off its trousers. The walk is drawn here once into a
// sheet of frames (and the untouched painting as the standing frame); the runtime only plays the cells.
import sharp from 'sharp';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { components, dilate, maskBox } from '../image/raster.ts';
import { swingPose, type PartName, type PartPose, type Pose, type Rig } from '../play/rig.ts';

type P = [number, number];

/** What each painted pixel belongs to; its bones pull it. */
export const enum Part { None, Body, NearArm, FarArm, NearLeg, FarLeg, NearBoot, FarBoot }

/** Back to front: the far side, the near leg (behind a coat or an apron), the body, the near arm on top. */
const LAYER: Record<Part, number> = { [Part.None]: 0, [Part.FarArm]: 0, [Part.FarLeg]: 0, [Part.FarBoot]: 0, [Part.NearLeg]: 1, [Part.NearBoot]: 1, [Part.Body]: 2, [Part.NearArm]: 3 };

/**
 * One label per pixel of `silhouette`: the masks in order (a later one wins), and every pixel none of them
 * covers (a held lantern, a net of fish, an apron string) takes the label of the nearest labelled pixel.
 */
export function labelPixels(silhouette: Mask, masks: [Part, Mask][], person?: Mask): Uint8Array {
  const { width: W, height: H } = silhouette;
  const label = new Uint8Array(W * H);
  for (const [part, m] of masks) m.bits.forEach((b, i) => b && silhouette.bits[i] && (label[i] = part));
  // Something held (outside SAM's person) goes whole with the hand that holds it, else with what it touches most.
  if (person) {
    const held = emptyMask(W, H);
    silhouette.bits.forEach((b, i) => (held.bits[i] = b && !person.bits[i] && !label[i] ? 1 : 0));
    for (const c of components(held)) {
      const touch = new Map<number, number>();
      const ring = dilate(c, 2);
      ring.bits.forEach((b, i) => b && !c.bits[i] && label[i] && touch.set(label[i], (touch.get(label[i]) ?? 0) + 1));
      if (!touch.size) continue;
      // Held up in both hands (a big slice of toast over the head), it goes with the body and so do both arms:
      // they carry it, they do not swing away from it.
      const arms = [Part.NearArm, Part.FarArm].filter((a) => touch.has(a)).sort((a, b) => touch.get(b)! - touch.get(a)!);
      const carried = arms.length === 2 && maskArea(c) > 0.5 * maskArea(person);
      if (carried) label.forEach((l, i) => (l === Part.NearArm || l === Part.FarArm) && (label[i] = Part.Body));
      const part = carried ? Part.Body : arms[0] ?? [...touch].sort((a, b) => b[1] - a[1])[0][0];
      c.bits.forEach((b, i) => b && (label[i] = part));
    }
  }
  // Breadth-first from every labelled pixel through the silhouette.
  let front: number[] = [];
  label.forEach((l, i) => l && front.push(i));
  while (front.length) {
    const next: number[] = [];
    for (const i of front) {
      const x = i % W;
      for (const n of [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, i - W, i + W]) {
        if (n < 0 || n >= W * H || !silhouette.bits[n] || label[n]) continue;
        label[n] = label[i];
        next.push(n);
      }
    }
    front = next;
  }
  // Pieces cut off from everything (a speck SAM left) go with the body.
  silhouette.bits.forEach((b, i) => b && !label[i] && (label[i] = Part.Body));
  return label;
}

function segDist([x, y]: P, [ax, ay]: P, [bx, by]: P): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return { d: Math.hypot(x - ax - t * dx, y - ay - t * dy), t };
}

const smooth = (u: number) => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));

type Weights = [PartName, number][];

/** How much each bone pulls a point of the figure, in the rig's own coordinates. */
export function weightsAt(rig: Rig, p: P, part: Part): Weights {
  const H = rig.height;
  const leg = (side: 'near' | 'far', boot: boolean): Weights => {
    const { knee, ankle } = rig.leg[side];
    const thigh = `${side}Thigh` as PartName;
    const shin = `${side}Shin` as PartName;
    const bootName = `${side}Boot` as PartName;
    if (boot) {
      // A boot keeps its shape; only its top, where it meets the shin, bends with the shin.
      const s = 1 - smooth((p[1] - ankle[1]) / (0.03 * H));
      return s > 0 ? [[bootName, 1 - s], [shin, s]] : [[bootName, 1]];
    }
    // Along the leg: thigh above the knee, shin below, mixed over a short band round the knee; the bottom of
    // a trouser leg hanging over the boot follows the shin.
    const toKnee = ((p[0] - knee[0]) * (ankle[0] - rig.hip[0]) + (p[1] - knee[1]) * (ankle[1] - rig.hip[1])) / (Math.hypot(ankle[0] - rig.hip[0], ankle[1] - rig.hip[1]) || 1);
    const s = smooth((toKnee + 0.04 * H) / (0.08 * H));
    return [[thigh, 1 - s], [shin, s]];
  };
  switch (part) {
    case Part.NearLeg: return leg('near', false);
    case Part.FarLeg: return leg('far', false);
    case Part.NearBoot: return leg('near', true);
    case Part.FarBoot: return leg('far', true);
    case Part.NearArm:
    case Part.FarArm: {
      // An arm turns at the shoulder: the sleeve's top stays with the body, so the arm never leaves the shoulder.
      const side = part === Part.NearArm ? 'near' : 'far';
      const at = rig.shoulder[side];
      const s = smooth(Math.hypot(p[0] - at[0], p[1] - at[1]) / (0.1 * H));
      return s < 1 ? [[`${side}Arm`, s], ['torso', 1 - s]] : [[`${side}Arm`, 1]];
    }
    default: {
      // The body above the hip is one piece. Below it (a coat's skirt, an apron, a dress, a jumper's hem), the
      // cloth goes more and more with the legs the lower it hangs, each bit with the leg it is nearest.
      const u = 0.45 * smooth((p[1] - rig.hip[1]) / (0.14 * H));
      if (u <= 0) return [['torso', 1]];
      const near = Math.min(segDist(p, rig.hip, rig.leg.near.knee).d, segDist(p, rig.leg.near.knee, rig.leg.near.ankle).d);
      const far = Math.min(segDist(p, rig.hip, rig.leg.far.knee).d, segDist(p, rig.leg.far.knee, rig.leg.far.ankle).d);
      const wn = 1 / (near + 0.02 * H) ** 2;
      const wf = 1 / (far + 0.02 * H) ** 2;
      const out: Weights = [['torso', 1 - u]];
      for (const [side, w] of [['near', wn / (wn + wf)], ['far', wf / (wn + wf)]] as const) {
        // Cloth hangs from the hip: it follows the thigh's swing, not the knee's bend under it.
        out.push([`${side}Thigh` as PartName, u * w]);
      }
      return out;
    }
  }
}

const move = ({ from, to, turn }: PartPose, [x, y]: P): P => {
  const c = Math.cos(turn);
  const s = Math.sin(turn);
  const dx = x - from[0];
  const dy = y - from[1];
  return [to[0] + c * dx - s * dy, to[1] + s * dx + c * dy];
};

export type Sheet = { png: Buffer; cols: number; rows: number; frames: number; cell: P; scale: number };

/**
 * The walk as a sheet: `frames` cells of one cycle, then the standing figure, each `scale` times the rig's size.
 * `image` is the figure in the rig's coordinates (RGBA, rig.size), `labels` one Part per pixel of it.
 */
export async function warpSheet(rig: Rig, image: Buffer, labels: Uint8Array, { frames = 8, px = 520, grid = 4 } = {}): Promise<Sheet> {
  const [W, Hh] = rig.size.map(Math.round);
  const scale = Math.min(1, px / rig.height);
  const cw = Math.round(W * scale);
  const ch = Math.round(Hh * scale);
  // The source, premultiplied, at the sheet's scale (sampled bilinear), and the labels at it.
  const { data: src } = await sharp(image, { raw: { width: W, height: Hh, channels: 4 } }).resize(cw, ch, { fit: 'fill', kernel: 'lanczos3' }).raw().toBuffer({ resolveWithObject: true });
  const pre = new Float32Array(cw * ch * 4);
  for (let i = 0; i < cw * ch; i++) {
    const a = src[i * 4 + 3] / 255;
    pre[i * 4] = src[i * 4] * a; pre[i * 4 + 1] = src[i * 4 + 1] * a; pre[i * 4 + 2] = src[i * 4 + 2] * a; pre[i * 4 + 3] = a;
  }
  const labelAt = (x: number, y: number) => labels[Math.min(Hh - 1, Math.max(0, Math.round(y / scale))) * W + Math.min(W - 1, Math.max(0, Math.round(x / scale)))];

  // The mesh: vertices every `grid` sheet pixels; each cell's label is the one most of its pixels carry.
  const gx = Math.ceil(cw / grid) + 1;
  const gy = Math.ceil(ch / grid) + 1;
  const cells: { i: number; j: number; layer: number }[] = [];
  const vertexPart = new Uint8Array(gx * gy);
  for (let j = 0; j < gy - 1; j++) {
    for (let i = 0; i < gx - 1; i++) {
      const count = new Map<number, number>();
      let ink = false;
      for (let y = j * grid; y < Math.min(ch, (j + 1) * grid + 1); y++) {
        for (let x = i * grid; x < Math.min(cw, (i + 1) * grid + 1); x++) {
          if (pre[(y * cw + x) * 4 + 3] <= 0.01) continue;
          ink = true;
          const l = labelAt(x, y);
          count.set(l, (count.get(l) ?? 0) + 1);
        }
      }
      if (!ink) continue;
      const part = [...count].sort((a, b) => b[1] - a[1])[0][0] || Part.Body;
      cells.push({ i, j, layer: LAYER[part as Part] });
      // A vertex takes the label of a cell it belongs to, nearer parts first (a far limb's edge goes with the body).
      for (const v of [j * gx + i, j * gx + i + 1, (j + 1) * gx + i, (j + 1) * gx + i + 1]) if (!vertexPart[v] || LAYER[part as Part] > LAYER[vertexPart[v] as Part]) vertexPart[v] = part;
    }
  }
  cells.sort((a, b) => a.layer - b.layer);
  // Each vertex's bones from the label under it, or its cell's label where it sits on the figure's edge.
  const weights: Weights[] = [];
  for (let j = 0; j < gy; j++) {
    for (let i = 0; i < gx; i++) {
      const sx = i * grid;
      const sy = j * grid;
      const own = sx < cw && sy < ch && pre[(sy * cw + sx) * 4 + 3] > 0.01 ? labelAt(sx, sy) : 0;
      weights.push(weightsAt(rig, [sx / scale, sy / scale], (own || vertexPart[j * gx + i] || Part.Body) as Part));
    }
  }

  // Weights change smoothly over the cloth: a hem where a leg comes out from under an apron bends over a few
  // cells instead of between two neighbouring vertices (which tears a long thin streak).
  smoothWeights(weights, gx, gy, cells.length ? new Set(cells.flatMap(({ i, j }) => [j * gx + i, j * gx + i + 1, (j + 1) * gx + i, (j + 1) * gx + i + 1])) : new Set(), Math.max(1, Math.round((0.03 * rig.height * scale) / grid)));
  const poses: Pose[] = [...Array(frames).keys()].map((f) => swingPose(rig, f / frames));
  const total = frames + 1;
  const cols = Math.min(total, 5);
  const rows = Math.ceil(total / cols);
  const sheet = Buffer.alloc(cols * cw * rows * ch * 4);
  const SW = cols * cw;
  for (let f = 0; f < total; f++) {
    const ox = (f % cols) * cw;
    const oy = Math.floor(f / cols) * ch;
    if (f === frames) {
      // Standing: the painting itself.
      for (let y = 0; y < ch; y++) src.copy(sheet, ((oy + y) * SW + ox) * 4, y * cw * 4, (y + 1) * cw * 4);
      continue;
    }
    const at = poses[f];
    const dst = new Float32Array(cw * ch * 4);
    const out: P[] = weights.map((w, v) => {
      const p: P = [(v % gx) * grid / scale, Math.floor(v / gx) * grid / scale];
      let x = 0, y = 0, sum = 0;
      for (const [bone, k] of w) {
        if (k <= 0) continue;
        const q = move(at[bone], p);
        x += q[0] * k; y += q[1] * k; sum += k;
      }
      return [(x / (sum || 1)) * scale, (y / (sum || 1)) * scale];
    });
    for (const { i, j } of cells) {
      const a = j * gx + i;
      const quad = [a, a + 1, a + gx + 1, a + gx];
      for (const tri of [[quad[0], quad[1], quad[2]], [quad[0], quad[2], quad[3]]]) {
        drawTriangle(dst, cw, ch, pre, tri.map((v) => out[v]) as [P, P, P], tri.map((v) => [(v % gx) * grid, Math.floor(v / gx) * grid]) as [P, P, P]);
      }
    }
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const s = (y * cw + x) * 4;
        const a = dst[s + 3];
        const o = ((oy + y) * SW + ox + x) * 4;
        if (a <= 0) continue;
        sheet[o] = Math.round(dst[s] / a); sheet[o + 1] = Math.round(dst[s + 1] / a); sheet[o + 2] = Math.round(dst[s + 2] / a); sheet[o + 3] = Math.round(Math.min(1, a) * 255);
      }
    }
  }
  const png = await sharp(sheet, { raw: { width: SW, height: rows * ch, channels: 4 } }).png().toBuffer();
  return { png, cols, rows, frames, cell: [cw, ch], scale };
}

/** Paints a triangle of the source (at `uv`, sheet pixels) where the mesh moved it (`xy`), over what is drawn. */
function drawTriangle(dst: Float32Array, W: number, H: number, src: Float32Array, xy: [P, P, P], uv: [P, P, P]) {
  const [[x0, y0], [x1, y1], [x2, y2]] = xy;
  const det = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
  if (Math.abs(det) < 1e-6) return;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(x0, x1, x2)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(y0, y1, y2)));
  const eps = -1e-3;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const b1 = ((px - x0) * (y2 - y0) - (x2 - x0) * (py - y0)) / det;
      const b2 = ((x1 - x0) * (py - y0) - (px - x0) * (y1 - y0)) / det;
      const b0 = 1 - b1 - b2;
      if (b0 < eps || b1 < eps || b2 < eps) continue;
      const u = b0 * uv[0][0] + b1 * uv[1][0] + b2 * uv[2][0] - 0.5;
      const v = b0 * uv[0][1] + b1 * uv[1][1] + b2 * uv[2][1] - 0.5;
      // Bilinear, premultiplied.
      const ux = Math.max(0, Math.min(W - 1, Math.floor(u)));
      const vy = Math.max(0, Math.min(H - 1, Math.floor(v)));
      const ux1 = Math.min(W - 1, ux + 1);
      const vy1 = Math.min(H - 1, vy + 1);
      const fx = Math.max(0, Math.min(1, u - ux));
      const fy = Math.max(0, Math.min(1, v - vy));
      const o = (y * W + x) * 4;
      const s = [0, 0, 0, 0];
      for (let c = 0; c < 4; c++) {
        s[c] = (src[(vy * W + ux) * 4 + c] * (1 - fx) + src[(vy * W + ux1) * 4 + c] * fx) * (1 - fy)
          + (src[(vy1 * W + ux) * 4 + c] * (1 - fx) + src[(vy1 * W + ux1) * 4 + c] * fx) * fy;
      }
      if (s[3] <= 0) continue;
      // Later layers go on top: premultiplied "over".
      for (let c = 0; c < 4; c++) dst[o + c] = s[c] + dst[o + c] * (1 - s[3]);
    }
  }
}

/**
 * Whether ink of `area` px is what the figure stands in, not theirs: a framed scene painted behind them (a cardboard
 * box of stormy sea) touches them and is compact like a lantern, but it is bigger than they are, or a solid patch
 * holding their whole outline. A bubble they float in holds them too, but only as a thin ring.
 */
function standsIn(c: Mask, area: number, figure: number, [fx0, fy0, fx1, fy1]: [number, number, number, number]): boolean {
  const [x0, y0, x1, y1] = maskBox(c)!;
  const holds = x0 <= fx0 && y0 <= fy0 && x1 >= fx1 && y1 >= fy1;
  return area > 0.6 * figure || (holds && area / ((x1 - x0 + 1) * (y1 - y0 + 1)) > 0.35);
}

/** The figure's whole outline: SAM's person, plus what it holds (a lantern, a net) that stands out from the plain ground, holes filled. */
export function silhouette(rgba: Buffer, person: Mask, tolerance = 64): Mask {
  const { width: W, height: H } = person;
  // The ground colour: the median of the picture's border.
  const border: number[][] = [];
  for (let x = 0; x < W; x += 4) for (const y of [0, H - 1]) border.push([...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]);
  for (let y = 0; y < H; y += 4) for (const x of [0, W - 1]) border.push([...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]);
  const ground = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  const ink = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) ink.bits[i] = Math.hypot(rgba[i * 4] - ground[0], rgba[i * 4 + 1] - ground[1], rgba[i * 4 + 2] - ground[2]) > tolerance ? 1 : 0;
  const near = dilate(person, 3);
  const out = { width: W, height: H, bits: person.bits.slice() };
  person.bits.forEach((b, i) => b && (ink.bits[i] = 0));
  const rim = dilate(person, 4);
  const size = maskArea(person);
  const [px0, py0, px1, py1] = maskBox(person) ?? [0, 0, 0, 0];
  const parts = components(ink);
  const behind = parts.filter((c) => standsIn(c, maskArea(c), size, [px0, py0, px1, py1]));
  // Standing in a painted scene, what shows through a gap in the figure (between the legs) is that scene too.
  const holes = behind.length ? fillHoles(person) : undefined;
  for (const c of parts) {
    if (behind.includes(c) || (holes && c.bits.every((b, i) => !b || holes.bits[i]))) continue;
    let touches = false;
    let outside = 0;
    let area = 0;
    for (let i = 0; i < c.bits.length; i++) {
      if (!c.bits[i]) continue;
      area++;
      touches ||= !!near.bits[i];
      if (!rim.bits[i]) outside++;
    }
    if (!touches) continue;
    // The rim SAM's mask left off the figure's edge always; beyond it, only something compact (a lantern, a
    // bag), not a rail or the haze the figure leans in.
    const [x0, y0, x1, y1] = maskBox(c)!;
    const compact = area / ((x1 - x0 + 1) * (y1 - y0 + 1)) > 0.35;
    if (outside < 50 || compact) c.bits.forEach((b, i) => b && (out.bits[i] = 1));
    else c.bits.forEach((b, i) => b && rim.bits[i] && (out.bits[i] = 1));
  }
  // ... and the gaps fillHoles would close stay open.
  const filled = fillHoles(out);
  if (holes) ink.bits.forEach((b, i) => b && !out.bits[i] && (filled.bits[i] = 0));
  return filled;
}

/**
 * What floats around a figure as part of who they are (a heart beside them, the bubble they sit in, a halo): ink on
 * the plain ground near the figure that does not touch it, so silhouette leaves it out. A figure is painted alone on
 * plain grey, so a sizeable mark close by is theirs (a heart 10%+ of the figure, a bubble's rings 25%); watercolour splashes
 * around the figure (1-2%) are not. Added as drawn, holes not filled: a bubble's
 * outline comes along, not the grey inside it.
 */
export function companions(rgba: Buffer, figure: Mask, tolerance = 64): Mask {
  const { width: W, height: H } = figure;
  const box = maskBox(figure);
  if (!box) return figure;
  const border: number[][] = [];
  for (let x = 0; x < W; x += 4) for (const y of [0, H - 1]) border.push([...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]);
  for (let y = 0; y < H; y += 4) for (const x of [0, W - 1]) border.push([...rgba.subarray((y * W + x) * 4, (y * W + x) * 4 + 3)]);
  const ground = [0, 1, 2].map((c) => border.map((p) => p[c]).sort((a, b) => a - b)[border.length >> 1]);
  const ink = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) ink.bits[i] = !figure.bits[i] && Math.hypot(rgba[i * 4] - ground[0], rgba[i * 4 + 1] - ground[1], rgba[i * 4 + 2] - ground[2]) > tolerance ? 1 : 0;
  const [x0, y0, x1, y1] = box;
  const reach = 0.35 * (y1 - y0);
  const area = maskArea(figure);
  const out = { width: W, height: H, bits: figure.bits.slice() };
  for (const c of components(ink)) {
    const b = maskBox(c)!;
    const near = b[0] < x1 + reach && b[2] > x0 - reach && b[1] < y1 + reach && b[3] > y0 - reach;
    // Not the picture's frame or a strip along its edge: that is the painting, not the figure.
    const edge = b[0] <= 1 || b[1] <= 1 || b[2] >= W - 1 || b[3] >= H - 1;
    if (near && !edge && maskArea(c) >= 0.04 * area && !standsIn(c, maskArea(c), area, box)) c.bits.forEach((v, i) => v && (out.bits[i] = 1));
  }
  return out;
}

/** The mask with every gap it closes round (not reaching the picture's edge) filled. */
export function fillHoles(m: Mask): Mask {
  const { width: W, height: H } = m;
  const outside = new Uint8Array(W * H);
  const stack: number[] = [];
  for (let x = 0; x < W; x++) for (const y of [0, H - 1]) if (!m.bits[y * W + x]) stack.push(y * W + x);
  for (let y = 0; y < H; y++) for (const x of [0, W - 1]) if (!m.bits[y * W + x]) stack.push(y * W + x);
  while (stack.length) {
    const i = stack.pop()!;
    if (outside[i] || m.bits[i]) continue;
    outside[i] = 1;
    const x = i % W;
    if (x > 0) stack.push(i - 1);
    if (x < W - 1) stack.push(i + 1);
    if (i >= W) stack.push(i - W);
    if (i < W * (H - 1)) stack.push(i + W);
  }
  const out = emptyMask(W, H);
  for (let i = 0; i < W * H; i++) out.bits[i] = outside[i] ? 0 : 1;
  return out;
}

const BONES: PartName[] = ['torso', 'nearThigh', 'nearShin', 'nearBoot', 'farThigh', 'farShin', 'farBoot', 'nearArm', 'farArm'];

/** Box-blurs each bone's weight over the mesh (three passes of radius r), among the vertices the figure uses. */
function smoothWeights(weights: Weights[], gx: number, gy: number, used: Set<number>, r: number) {
  const n = BONES.length;
  let w = new Float32Array(gx * gy * n);
  weights.forEach((list, v) => { for (const [bone, k] of list) w[v * n + BONES.indexOf(bone)] += k; });
  for (let pass = 0; pass < 3; pass++) {
    for (const horizontal of [true, false]) {
      const next = new Float32Array(w);
      for (const v of used) {
        const i = v % gx;
        const j = Math.floor(v / gx);
        const acc = new Float32Array(n);
        let count = 0;
        for (let d = -r; d <= r; d++) {
          const ii = horizontal ? i + d : i;
          const jj = horizontal ? j : j + d;
          if (ii < 0 || jj < 0 || ii >= gx || jj >= gy) continue;
          const u = jj * gx + ii;
          if (!used.has(u)) continue;
          for (let b = 0; b < n; b++) acc[b] += w[u * n + b];
          count++;
        }
        for (let b = 0; b < n; b++) next[v * n + b] = acc[b] / count;
      }
      w = next;
    }
  }
  for (const v of used) weights[v] = BONES.map((bone, b): [PartName, number] => [bone, w[v * n + b]]).filter(([, k]) => k > 1e-4);
}
