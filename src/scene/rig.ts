// A figure cut into parts the runtime can walk: SAM finds arms, legs and boots, code places the joints.
// Joints sit at a person's usual proportions (hip at half the height, knee at 0.28) on the parts' own pixels.
import sharp from 'sharp';
import { emptyMask, maskArea, type Mask } from '../image/mask.ts';
import { components, dilate, intersect, maskBox, subtract, union, unionAll } from '../image/raster.ts';
import type { Memo } from '../meta/memo.ts';
import { samFind } from '../meta/sam.ts';
import type { PartName, Rig } from '../play/rig.ts';

type P = [number, number];

/** Mean x of the mask's pixels in rows y-band..y+band, or undefined when there are none. */
function centreX(m: Mask, y: number, band = 6): number | undefined {
  let sum = 0;
  let n = 0;
  for (let yy = Math.max(0, Math.round(y - band)); yy <= Math.min(m.height - 1, Math.round(y + band)); yy++) {
    for (let x = 0; x < m.width; x++) if (m.bits[yy * m.width + x]) (sum += x), n++;
  }
  return n ? sum / n : undefined;
}

const overlap = (a: Mask, b: Mask) => maskArea(intersect(a, b));

/** Splits a leg at its knee: pixels before the knee along hip to ankle are thigh, the rest shin, sharing a seam. */
function splitLeg(leg: Mask, hip: P, knee: P, ankle: P, seam: number): { thigh: Mask; shin: Mask } {
  const thigh = emptyMask(leg.width, leg.height);
  const shin = emptyMask(leg.width, leg.height);
  const dir: P = [ankle[0] - hip[0], ankle[1] - hip[1]];
  const L = Math.hypot(...dir);
  const at = ((knee[0] - hip[0]) * dir[0] + (knee[1] - hip[1]) * dir[1]) / L;
  for (let i = 0; i < leg.bits.length; i++) {
    if (!leg.bits[i]) continue;
    const x = i % leg.width;
    const y = Math.floor(i / leg.width);
    const t = ((x - hip[0]) * dir[0] + (y - hip[1]) * dir[1]) / L;
    if (t < at + seam) thigh.bits[i] = 1;
    if (t > at - seam) shin.bits[i] = 1;
  }
  return { thigh, shin };
}

function distToLine([x, y]: P, points: P[]): number {
  let best = Infinity;
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1];
    const [bx, by] = points[k];
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

/** Pixels within r of the polyline through `points`. */
function capsule(width: number, height: number, points: P[], r: number): Mask {
  const m = emptyMask(width, height);
  for (let k = 1; k < points.length; k++) {
    const [ax, ay] = points[k - 1];
    const [bx, by] = points[k];
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy || 1;
    for (let y = Math.max(0, Math.floor(Math.min(ay, by) - r)); y <= Math.min(height - 1, Math.ceil(Math.max(ay, by) + r)); y++) {
      for (let x = Math.max(0, Math.floor(Math.min(ax, bx) - r)); x <= Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r)); x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2));
        if (Math.hypot(x - ax - t * dx, y - ay - t * dy) <= r) m.bits[y * width + x] = 1;
      }
    }
  }
  return m;
}

/**
 * Paints over `hole` with the colours around it: each hole pixel takes the mean of the known pixels in the
 * smallest block (2, 4, 8 ... px) around it that has any. Smooth, without the streaks of a ring-by-ring fill.
 */
function fillHole(rgba: Buffer, width: number, keep: Mask, hole: Mask) {
  const height = keep.height;
  const todo: number[] = [];
  hole.bits.forEach((b, i) => b && !keep.bits[i] && todo.push(i));
  for (let size = 2; todo.length && size <= 512; size *= 2) {
    const bw = Math.ceil(width / size);
    const bh = Math.ceil(height / size);
    const sum = new Float64Array(bw * bh * 4);
    for (let i = 0; i < keep.bits.length; i++) {
      if (!keep.bits[i]) continue;
      const b = Math.floor(Math.floor(i / width) / size) * bw + Math.floor((i % width) / size);
      sum[b * 4] += rgba[i * 4]; sum[b * 4 + 1] += rgba[i * 4 + 1]; sum[b * 4 + 2] += rgba[i * 4 + 2]; sum[b * 4 + 3]++;
    }
    for (let k = todo.length - 1; k >= 0; k--) {
      const i = todo[k];
      // The pixel's own block and its neighbours, so the mean is centred on it rather than on a grid.
      const bx = Math.floor((i % width) / size);
      const by = Math.floor(Math.floor(i / width) / size);
      let r = 0, g = 0, bl = 0, n = 0;
      for (let y = Math.max(0, by - 1); y <= Math.min(bh - 1, by + 1); y++) {
        for (let x = Math.max(0, bx - 1); x <= Math.min(bw - 1, bx + 1); x++) {
          const b = (y * bw + x) * 4;
          r += sum[b]; g += sum[b + 1]; bl += sum[b + 2]; n += sum[b + 3];
        }
      }
      if (!n) continue;
      rgba[i * 4] = r / n; rgba[i * 4 + 1] = g / n; rgba[i * 4 + 2] = bl / n; rgba[i * 4 + 3] = 255;
      todo.splice(k, 1);
    }
  }
  // Soften the block edges: box-blur the image three times and keep the result only inside the hole.
  const inside = new Uint8Array(hole.bits.length);
  hole.bits.forEach((b, i) => (inside[i] = b && !keep.bits[i] ? 1 : 0));
  for (let pass = 0; pass < 3; pass++) blurInside(rgba, width, height, inside, 6);
}

