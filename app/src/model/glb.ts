// Reads the bind-pose shape of a skinned glTF binary: vertex positions in scene space and triangles.
// Enough for measuring a silhouette; the runtime loads the file itself with three.js.
import fs from 'node:fs';
import path from 'node:path';
import { shapeProblem } from './quality.ts';
export { MIN_DEPTH } from './quality.ts';

type Node = { mesh?: number; skin?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] };
type Accessor = { bufferView: number; byteOffset?: number; componentType: number; count: number; type: string };
type Gltf = {
  nodes: Node[];
  skins?: { joints: number[]; inverseBindMatrices?: number }[];
  meshes: { primitives: { attributes: Record<string, number>; indices?: number }[] }[];
  accessors: Accessor[];
  bufferViews: { byteOffset?: number; byteStride?: number; byteLength: number }[];
};

export type Shape = { positions: Float32Array; triangles: Uint32Array };

type M4 = number[];
const identity = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function multiply(a: M4, b: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return o;
}
function local(n: Node): M4 {
  if (n.matrix) return n.matrix;
  const [x, y, z, w] = n.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = n.scale ?? [1, 1, 1];
  const [tx, ty, tz] = n.translation ?? [0, 0, 0];
  // Column-major T * R * S.
  return [
    (1 - 2 * (y * y + z * z)) * sx, 2 * (x * y + z * w) * sx, 2 * (x * z - y * w) * sx, 0,
    2 * (x * y - z * w) * sy, (1 - 2 * (x * x + z * z)) * sy, 2 * (y * z + x * w) * sy, 0,
    2 * (x * z + y * w) * sz, 2 * (y * z - x * w) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
    tx, ty, tz, 1,
  ];
}

function readAccessor(gltf: Gltf, bin: Buffer, index: number): Float32Array | Uint32Array {
  const a = gltf.accessors[index];
  const view = gltf.bufferViews[a.bufferView];
  const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type] ?? 1;
  const size = { 5126: 4, 5125: 4, 5123: 2, 5121: 1 }[a.componentType] ?? 4;
  const stride = view.byteStride ?? width * size;
  const start = (view.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out = a.componentType === 5126 ? new Float32Array(a.count * width) : new Uint32Array(a.count * width);
  for (let i = 0; i < a.count; i++) for (let j = 0; j < width; j++) {
    const at = start + i * stride + j * size;
    out[i * width + j] = a.componentType === 5126 ? bin.readFloatLE(at) : a.componentType === 5125 ? bin.readUInt32LE(at) : a.componentType === 5123 ? bin.readUInt16LE(at) : bin.readUInt8(at);
  }
  return out;
}

/** Native sprite rendering needs UVs and a self-contained base-colour image on every mesh primitive. */
export function hasModelTexture(glb: Buffer): boolean {
  try {
    if (glb.readUInt32LE(0) !== 0x46546c67) return false;
    const length = glb.readUInt32LE(12);
    const g = JSON.parse(glb.subarray(20, 20 + length).toString('utf8'));
    const primitives = (g.meshes ?? []).flatMap((m: { primitives?: unknown[] }) => m.primitives ?? []);
    return primitives.length > 0 && primitives.every((p: { attributes?: Record<string, number>; material?: number }) => {
      const map = g.materials?.[p.material!]?.pbrMetallicRoughness?.baseColorTexture;
      const uv = g.accessors?.[p.attributes?.[`TEXCOORD_${map?.texCoord ?? 0}`]!];
      const position = g.accessors?.[p.attributes?.POSITION!];
      const image = g.images?.[g.textures?.[map?.index]?.source];
      const embedded = image && (typeof image.uri === 'string' && /^data:image\/(png|jpeg);base64,/.test(image.uri)
        || Number.isInteger(image.bufferView) && g.bufferViews?.[image.bufferView]?.byteLength > 0);
      return !!(map && (map.texCoord ?? 0) === 0 && uv?.type === 'VEC2' && uv.count > 0 && uv.count === position?.count && embedded);
    });
  } catch { return false; }
}

/**
 * The first mesh in the file (the skinned one when there is a skin), in scene space. `original`: the surface as
 * TRELLIS built it, where Blender relaxed the pose (src/model/blender.ts keeps it as the _REST attribute); the
 * painted views were fitted to that surface.
 */
