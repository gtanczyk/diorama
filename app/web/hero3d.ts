// A rigged 3D figure (cast/<key>/model/) drawn into its own canvas, so the 2D page draws it like a
// sprite: feet planted on the walk cycle the 2D rig uses, any facing, Muse's four painted views on its
// surface, lit by the painting around it. The page only imports this when a world ships a model.
import * as THREE from 'three';
import { ModelFace } from './face3d.ts';
import type { FaceDefinition, FaceState } from '../src/play/lipsync.ts';
import { PaintedFace } from './face.ts';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GESTURES, type Pose as GesturePose } from '../src/play/gestures.ts';
import { CYCLE } from '../src/play/rig.ts';
import { creatureMotion } from '../src/play/creature.ts';
import { shapeProblem } from '../src/model/quality.ts';

const STANCE = 0.6;

const LIFT = 0.06;
const smooth = (u: number) => u * u * (3 - 2 * u);

/** model.json, written by `diorama model`. */
export type ModelInfo = {
  glb: string;
  /** Use the GLB's UV texture when independently painted views project duplicate features onto the mesh. Omitted: projected views. */
  texture?: 'model' | 'views';
  /** Disable the long-coat weight correction for trousers. Omitted preserves legacy models. */
  coatCorrection?: boolean;
  /** With the UV texture: 'views' when TRELLIS baked the face blank, so the front painting goes on the face (src/model/sprites.ts uvFaceLost). */
  face?: 'views';
  /** Not a person on two legs (a round eye, a frog): the model has no skeleton and moves as a whole body (src/play/creature.ts). */
  creature?: boolean;
  /** Blender put the rest pose calm (src/model/blender.ts): arms hang, so they may swing like a walker's. */
  relaxed?: boolean;
  /** bands: the across fit per slice of the height (src/model/fit.ts BANDS), feet first; without them, u everywhere. */
  views: Record<'front' | 'back' | 'left' | 'right', { image: string; u: [number, number]; v: [number, number]; iou: number; bands?: [number, number][] }>;
};

/** How the painting lights the figure where it stands (colours as 0xRRGGBB). */
export type FigureLight = {
  sky: number; ground: number; ambient: number;
  key?: { dir: [number, number, number]; color: number; intensity: number };
  rim?: { dir: [number, number, number]; color: number; intensity: number };
};

/**
 * Default light for a painted model: the textures are the painted sides, shading already in them, so the light
 * gives back their own brightness. three.js lights are physical (a white surface under a white light of
 * intensity 1 shows 1/PI), so the hemisphere is PI times as strong: a wall-facing surface (half sky, half
 * ground) comes out at 1.0 of its paint, a top at 1.12, an underside at 0.88, enough to keep the form readable.
 * The old light (white over 0x888888 at 2.2) gave a side 0.44 of its paint in linear light: models looked
 * a third darker than the four painted sides, and so did the sprite guides Muse painted over.
 */
export const PAINTED_LIGHT: FigureLight = { sky: 0xffffff, ground: 0xe5e5e5, ambient: 1.12 * Math.PI };

/** Mean colour (linear) of a texture's used texels: the black or transparent spare atlas space is left out. */
function meanColour(image: CanvasImageSource): [number, number, number] | undefined {
  const R = 128;
  const c = Object.assign(document.createElement('canvas'), { width: R, height: R }).getContext('2d', { willReadFrequently: true })!;
  c.drawImage(image, 0, 0, R, R);
  const px = c.getImageData(0, 0, R, R).data;
  const sum = [0, 0, 0, 0];
  for (let at = 0; at < px.length; at += 4) {
    if (px[at + 3] < 128 || px[at] + px[at + 1] + px[at + 2] < 6) continue;
    for (let ch = 0; ch < 3; ch++) sum[ch] += (px[at + ch] / 255) ** 2.2;
    sum[3]++;
  }
  return sum[3] ? [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]] : undefined;
}

function footAt(p: number, step: number) {
  p = ((p % 1) + 1) % 1;
  if (p < STANCE) return { dx: step / 2 - (step * p) / STANCE, lift: 0, stance: true, u: p / STANCE };
  const u = (p - STANCE) / (1 - STANCE);
  return { dx: -step / 2 + step * smooth(u), lift: Math.sin(Math.PI * u), stance: false, u };
}