/** Box blur weighted by opacity (transparent pixels add nothing), written back only inside the hole. */
function blurInside(rgba: Buffer, width: number, height: number, inside: Uint8Array, r: number) {
  const N = width * height;
  // Premultiplied channels plus a weight channel, blurred along x then y.
  let cur = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    const a = rgba[i * 4 + 3] > 0 ? 1 : 0;
    cur[i * 4] = rgba[i * 4] * a; cur[i * 4 + 1] = rgba[i * 4 + 1] * a; cur[i * 4 + 2] = rgba[i * 4 + 2] * a; cur[i * 4 + 3] = a;
  }
  for (const horizontal of [true, false]) {
    const next = new Float32Array(N * 4);
    const lines = horizontal ? height : width;
    const len = horizontal ? width : height;
    const idx = (line: number, k: number) => (horizontal ? line * width + k : k * width + line) * 4;
    for (let line = 0; line < lines; line++) {
      const acc = [0, 0, 0, 0];
      for (let k = 0; k <= Math.min(r, len - 1); k++) for (let c = 0; c < 4; c++) acc[c] += cur[idx(line, k) + c];
      for (let k = 0; k < len; k++) {
        for (let c = 0; c < 4; c++) next[idx(line, k) + c] = acc[c];
        if (k + r + 1 < len) for (let c = 0; c < 4; c++) acc[c] += cur[idx(line, k + r + 1) + c];
        if (k - r >= 0) for (let c = 0; c < 4; c++) acc[c] -= cur[idx(line, k - r) + c];
      }
    }
    cur = next;
  }
  for (let i = 0; i < N; i++) {
    if (!inside[i] || cur[i * 4 + 3] <= 0) continue;
    for (let c = 0; c < 3; c++) rgba[i * 4 + c] = cur[i * 4 + c] / cur[i * 4 + 3];
  }
}

/** Hole of `part` inside the body: its pixels in rows where the body has pixels on both sides. */
function enclosed(body: Mask, part: Mask): Mask {
  const out = emptyMask(body.width, body.height);
  for (let y = 0; y < body.height; y++) {
    let left = -1, right = -1;
    for (let x = 0; x < body.width; x++) if (body.bits[y * body.width + x]) (left < 0 && (left = x)), (right = x);
    if (left < 0) continue;
    for (let x = left; x <= right; x++) if (part.bits[y * body.width + x]) out.bits[y * body.width + x] = 1;
  }
  return out;
}

export type RigBuild = { rig: Rig; parts: Record<string, Buffer>; issues: string[] };