export function readShape(glb: Buffer, original = false): Shape {
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('not a glTF binary');
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf;
  const binStart = 20 + jsonLength;
  const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
  const parent = new Map<number, number>();
  gltf.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const nodeIndex = gltf.nodes.findIndex((n) => n.mesh !== undefined && n.skin !== undefined) >= 0
    ? gltf.nodes.findIndex((n) => n.mesh !== undefined && n.skin !== undefined)
    : gltf.nodes.findIndex((n) => n.mesh !== undefined);
  if (nodeIndex < 0) throw new Error('no mesh in the file');
  let world = identity();
  for (let i: number | undefined = nodeIndex; i !== undefined; i = parent.get(i)) world = multiply(local(gltf.nodes[i]), world);
  const positions: number[] = [];
  const triangles: number[] = [];
  for (const prim of gltf.meshes[gltf.nodes[nodeIndex].mesh!].primitives) {
    const base = positions.length / 3;
    const p = readAccessor(gltf, bin, original && prim.attributes._REST !== undefined ? prim.attributes._REST : prim.attributes.POSITION) as Float32Array;
    for (let i = 0; i < p.length; i += 3) {
      const [x, y, z] = [p[i], p[i + 1], p[i + 2]];
      positions.push(world[0] * x + world[4] * y + world[8] * z + world[12], world[1] * x + world[5] * y + world[9] * z + world[13], world[2] * x + world[6] * y + world[10] * z + world[14]);
    }
    const idx = prim.indices !== undefined ? readAccessor(gltf, bin, prim.indices) : Uint32Array.from({ length: p.length / 3 }, (_, i) => i);
    for (const k of idx) triangles.push(base + k);
  }
  return { positions: Float32Array.from(positions), triangles: Uint32Array.from(triangles) };
}

/** Inverse of a column-major 4x4 matrix (cofactors). */
function invert(m: M4): M4 {
  const o = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
    // Cofactor of m[row c][col r], transposed into o[col c][row r].
    const rows = [0, 1, 2, 3].filter((i) => i !== c);
    const cols = [0, 1, 2, 3].filter((i) => i !== r);
    const at = (i: number, j: number) => m[cols[j] * 4 + rows[i]];
    const det3 = at(0, 0) * (at(1, 1) * at(2, 2) - at(1, 2) * at(2, 1)) - at(0, 1) * (at(1, 0) * at(2, 2) - at(1, 2) * at(2, 0)) + at(0, 2) * (at(1, 0) * at(2, 1) - at(1, 1) * at(2, 0));
    o[c * 4 + r] = ((r + c) % 2 ? -1 : 1) * det3;
  }
  const det = m[0] * o[0] + m[4] * o[1] + m[8] * o[2] + m[12] * o[3];
  return o.map((v) => v / det);
}

/**
 * Why the auto-rig's skeleton cannot walk this body, or null. Make-It-Animatable guesses the joints from the
 * shape alone; on a floor-length robe it once put both feet at hip height and the knees below them, so every
 * step tore the robe apart and pulled the shoes up into poles. Heights are shares of the body's height, at bind.
 */
export function rigProblem(glb: Buffer): string | null {
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf;
  const skin = gltf.skins?.[0];
  if (!skin?.inverseBindMatrices && skin?.inverseBindMatrices !== 0) return null;
  const binStart = 20 + jsonLength;
  const bin = glb.subarray(binStart + 8, binStart + 8 + glb.readUInt32LE(binStart));
  const parent = new Map<number, number>();
  gltf.nodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  const meshNode = gltf.nodes.findIndex((n) => n.mesh !== undefined && n.skin === 0);
  let world = identity();
  for (let i: number | undefined = meshNode; i !== undefined && i >= 0; i = parent.get(i)) world = multiply(local(gltf.nodes[i]), world);
  const ibm = readAccessor(gltf, bin, skin.inverseBindMatrices);
  const y: Record<string, number> = {};
  skin.joints.forEach((node, j) => {
    const bind = multiply(world, invert(Array.from(ibm.subarray(j * 16, j * 16 + 16))));
    y[((gltf.nodes[node] as { name?: string }).name ?? '').replace(/^mixamorig:?/, '')] = bind[13];
  });
  const shape = readShape(glb).positions;
  let [lo, hi] = [Infinity, -Infinity];
  for (let i = 1; i < shape.length; i += 3) { lo = Math.min(lo, shape[i]); hi = Math.max(hi, shape[i]); }
  const at = (bone: string) => (y[bone] - lo) / (hi - lo);
  const need = ['Hips', 'Neck', 'Head', 'LeftLeg', 'RightLeg', 'LeftFoot', 'RightFoot'];
  if (need.some((b) => y[b] === undefined)) return null;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  if (!(at('Hips') < at('Neck') && at('Neck') < at('Head'))) return `skeleton upside down: hips at ${pct(at('Hips'))}, head at ${pct(at('Head'))} of the height`;
  for (const side of ['Left', 'Right']) {
    const [knee, foot] = [at(`${side}Leg`), at(`${side}Foot`)];
    // Feet sit at 4-13% in every rig that walks; a kicking or stepping pose reaches about 35%.
    if (foot > 0.4 || foot >= knee || knee >= at('Hips')) return `skeleton misplaced: ${side.toLowerCase()} foot at ${pct(foot)}, knee at ${pct(knee)}, hips at ${pct(at('Hips'))} of the height`;
  }
  return null;
}