/** Extra foot rotation during swing; the early toe-off bend fades in and out without snapping. */
export function swingFootPitch(u: number): number {
  const toeOff = Math.sin(Math.PI * Math.min(1, Math.max(0, u / 0.3))) ** 2;
  return 0.35 * Math.sin(Math.PI * u) - 0.25 * toeOff;
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const turn = (axis: THREE.Vector3, a: number) => new THREE.Quaternion().setFromAxisAngle(axis, a);

// Which way each painted view looks at the figure (it faces +z): model axis across the picture, its
// sign, and the normal axis and sign of the surfaces that view sees. Matches src/model/fit.ts.
const VIEWS = [['front', 'x', 1, 'z', 1], ['back', 'x', -1, 'z', -1], ['left', 'z', -1, 'x', 1], ['right', 'z', 1, 'x', -1]] as const;

/** Slices of the height each view is fitted on, as src/model/fit.ts BANDS (no Node imports here). */
const BANDS = 20;

/** Height (share of the figure, feet 0) above which a surface counts as head: one view paints all of it. */
const HEAD_FROM = 0.8;

/** How much each view is preferred where two see a surface (added to how squarely it faces it). */
const TRUST = { front: 0.3, back: 0.1, left: 0, right: 0 };

// Kuwahara: flattens 3D shading into paint-like patches.
const KUWAHARA = `
uniform sampler2D tex; uniform vec2 texel; uniform int radius; varying vec2 vUv;
void main() {
  vec4 c0 = texture2D(tex, vUv);
  if (radius == 0) {
    gl_FragColor = c0;
    #include <colorspace_fragment>
    return;
  }
  vec3 m[4]; vec3 s[4]; float a[4];
  for (int k = 0; k < 4; k++) { m[k] = vec3(0.); s[k] = vec3(0.); a[k] = 0.; }
  for (int j = -4; j <= 4; j++) for (int i = -4; i <= 4; i++) {
    if (abs(i) > radius || abs(j) > radius) continue;
    vec4 c = texture2D(tex, vUv + vec2(float(i), float(j)) * texel);
    int q = (i <= 0 ? 0 : 1) + (j <= 0 ? 0 : 2);
    m[q] += c.rgb * c.a; s[q] += c.rgb * c.rgb * c.a; a[q] += c.a;
  }
  float best = 1e9; vec3 col = c0.rgb;
  for (int k = 0; k < 4; k++) {
    if (a[k] < 0.5) continue;
    vec3 mu = m[k] / a[k]; vec3 v = abs(s[k] / a[k] - mu * mu);
    float vv = v.r + v.g + v.b;
    if (vv < best) { best = vv; col = mu; }
  }
  gl_FragColor = vec4(col, c0.a);
  #include <colorspace_fragment>
}`;

/**
 * Per vertex and view (VIEWS order), 1 where that view sees the vertex and 0 where a nearer surface covers it,
 * found with a depth buffer of the rest pose drawn the way each view looks at it.
 */
function visibility(rest: Float32Array, tris: number[]): Float32Array {
  const R = 256;
  const EPS = 0.015;
  const count = rest.length / 3;
  const out = new Float32Array(count * 4);
  VIEWS.forEach(([, ax, sx, nax, ns], k) => {
    const [a, n] = [{ x: 0, y: 1, z: 2 }[ax], { x: 0, y: 1, z: 2 }[nax]];
    const px = (i: number) => (sx * rest[i * 3 + a] + 0.6) * R / 1.2;
    const py = (i: number) => (1.05 - rest[i * 3 + 1]) * R / 1.1;
    const pz = (i: number) => ns * rest[i * 3 + n];
    const depth = new Float32Array(R * R).fill(-Infinity);
    for (let t = 0; t < tris.length; t += 3) {
      const [i0, i1, i2] = [tris[t], tris[t + 1], tris[t + 2]];
      const [x0, y0, x1, y1, x2, y2] = [px(i0), py(i0), px(i1), py(i1), px(i2), py(i2)];
      const area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = Math.max(0, Math.floor(Math.min(y0, y1, y2))); y <= Math.min(R - 1, Math.ceil(Math.max(y0, y1, y2))); y++) {
        for (let x = Math.max(0, Math.floor(Math.min(x0, x1, x2))); x <= Math.min(R - 1, Math.ceil(Math.max(x0, x1, x2))); x++) {
          const [cx, cy] = [x + 0.5, y + 0.5];
          const w0 = ((x1 - cx) * (y2 - cy) - (x2 - cx) * (y1 - cy)) / area;
          const w1 = ((x2 - cx) * (y0 - cy) - (x0 - cx) * (y2 - cy)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < 0 || w1 < 0 || w2 < 0) continue;
          depth[y * R + x] = Math.max(depth[y * R + x], w0 * pz(i0) + w1 * pz(i1) + w2 * pz(i2));
        }
      }
    }
    for (let i = 0; i < count; i++) {
      const [x, y] = [Math.floor(px(i)), Math.floor(py(i))];
      // The nearest surface around the vertex, so one on a silhouette edge is not hidden by a missed cell.
      let near = -Infinity;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const [xx, yy] = [x + dx, y + dy];
        if (xx >= 0 && yy >= 0 && xx < R && yy < R) near = Math.max(near, depth[yy * R + xx]);
      }
      out[i * 4 + k] = pz(i) >= near - EPS ? 1 : 0;
    }
  });
  return out;
}

type Leg = { thigh: number; shin: number; hipY: number; ankleY: number };

/**
 * Puts the bones where the skin was bound: the shape of the mesh itself (POSITION), which is the
 * reconstructed figure the views are painted on and src/model/glb.ts measures and stands up. A rig may
 * save the bones in another pose: Make-It-Animatable leaves them in its own T-pose, and for a figure in a
 * long coat that pose sits, legs forward and back leant (lamp-quarter's courier, every walk frame seated).
 * three.js binds glTF skins with an identity bind matrix, so a bone's bind world matrix is the mesh's world
 * matrix times its inverse bind matrix. Parents first, before the figure is placed.
 */