export async function rigFigure(memo: Memo, key: string, painting: Buffer): Promise<RigBuild> {
  const png = await sharp(painting).png().toBuffer();
  const find = async (prompt: string) => (await samFind(memo, { label: `rig:${key}:${prompt}`, image: png, prompt })).map((f) => f.mask);
  const [people, arms, boots, legsFound, trousers] = await Promise.all(['person', 'arm', 'boot', 'leg', 'trousers'].map(find));
  const issues: string[] = [];
  const person = people.sort((a, b) => maskArea(b) - maskArea(a))[0];
  if (!person) throw new Error(`${key}: SAM found no person to rig`);
  const { width: W, height: Hh } = person;
  const [px0, top, px1, bottom] = maskBox(person)!;
  const ground = bottom - 1;
  const H = ground - top;
  const inPerson = (m: Mask) => intersect(m, person);

  // Two boots, nearest-first by size; a figure in long trousers or a dress may show none.
  const feet = boots.map(inPerson).filter((b) => maskArea(b) > H * 2).sort((a, b) => maskArea(b) - maskArea(a)).slice(0, 2);
  if (feet.length < 2) issues.push(`found ${feet.length} boot(s), legs end at the knee split instead`);
  const footless = (m: Mask) => feet.reduce((acc, f) => subtract(acc, f), m);
  // The lower body without the feet: SAM's trousers, else every leg it found.
  const lower = footless(inPerson(trousers[0] ?? unionAll(W, Hh, legsFound)));
  if (maskArea(lower) < H * 4) throw new Error(`${key}: no legs found to rig`);

  // Near leg: the bigger whole leg SAM sees; far leg: the rest of the lower body.
  const leg = legsFound.map((l) => footless(inPerson(l))).filter((l) => maskArea(l) > H * 4).sort((a, b) => maskArea(b) - maskArea(a))[0];
  let near: Mask;
  let far: Mask;
  if (leg && maskArea(subtract(lower, leg)) > maskArea(lower) * 0.15) {
    near = intersect(dilate(leg, 1), lower);
    far = components(subtract(lower, near))[0];
  } else {
    // One leg mask covering both (or none): each lower-body pixel goes to the leg whose line,
    // hip to knee to the top of its boot, runs nearest. The bigger boot is the near one.
    issues.push('legs split along hip-to-boot lines, not by SAM');
    const lowerBox = maskBox(lower)!;
    const hipGuess: P = [centreX(lower, Math.max(ground - 0.5 * H, lowerBox[1] + 8), 10) ?? (px0 + px1) / 2, ground - 0.5 * H];
    const line = (f: Mask): P[] => {
      const t = maskBox(f)![1];
      const foot: P = [centreX(f, t + 4, 4) ?? hipGuess[0], t];
      return [hipGuess, [(hipGuess[0] + foot[0]) / 2, (hipGuess[1] + foot[1]) / 2], foot];
    };
    const lines = feet.map(line);
    near = emptyMask(W, Hh);
    far = emptyMask(W, Hh);
    lower.bits.forEach((b, i) => {
      if (!b) return;
      const at: P = [i % W, Math.floor(i / W)];
      (lines.length < 2 || distToLine(at, lines[0]) <= distToLine(at, lines[1]) ? near : far).bits[i] = 1;
    });
    far = components(far)[0] ?? far;
  }
  // Each boot belongs to the leg it touches most.
  const touching = (legMask: Mask, f: Mask) => overlap(dilate(legMask, 4), f);
  const [nearBoot, farBoot] = feet.length === 2 && touching(near, feet[1]) > touching(near, feet[0]) ? [feet[1], feet[0]] : [feet[0], feet[1] ?? emptyMask(W, Hh)];

  const handMasks = (await find('hand')).map(inPerson);
  // SAM's arm often stops at the cuff; each hand joins the arm it touches.
  const withHand = (arm: Mask) => handMasks.filter((h) => overlap(dilate(arm, 3), h) > 0).reduce((a, h) => union(a, h), arm);
  const armMasks = arms.map(inPerson).map(withHand).filter((a) => maskArea(a) > H * 3).sort((a, b) => maskArea(b) - maskArea(a)).slice(0, 2);
  if (armMasks.length < 2) issues.push(`found ${armMasks.length} arm(s); a missing arm stays on the torso`);
  const [nearArm = emptyMask(W, Hh), farArm = emptyMask(W, Hh)] = armMasks.map((a, i) => (i === 0 ? intersect(dilate(a, 3), person) : a));

  // Joints at usual proportions, on the parts' own pixels.
  const hipY = ground - 0.5 * H;
  const legsBox = maskBox(union(near, far))!;
  const hipX = centreX(union(near, far), Math.max(hipY, legsBox[1] + 8), 10) ?? (px0 + px1) / 2;
  const hip: P = [hipX, hipY];
  const joints = (legMask: Mask, boot: Mask) => {
    const kneeY = ground - 0.28 * H;
    const knee: P = [centreX(legMask, kneeY) ?? hipX, kneeY];
    // The ankle pivot is where the leg enters the boot (its top middle), so the boot hangs off the shin's end.
    const bootBox = maskArea(boot) ? maskBox(boot) : undefined;
    const ankleY = bootBox ? bootBox[1] + 0.02 * H : maskBox(legMask)![3] - 0.02 * H;
    const ankle: P = [centreX(bootBox ? boot : legMask, ankleY, 0.015 * H) ?? knee[0], ankleY];
    return { knee, ankle };
  };
  const nearJ = joints(near, nearBoot);
  const farJ = joints(far, farBoot);
  const shoulderY = ground - 0.8 * H;
  const shoulder = (arm: Mask): P => {
    const box = maskBox(arm);
    return [box ? (centreX(arm, box[1] + 0.06 * H, 0.04 * H) ?? hipX) : hipX, box ? Math.max(shoulderY, box[1] + 0.05 * H) : shoulderY];
  };

  const seam = Math.max(3, 0.012 * H);
  // Each leg completed to a whole limb: what the coat or the other leg hid gets the leg's own colours,
  // so nothing tears open when the legs part.
  const { data } = await sharp(png).resize(W, Hh, { fit: 'fill' }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const wholeLeg = (visible: Mask, j: { knee: P; ankle: P }, boot: Mask) => {
    const length = Math.hypot(j.knee[0] - hip[0], j.knee[1] - hip[1]) + Math.hypot(j.ankle[0] - j.knee[0], j.ankle[1] - j.knee[1]);
    const r = Math.min(0.07 * H, Math.max(0.03 * H, maskArea(visible) / length / 2));
    const tube = subtract(capsule(W, Hh, [hip, j.knee, j.ankle], r), boot);
    const mask = union(visible, tube);
    const pixels = Buffer.from(data);
    fillHole(pixels, W, visible, mask);
    return { mask, pixels };
  };
  const nearWhole = wholeLeg(near, nearJ, nearBoot);
  const farWhole = wholeLeg(far, farJ, farBoot);
  const nearSplit = splitLeg(nearWhole.mask, hip, nearJ.knee, nearJ.ankle, seam);
  const farSplit = splitLeg(farWhole.mask, hip, farJ.knee, farJ.ankle, seam);
  const limbs = unionAll(W, Hh, [near, far, nearBoot, farBoot, nearArm, farArm]);
  const torso = components(subtract(person, limbs)).filter((c, i) => i === 0 || maskArea(c) > H * 2).reduce((a, c) => union(a, c), emptyMask(W, Hh));

  // Room around the figure for swinging legs, then every part as its own RGBA image.
  const margin = Math.round(0.3 * H);
  const crop = { x0: Math.max(0, px0 - margin), y0: Math.max(0, top - Math.round(0.05 * H)) };
  const crop1 = { x1: Math.min(W, px1 + margin), y1: Math.min(Hh, bottom + 2) };
  const torsoPixels = Buffer.from(data);
  // The body behind the near arm, painted in from the colours around it.
  const behindArm = enclosed(torso, dilate(nearArm, 2));
  fillHole(torsoPixels, W, torso, behindArm);
  const torsoFilled = union(torso, behindArm);

  const masks: Record<PartName, { mask: Mask; from: Buffer }> = {
    farArm: { mask: farArm, from: data },
    farThigh: { mask: farSplit.thigh, from: farWhole.pixels },
    farShin: { mask: farSplit.shin, from: farWhole.pixels },
    farBoot: { mask: farBoot, from: data },
    nearThigh: { mask: nearSplit.thigh, from: nearWhole.pixels },
    nearShin: { mask: nearSplit.shin, from: nearWhole.pixels },
    nearBoot: { mask: nearBoot, from: data },
    torso: { mask: torsoFilled, from: torsoPixels },
    nearArm: { mask: nearArm, from: data },
  };
  const parts: Record<string, Buffer> = {};
  const list: Rig['parts'] = [];
  for (const name of Object.keys(masks) as PartName[]) {
    const { mask, from } = masks[name];
    const box = maskBox(mask);
    if (!box) continue;
    const [x0, y0, x1, y1] = box;
    const w = x1 - x0;
    const h = y1 - y0;
    const out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y0 + y) * W + x0 + x;
        if (!mask.bits[i]) continue;
        from.copy(out, (y * w + x) * 4, i * 4, i * 4 + 4);
      }
    }
    const file = `${name}.png`;
    parts[file] = await sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
    list.push({ name, file, at: [x0 - crop.x0, y0 - crop.y0] });
  }
  const shift = (p: P): P => [p[0] - crop.x0, p[1] - crop.y0];
  const rig: Rig = {
    size: [crop1.x1 - crop.x0, crop1.y1 - crop.y0],
    ground: ground - crop.y0,
    height: H,
    hip: shift(hip),
    shoulder: { near: shift(shoulder(nearArm)), far: shift(shoulder(farArm)) },
    leg: { near: { knee: shift(nearJ.knee), ankle: shift(nearJ.ankle) }, far: { knee: shift(farJ.knee), ankle: shift(farJ.ankle) } },
    parts: list,
  };
  return { rig, parts, issues };
}