/** Feet at y 0, height 1, centred on x and z: the hero-unit space the runtime projects views in. */
export function normalise({ positions, triangles }: Shape): Shape {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], positions[i]);
    hi[i % 3] = Math.max(hi[i % 3], positions[i]);
  }
  const h = hi[1] - lo[1];
  const centre = [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2];
  return { positions: positions.map((v, i) => (v - centre[i % 3]) / h), triangles };
}

/** Why a model cannot stand in for the character, or null. Shared with the browser's loader. */
export function badModel(shape: Shape): string | null {
  return shapeProblem(shape.positions);
}

/** Why cast/<key>/model/ cannot be used (a model kept before badModel was checked), or null. */
export function modelProblem(modelDir: string): string | null {
  const glb = path.join(modelDir, 'model.glb');
  if (!fs.existsSync(glb)) return 'no model.glb';
  try {
    const file = fs.readFileSync(glb);
    return badModel(readShape(file)) ?? rigProblem(file);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** How far the body leans: the slope of x and of z against height, over the body between shins and brow. */
export function lean(shape: Shape): { x: number; z: number } {
  const { positions: p } = normalise(shape);
  let [n, sy, syy, sx, sxy, sz, szy] = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1];
    if (y < 0.1 || y > 0.9) continue;
    n++; sy += y; syy += y * y; sx += p[i]; sxy += p[i] * y; sz += p[i + 2]; szy += p[i + 2] * y;
  }
  const d = n * syy - sy * sy;
  return d > 0 ? { x: (n * sxy - sx * sy) / d, z: (n * szy - sz * sy) / d } : { x: 0, z: 0 };
}

const qmul = ([ax, ay, az, aw]: number[], [bx, by, bz, bw]: number[]) => [
  aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz,
];

/** The same file with its scene turned so the body stands straight up. A model reconstructed from paintings
 * can come out pitched or rolled by a few degrees; the fit has no rotation, and a hero should not walk tilted. */
export function standUp(glb: Buffer): Buffer {
  const { x, z } = lean(readShape(glb));
  // Turning about x by -atan(z) takes the forward lean out; about z by atan(x) the sideways one.
  const [tx, tz] = [-Math.atan(z) / 2, Math.atan(x) / 2];
  const fix = qmul([0, 0, Math.sin(tz), Math.cos(tz)], [Math.sin(tx), 0, 0, Math.cos(tx)]);
  if (Math.abs(fix[3]) > Math.cos(0.5 * Math.PI / 180 / 2)) return glb;
  const jsonLength = glb.readUInt32LE(12);
  const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8')) as Gltf & { scenes?: { nodes: number[] }[]; scene?: number };
  const children = new Set(gltf.nodes.flatMap((n) => n.children ?? []));
  const roots = gltf.scenes?.[gltf.scene ?? 0]?.nodes ?? gltf.nodes.map((_, i) => i).filter((i) => !children.has(i));
  const [fx, fy, fz, fw] = fix;
  const turn = local({ rotation: fix });
  for (const i of roots) {
    const n = gltf.nodes[i];
    if (n.matrix) { n.matrix = multiply(turn, n.matrix); continue; }
    n.rotation = qmul([fx, fy, fz, fw], n.rotation ?? [0, 0, 0, 1]);
    const [px, py, pz] = n.translation ?? [0, 0, 0];
    if (px || py || pz) n.translation = [0, 1, 2].map((r) => turn[r] * px + turn[4 + r] * py + turn[8 + r] * pz);
  }
  let json = Buffer.from(JSON.stringify(gltf), 'utf8');
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, ' ')]);
  const rest = glb.subarray(20 + jsonLength);
  const head = Buffer.alloc(20);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(glb.readUInt32LE(4), 4);
  head.writeUInt32LE(20 + json.length + rest.length, 8);
  head.writeUInt32LE(json.length, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  return Buffer.concat([head, json, rest]);
}