function toBindPose(root: THREE.Object3D, skinned: THREE.SkinnedMesh) {
  root.updateMatrixWorld(true);
  const sk = skinned.skeleton;
  const bind = new Map(sk.bones.map((b, i) => [b, skinned.matrixWorld.clone().multiply(sk.boneInverses[i].clone().invert())]));
  const m = new THREE.Matrix4();
  root.traverse((o) => {
    const world = bind.get(o as THREE.Bone);
    if (!world) return;
    m.copy(o.parent!.matrixWorld).invert().multiply(world).decompose(o.position, o.quaternion, o.scale);
    o.updateMatrixWorld(true);
  });
}

export class Figure3D {
  readonly canvas = document.createElement('canvas');
  /** Where the feet are in the canvas, as a share of its height (they are centred across). */
  feetAt = 0.95;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.OrthographicCamera(-0.5, 0.5, 1, 0, 0.01, 10);
  private hemi = new THREE.HemisphereLight(0xffffff, 0x666666, 2);
  private key = new THREE.DirectionalLight(0xffffff, 0);
  private rim = new THREE.DirectionalLight(0xffffff, 0);
  private rt = new THREE.WebGLRenderTarget(1, 1, { samples: 4 });
  private post: THREE.ShaderMaterial;
  private postScene = new THREE.Scene();
  private postCam = new THREE.Camera();
  private holder = new THREE.Group();
  private bones: Record<string, THREE.Bone> = {};
  private facial?: ModelFace;
  private surfaceSources: Array<{ name: string; file: string; image: HTMLImageElement; texture: THREE.Texture }> = [];
  private surfaces: Array<{ name: string; file: string; image: HTMLImageElement; texture: THREE.Texture; painter: PaintedFace; version: number }> = [];
  get facialCapabilities() {
    const morphs = this.facial?.mouth ?? false;
    return { mouth: morphs || this.surfaces.length > 0, eyes: (this.facial?.eyes ?? false) || this.surfaces.length > 0,
      method: morphs ? 'morphs' : this.surfaces.length ? 'painted-surfaces' : null, views: this.surfaces.map(s=>s.name) };
  }

  /** Each view owns a canvas: sharing one would paint the last profile onto every side of the model. */
  setFace(info: FaceDefinition, atlas: HTMLImageElement) {
    this.surfaces = []; this.lastFrame=undefined;
    for(const source of this.surfaceSources){source.texture.image=source.image;source.texture.needsUpdate=true;}
    if (this.facial?.mouth) return;
    const definition = this.facial?.eyes ? { ...info, sheets: Object.fromEntries(Object.entries(info.sheets).map(([key,poses])=>[key,poses.map(p=>p?{...p,eyes:[]}:null)])) } : info;
    for (const source of this.surfaceSources) {
      const pose = info.sheets[`model:${source.file}`]?.[0], view = pose?.atlas ?? 'default';
      if (!pose?.lips || !info.anchors?.[view] || !info.frames?.[view] || (view!=='default'&&!info.atlases?.[view])) continue;
      this.surfaces.push({...source,painter:new PaintedFace(definition,atlas,[view]),version:-1});
    }
  }

  private paintFace(state: FaceState) {
    for (const surface of this.surfaces) {
      const image = surface.painter.draw(surface.image,`model:${surface.file}`,0,1,1,state,0,0,undefined,state);
      if (surface.version === surface.painter.version) continue;
      surface.version = surface.painter.version;
      surface.texture.image = image;
      surface.texture.needsUpdate = true;
    }
  }
  private rest: Record<string, { q: THREE.Quaternion; parentWorld: THREE.Quaternion }> = {};
  private legs!: Record<'Left' | 'Right', Leg>;
  private arms!: Record<'Left' | 'Right', THREE.Vector3>;
  private hipsRest!: THREE.Vector3;
  /** A creature: no bones, the whole body hops, squashes and leans; reach is how far it spreads from its centre, in heights. */
  private creature = false;
  private relaxed = false;
  private reach = 0.45;
  private seed = Math.random() * 10;
  private lastFrame?: {frame:number;key:string};
  get creatureBody() {
    return this.creature;
  }
  /** Where the camera is, seen from the figure in its rest pose (it faces +z): picks the painted view to wear. */
  private camDir = { value: new THREE.Vector3(0, 0, 1) };

  static async load(info: ModelInfo, url: (file: string) => string, paint = 1): Promise<Figure3D> {
    const f = new Figure3D(paint);
    try {
      await f.build(info, url);
      return f;
    } catch (error) {
      f.dispose();
      throw error;
    }
  }

  /** Frees the WebGL context (a browser keeps only a few), for a page that shows figures one after another. */
  dispose() {
    for (const source of this.surfaceSources) source.texture.dispose();
    this.surfaceSources = []; this.surfaces = [];
    this.rt.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  /** Untextured: plain grey clay, so a guide shows only the form and the pose. */
  plain() {
    this.holder.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = new THREE.MeshStandardMaterial({ color: 0xb4b4b4, metalness: 0, roughness: 1 });
    });
  }

  private constructor(paint: number) {
    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true, preserveDrawingBuffer: true, premultipliedAlpha: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(0x000000, 0);
    this.scene.add(this.hemi, this.key, this.rim, this.key.target, this.rim.target, this.holder);
    this.post = new THREE.ShaderMaterial({
      uniforms: { tex: { value: this.rt.texture }, texel: { value: new THREE.Vector2() }, radius: { value: paint } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
      fragmentShader: KUWAHARA,
      transparent: true,
    });
    this.postScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.post));
  }

  private async build(info: ModelInfo, url: (file: string) => string) {
    const gltf = await new GLTFLoader().loadAsync(url(info.glb));
    const root = gltf.scene;
    let skinned: THREE.SkinnedMesh | undefined;
    let first: THREE.Mesh | undefined;
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = o as THREE.SkinnedMesh;
      if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        first ??= mesh;
        mesh.frustumCulled = false;
        const map = (mesh.material as THREE.MeshStandardMaterial).map;
        if (map) map.colorSpace = THREE.SRGBColorSpace;
        mesh.geometry.computeVertexNormals();
        mesh.material = new THREE.MeshStandardMaterial({ map, metalness: 0, roughness: 1 });
      }
    });
    // A creature's model is TRELLIS's mesh as it came, with no skeleton: it moves as one body.
    this.creature = !skinned;
    this.relaxed = !!info.relaxed && !!skinned;
    if (!skinned && !(info.creature && first)) throw new Error(`${info.glb}: no skinned mesh`);
    const body = (skinned ?? first)!;
    if (skinned) {
      for (const b of skinned.skeleton.bones) this.bones[b.name.replace(/^mixamorig:?/, '')] = b;
      toBindPose(root, skinned);
    }
    this.facial = new ModelFace(root);
    // Feet at 0, height 1, centred: measured on the mesh as posed now.
    this.holder.add(root);
    this.holder.updateMatrixWorld(true);
    skinned?.skeleton.update();
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const pos = body.geometry.attributes.position;
    const positions = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      box.expandByPoint(body.getVertexPosition(i, v).applyMatrix4(body.matrixWorld));
      v.toArray(positions, i * 3);
    }
    const problem = shapeProblem(positions);
    if (problem) throw new Error(`${info.glb}: ${problem}`);
    const h = box.max.y - box.min.y;
    const inner = new THREE.Group();
    this.holder.add(inner);
    inner.add(root);
    inner.scale.setScalar(1 / h);
    inner.position.set(-(box.min.x + box.max.x) / 2 / h, -box.min.y / h, -(box.min.z + box.max.z) / 2 / h);
    this.holder.updateMatrixWorld(true);
    if (info.texture === 'model') {
      if (!(body.material as THREE.MeshStandardMaterial).map || !body.geometry.attributes.uv) {
        throw new Error(`${info.glb}: model texture requires a base colour map and UV coordinates`);
      }
      // TRELLIS bakes its texture from a blurred reconstruction: the face comes out as a blank smudge and dark
      // cloth darker still (a navy coat goes black). The body keeps the UV texture (one colour per surface, no
      // seams between views), lifted to the painted views' brightness; the face wears the front painting, so it is the one Muse painted.
      await this.paintViews(body, info, url, true);
    } else {
      await this.paintViews(body, info, url);
    }
    if (!skinned) {
      // How far it spreads round its feet whichever way it turns (a cat is longer than it is tall): the frame fits it.
      for (let i = 0; i < pos.count; i++) {
        body.getVertexPosition(i, v).applyMatrix4(body.matrixWorld);
        // matrixWorld already centres the mesh and makes its height 1; do not normalise twice.
        this.reach = Math.max(this.reach, Math.hypot(v.x, v.z) + 0.06);
      }
      return;
    }
    for (const [k, b] of Object.entries(this.bones)) this.rest[k] = { q: b.quaternion.clone(), parentWorld: b.parent!.getWorldQuaternion(new THREE.Quaternion()) };
    const at = (k: string) => this.bones[k].getWorldPosition(new THREE.Vector3());
    const leg = (s: string): Leg => {
      const [hip, knee, ankle] = [at(`${s}UpLeg`), at(`${s}Leg`), at(`${s}Foot`)];
      return { thigh: hip.distanceTo(knee), shin: knee.distanceTo(ankle), hipY: hip.y, ankleY: ankle.y };
    };
    this.legs = { Left: leg('Left'), Right: leg('Right') };
    this.arms = { Left: at('LeftForeArm').sub(at('LeftArm')).normalize(), Right: at('RightForeArm').sub(at('RightArm')).normalize() };
    if (info.coatCorrection !== false) this.fixCoat(skinned, 0.035);
    this.hipsRest = this.bones.Hips.position.clone();
  }

  /** Muse's views, projected in the bind pose, so the paint rides on the surface while it moves. */
  private async paintViews(skinned: THREE.Mesh, info: ModelInfo, url: (file: string) => string, headOnly = false) {
    const g = skinned.geometry;
    // A model Blender relaxed carries the surface as TRELLIS built it (_REST): the views were painted and fitted on that.
    const original = g.attributes._rest as THREE.BufferAttribute | undefined;
    const pos = original ?? g.attributes.position;
    let nrm = g.attributes.normal;
    if (original) {
      const was = new THREE.BufferGeometry();
      was.setAttribute('position', original);
      if (g.index) was.setIndex(g.index);
      was.computeVertexNormals();
      nrm = was.attributes.normal;
    }
    const mw = skinned.matrixWorld;
    const nm = new THREE.Matrix3().getNormalMatrix(mw);
    const v = new THREE.Vector3();
    const box = new THREE.Box3();
    const rest = new Float32Array(pos.count * 3);
    const restN = new Float32Array(pos.count * 3);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(mw).toArray(rest, i * 3);
      box.expandByPoint(v);
      v.fromBufferAttribute(nrm, i).applyMatrix3(nm).normalize().toArray(restN, i * 3);
    }
    // Same hero units as src/model/glb.ts normalise().
    const h = box.max.y - box.min.y;
    const centre = [(box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2];
    for (let i = 0; i < rest.length; i++) rest[i] = (rest[i] - centre[i % 3]) / h;
    g.setAttribute('restPos', new THREE.BufferAttribute(rest, 3));
    g.setAttribute('restNrm', new THREE.BufferAttribute(restN, 3));
    g.setAttribute('restVis', new THREE.BufferAttribute(visibility(rest, g.index ? Array.from(g.index.array) : [...Array(pos.count).keys()]), 4));
    const uniforms: Record<string, THREE.IUniform> = {};
    const painted = [0, 0, 0, 0];
    await Promise.all(VIEWS.map(async ([name]) => {
      const img = new Image();
      img.src = url(info.views[name].image);
      await img.decode();
      // Each painting's own background, which marks where the figure is not: the median of its border, as
      // src/model/fit.ts finds it (a corner alone can be a lighter vignette).
      const R = 32;
      const c = Object.assign(document.createElement('canvas'), { width: R, height: R }).getContext('2d', { willReadFrequently: true })!;
      c.drawImage(img, 0, 0, R, R);
      const px = c.getImageData(0, 0, R, R).data;
      const border = [...Array(R).keys()].flatMap((i) => [[i, 0], [i, R - 1], [0, i], [R - 1, i]]).map(([x, y]) => (y * R + x) * 4);
      const median = (ch: number) => border.map((at) => px[at + ch]).sort((a, b) => a - b)[border.length >> 1];
      uniforms[`bg_${name}`] = { value: new THREE.Vector3(...[0, 1, 2].map((ch) => (median(ch) / 255) ** 2.2)) };
      // The figure's mean colour in this painting (linear), away from its background: the UV texture is matched to it.
      const bg = [0, 1, 2].map(median);
      for (let at = 0; at < px.length; at += 4) {
        if (Math.abs(px[at] - bg[0]) + Math.abs(px[at + 1] - bg[1]) + Math.abs(px[at + 2] - bg[2]) < 60) continue;
        for (let ch = 0; ch < 3; ch++) painted[ch] += (px[at + ch] / 255) ** 2.2;
        painted[3]++;
      }
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      const f = info.views[name];
      uniforms[`p_${name}`] = { value: tex };
      this.surfaceSources.push({name,file:f.image,image:img,texture:tex});
      uniforms[`f_${name}`] = { value: new THREE.Vector4(f.u[0], f.u[1], f.v[0], f.v[1]) };
      uniforms[`b_${name}`] = { value: (f.bands?.length === BANDS ? f.bands : Array(BANDS).fill(f.u)).map(([a, b]) => new THREE.Vector2(a, b)) };
    }));
    uniforms.camDir = this.camDir;
    uniforms.headOnly = { value: headOnly ? 1 : 0 };
    uniforms.faceFromViews = { value: info.face === 'views' ? 1 : 0 };
    uniforms.uvGain = { value: new THREE.Vector3(1, 1, 1) };
    const map = (skinned.material as THREE.MeshStandardMaterial).map;
    if (headOnly && map?.image && painted[3]) {
      const uv = meanColour(map.image as CanvasImageSource);
      if (uv) (uniforms.uvGain.value as THREE.Vector3).set(...[0, 1, 2].map((ch) => Math.min(2.5, Math.max(0.8, painted[ch] / painted[3] / uv[ch]))) as [number, number, number]);
    }
    const decl = VIEWS.map(([k]) => `uniform sampler2D p_${k}; uniform vec4 f_${k}; uniform vec2 b_${k}[${BANDS}]; uniform vec3 bg_${k};`).join('\n');
    // Which painted view a surface wears: the one nearest the camera, wherever that view sees the surface at
    // all (it faces the view, nothing nearer covers it, the painting shows figure there, not background); the
    // others only fill what it cannot see. Views are fitted by silhouette and never line up exactly, so two
    // views on one head show its face twice (the profile's eye beside the front's); one view at a time does not.
    // Under the arm in a profile the sweater is covered, so the arm's paint stays on the arm. The front is the
    // painting the hero was cast from, so it keeps the figure until the camera is well round the side.
    const sample = VIEWS.map(([k, ax, sx, nax, ns], i) => `
  ab = mix(b_${k}[band], b_${k}[band2], bandT);
  c[${i}] = texture2D(p_${k}, vec2(ab.x * ${sx.toFixed(1)} * vRest.${ax} + ab.y, 1. - (f_${k}.z * vRest.y + f_${k}.w))).rgb;
  facing[${i}] = ${ns.toFixed(1)} * rn.${nax};
  paint[${i}] = notBg(c[${i}], bg_${k});
  score[${i}] = ${TRUST[k].toFixed(2)} + camDir.${nax} * ${ns.toFixed(1)} - 2. * (1. - smoothstep(mix(0.05, -0.45, head), mix(0.25, -0.2, head), facing[${i}])) - 2. * (1. - head) * (1. - vVis[${i}]) - 2. * (1. - paint[${i}]);`).join('');
    const m = skinned.material as THREE.MeshStandardMaterial;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = 'attribute vec3 restPos; attribute vec3 restNrm; attribute vec4 restVis; varying vec3 vRest; varying vec3 vRestN; varying vec4 vVis;\n'
        + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vRest = restPos; vRestN = restNrm; vVis = restVis;');
      sh.fragmentShader = `${decl}
uniform vec3 camDir; uniform float headOnly; uniform float faceFromViews; uniform vec3 uvGain; varying vec3 vRest; varying vec3 vRestN; varying vec4 vVis;
// Two views blend only in a narrow band where they claim a surface about equally.
#define SHARP 28.
float notBg(vec3 c, vec3 bg) { return smoothstep(0.14, 0.32, abs(c.r - bg.r) + abs(c.g - bg.g) + abs(c.b - bg.b)); }
` + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  vec3 rn = normalize(vRestN); vec3 c[4]; float facing[4]; float score[4]; float paint[4]; vec2 ab;
  // Between the centres of the two nearest slices of the height.
  float bandAt = clamp(vRest.y * ${BANDS}. - 0.5, 0., ${BANDS - 1}.);
  int band = int(floor(bandAt)); int band2 = min(band + 1, ${BANDS - 1}); float bandT = bandAt - floor(bandAt);
  // On the head, the view nearest the camera paints round to the far side of the cheek, even at a glancing
  // angle: a profile's eye and nose land on the TRELLIS cheek beside the front's face (two faces), so no other
  // view fills there. A slightly stretched cheek reads as a cheek; a second face never does.
  float head = smoothstep(${HEAD_FROM.toFixed(3)}, ${(HEAD_FROM + 0.03).toFixed(3)}, vRest.y);${sample}
  float best = max(max(score[0], score[1]), max(score[2], score[3]));
  vec3 acc = vec3(0.); float wsum = 0.;
  for (int i = 0; i < 4; i++) { float w = exp(SHARP * (score[i] - best)) * step(0.001, facing[i]); acc += c[i] * w; wsum += w; }
  // No view claims it (the crown of the head faces up, at no view): every view that shows figure there, by how
  // much it faces it.
  if (best <= -1.) { acc = vec3(0.); wsum = 0.;
    for (int i = 0; i < 4; i++) { float w = pow(max(0., facing[i]), 4.) * paint[i] + 1e-6 * paint[i]; acc += c[i] * w; wsum += w; } }
  // Over the UV texture only the front painting goes on the face, and only where the face looks forward:
  // two views meeting on a head leave a second eye at the seam, the UV texture round the side never does.
  if (headOnly > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb * uvGain, c[0], faceFromViews * head * paint[0] * smoothstep(0.4, 0.7, facing[0]));
  else if (wsum > 0.) diffuseColor.rgb = acc / wsum;`);
    };
    m.needsUpdate = true;
  }

  // A long coat is skinned to the thighs and tears between the legs: weight on a leg bone for a vertex
  // further than `radius` (figure heights) from that leg's bones moves to the hips. Only correct above
  // the knee: a wide boot shaft also extends beyond that radius, but must stay attached to its leg.
  private fixCoat(skinned: THREE.SkinnedMesh, radius: number) {
    const sk = skinned.skeleton;
    const idx = skinned.geometry.attributes.skinIndex;
    const wt = skinned.geometry.attributes.skinWeight;
    const pos = skinned.geometry.attributes.position;
    const hips = sk.bones.indexOf(this.bones.Hips);
    const at = (k: string) => this.bones[k].getWorldPosition(new THREE.Vector3());
    const toe = (s: string) => (this.bones[`${s}ToeBase`] ? at(`${s}ToeBase`) : at(`${s}Foot`));
    const segs = { Left: [at('LeftUpLeg'), at('LeftLeg'), at('LeftFoot'), toe('Left')], Right: [at('RightUpLeg'), at('RightLeg'), at('RightFoot'), toe('Right')] };
    const v = new THREE.Vector3();
    const c = new THREE.Vector3();
    const line = new THREE.Line3();
    for (let i = 0; i < pos.count; i++) {
      skinned.getVertexPosition(i, v).applyMatrix4(skinned.matrixWorld);
      for (let j = 0; j < 4; j++) {
        const w = wt.getComponent(i, j);
        const name = sk.bones[idx.getComponent(i, j)]?.name.replace(/^mixamorig:?/, '') ?? '';
        const side = name.startsWith('Left') ? 'Left' : name.startsWith('Right') ? 'Right' : null;
        if (!w || !side || !/UpLeg$|Leg$/.test(name)) continue;
        const [a, b, f, t] = segs[side];
        if (v.y <= b.y + 1e-6) continue;
        let d = Infinity;
        for (const [p, q] of [[a, b], [b, f], [f, t]]) d = Math.min(d, line.set(p, q).closestPointToPoint(v, true, c).distanceTo(v));
        const k = Math.max(0, Math.min(1, (d - radius) / radius));
        if (!k) continue;
        wt.setComponent(i, j, w * (1 - k));
        let slot = -1;
        for (let s = 0; s < 4; s++) if (idx.getComponent(i, s) === hips) slot = s;
        if (slot < 0) for (let s = 0; s < 4; s++) if (slot < 0 || wt.getComponent(i, s) < wt.getComponent(i, slot)) slot = s;
        if (idx.getComponent(i, slot) !== hips) { idx.setComponent(i, slot, hips); wt.setComponent(i, slot, 0); }
        wt.setComponent(i, slot, wt.getComponent(i, slot) + w * k);
      }
    }
    idx.needsUpdate = true;
    wt.needsUpdate = true;
  }

  /** Rotates a bone by R about world axes, measured from its rest pose. */
  private turnBone(name: string, R: THREE.Quaternion) {
    const b = this.bones[name];
    const r = this.rest[name];
    if (!b || !r) return;
    b.quaternion.copy(r.parentWorld.clone().invert().multiply(R).multiply(r.parentWorld).multiply(r.q));
  }

  /** The walk at `phase` (cycles; the left foot strikes at 0), feet planted like src/play/rig.ts. */
  private pose(phase: number, walking: boolean, armSwing: number, gesture?: number) {
    const step = CYCLE * STANCE;
    const L = this.legs.Left;
    const reach = (L.thigh + L.shin) * 0.985;
    let hipH = L.hipY - L.ankleY;
    const feet = {
      Left: walking ? footAt(phase, step) : { dx: 0.02, lift: 0, stance: true, u: 0 },
      Right: walking ? footAt(phase + 0.5, step) : { dx: -0.02, lift: 0, stance: true, u: 0 },
    };
    for (const f of Object.values(feet)) hipH = Math.min(hipH, Math.sqrt(Math.max(0, reach * reach - f.dx * f.dx)) + f.lift * LIFT);
    for (const side of ['Left', 'Right'] as const) {
      const f = feet[side];
      const { thigh, shin } = this.legs[side];
      const [tx, ty] = [f.dx, -hipH + f.lift * LIFT];
      const r = Math.min(Math.hypot(tx, ty), (thigh + shin) * 0.999);
      const knee = Math.PI - Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + shin * shin - r * r) / (2 * thigh * shin))));
      const hipFlex = Math.atan2(tx, -ty) + Math.acos(Math.max(-1, Math.min(1, (thigh * thigh + r * r - shin * shin) / (2 * thigh * r))));
      let foot = -(hipFlex - knee);
      if (!f.stance) foot += swingFootPitch(f.u);
      this.turnBone(`${side}UpLeg`, turn(X, -hipFlex));
      this.turnBone(`${side}Leg`, turn(X, knee));
      this.turnBone(`${side}Foot`, turn(X, -foot));
    }
    const ph = phase * Math.PI * 2;
    const hips = this.bones.Hips;
    hips.position.copy(this.hipsRest);
    hips.position.y -= (L.hipY - L.ankleY - hipH) / hips.parent!.getWorldScale(new THREE.Vector3()).y;
    const twist = walking ? 0.12 * Math.cos(ph) : 0;
    this.turnBone('Hips', turn(Y, twist).multiply(turn(Z, walking ? 0.03 * Math.cos(ph) : 0)));
    this.turnBone('Spine', turn(Y, -twist * 0.6));
    this.turnBone('Spine1', turn(X, walking ? 0.05 : 0));
    this.turnBone('Spine2', turn(Y, -twist * 0.6));
    for (const side of ['Left', 'Right'] as const) {
      const sign = side === 'Left' ? 1 : -1;
      const a = walking ? armSwing * Math.cos(ph + (side === 'Left' ? Math.PI : 0)) : 0;
      // A relaxed rest pose (Blender) hangs the arms close to the body; otherwise wider, or sleeves sink into the coat.
      const out = this.relaxed ? 0.09 : 0.22;
      const down = new THREE.Vector3(sign * Math.sin(out), -Math.cos(out), 0);
      this.turnBone(`${side}Arm`, turn(X, -a).multiply(new THREE.Quaternion().setFromUnitVectors(this.arms[side], down)));
      this.turnBone(`${side}ForeArm`, turn(X, -(0.25 + Math.max(0, a) * 0.6)));
    }
    this.turnBone('Neck', new THREE.Quaternion());
    this.turnBone('Head', new THREE.Quaternion());
    const g: GesturePose | undefined = gesture === undefined ? undefined : GESTURES[gesture % GESTURES.length].pose;
    if (!g) return;
    for (const side of ['Left', 'Right'] as const) {
      const arm = side === 'Left' ? g.left : g.right;
      if (!arm) continue;
      const dir = new THREE.Vector3(arm[0], arm[1], arm[2]).normalize();
      this.turnBone(`${side}Arm`, new THREE.Quaternion().setFromUnitVectors(this.arms[side], dir));
      this.turnBone(`${side}ForeArm`, turn(X, -arm[3]));
    }
    this.turnBone('Spine1', turn(X, g.lean ?? 0));
    this.turnBone('Head', turn(X, g.nod ?? 0).multiply(turn(Z, g.tilt ?? 0)));
  }

  /**
   * One frame, `px` pixels tall. yaw: 0 faces the viewer, PI/2 faces screen right. elevation: how far
   * the camera looks down (radians). Returns the canvas, feet at (width / 2, height * feetAt).
   */
  draw({ phase = 0, walking = false, yaw = 0, elevation = 0.18, px = 300, light, armSwing, gesture, time = performance.now() / 1000, talk, face, frame }: {
    phase?: number; walking?: boolean; yaw?: number; elevation?: number; px?: number; light?: FigureLight; armSwing?: number; frame?: number;
    /** A talking pose (index into src/play/gestures.ts GESTURES), standing. A creature only bounces on its words. */
    gesture?: number;
    /** Seconds, and whether it speaks or listens: a creature breathes, blinks and bounces with them. */
    time?: number; talk?: 'speak' | 'listen'; face?: FaceState;
  }): HTMLCanvasElement {
    const key=frame===undefined?'':JSON.stringify([phase,walking,yaw,elevation,px,light,armSwing,gesture,time,talk,face&&[face.mouth,face.previous,face.mix.toFixed(2),face.blink.toFixed(2),face.brow.toFixed(2),face.jaw.toFixed(2),face.round.toFixed(2)]]);
    if(frame!==undefined&&this.lastFrame?.frame===frame&&this.lastFrame.key===key)return this.canvas;
    // Feet at 0: how much of the frame is above and below them, and how wide it is either side, in heights.
    let [top, bottom, half] = [1.06, -0.06, 0.45];
    if (this.creature) {
      const m = creatureMotion({ phase, walking: walking && gesture === undefined, time, talk: gesture !== undefined ? 'speak' : talk, seed: this.seed });
      this.holder.rotation.order = 'YXZ';
      this.holder.rotation.x = m.lean;
      this.holder.position.y = m.lift;
      this.holder.scale.set(1 / Math.sqrt(m.stretch), m.stretch, 1 / Math.sqrt(m.stretch));
      // Room for the highest hop and a stretched take-off, and for a long body turned side on.
      [top, bottom, half] = [1.55, -0.06, this.reach];
    } else this.pose(phase, walking && gesture === undefined, armSwing ?? (this.relaxed ? 0.32 : 0.12), gesture);
    if (face) { this.facial?.apply(face); this.paintFace(face); }
    this.holder.rotation.y = yaw;
    this.camDir.value.set(-Math.sin(yaw), 0, Math.cos(yaw));
    this.holder.updateMatrixWorld(true);
    const [w, h] = [Math.ceil(px * 2 * half), Math.ceil(px * (top - bottom))];
    const gl = this.renderer.getContext();
    const limit = Math.min(this.renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
    if (gl.isContextLost() || !Number.isFinite(w) || !Number.isFinite(h) || w < 1 || h < 1 || w > limit || h > limit || w * h > 16_777_216) {
      throw new Error(`3D figure frame ${w}x${h} cannot be rendered safely (device limit ${limit})`);
    }
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.rt.setSize(w, h);
      (this.post.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h);
    }
    this.feetAt = top / (top - bottom);
    const cam = this.camera;
    Object.assign(cam, { left: -half, right: half, top: top * Math.cos(elevation), bottom });
    cam.position.set(0, Math.sin(elevation) * 5, Math.cos(elevation) * 5);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    const L = light ?? PAINTED_LIGHT;
    this.hemi.color.set(L.sky);
    this.hemi.groundColor.set(L.ground);
    this.hemi.intensity = L.ambient;
    for (const [lamp, spec] of [[this.key, L.key], [this.rim, L.rim]] as const) {
      lamp.intensity = spec?.intensity ?? 0;
      if (spec) { lamp.color.set(spec.color); lamp.position.set(...spec.dir); }
    }
    this.renderer.setRenderTarget(this.rt);
    this.renderer.clear();
    this.renderer.render(this.scene, cam);
    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.postScene, this.postCam);
    if(frame!==undefined)this.lastFrame={frame,key};
    return this.canvas;
  }
}
