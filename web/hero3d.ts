// A rigged 3D figure (cast/<key>/model/) drawn into its own canvas, so the 2D page draws it like a
// sprite: feet planted on the walk cycle the 2D rig uses, any facing, Muse's four painted views on its
// surface, lit by the painting around it. The page only imports this when a world ships a model.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { CYCLE } from '../src/play/rig.ts';

const STANCE = 0.6;

/**
 * Talking poses, standing: where each upper arm points (world, the figure facing +z, its left at +x),
 * how far the elbow bends, and the head's nod and tilt. Played in any order while a line is spoken.
 * Elbows stay near the body: a long coat is skinned to the upper arms and flares into a cape otherwise.
 */
type Gesture = { left?: [number, number, number, number]; right?: [number, number, number, number]; nod?: number; tilt?: number; lean?: number };
export const GESTURES: Gesture[] = [
  {}, // hands down, listening
  { right: [-0.2, -0.9, 0.35, 1.7] }, // right hand up, palm open
  { left: [0.25, -0.92, 0.3, 1.3], right: [-0.25, -0.92, 0.3, 1.3] }, // both hands forward, explaining
  { right: [-0.1, -0.75, 0.65, 0.9], lean: 0.04 }, // pointing ahead
  { left: [0.2, -0.95, 0.15, 1.4], right: [-0.2, -0.95, 0.15, 1.4], tilt: 0.15 }, // shrug, forearms out
  { left: [0.1, -0.95, 0.3, 2.1], nod: 0.1 }, // hand on the chest
  { right: [-0.2, -0.92, 0.3, 1.2], nod: 0.25 }, // nodding
  { left: [0.08, -0.92, 0.38, 1.5], right: [-0.08, -0.92, 0.38, 1.5] }, // hands together
];
const LIFT = 0.06;
const smooth = (u: number) => u * u * (3 - 2 * u);

/** model.json, written by `diorama model`. */
export type ModelInfo = {
  glb: string;
  views: Record<'front' | 'back' | 'left' | 'right', { image: string; u: [number, number]; v: [number, number]; iou: number }>;
};

/** How the painting lights the figure where it stands (colours as 0xRRGGBB). */
export type FigureLight = {
  sky: number; ground: number; ambient: number;
  key?: { dir: [number, number, number]; color: number; intensity: number };
  rim?: { dir: [number, number, number]; color: number; intensity: number };
};

function footAt(p: number, step: number) {
  p = ((p % 1) + 1) % 1;
  if (p < STANCE) return { dx: step / 2 - (step * p) / STANCE, lift: 0, stance: true, u: p / STANCE };
  const u = (p - STANCE) / (1 - STANCE);
  return { dx: -step / 2 + step * smooth(u), lift: Math.sin(Math.PI * u), stance: false, u };
}

const X = new THREE.Vector3(1, 0, 0);
const Y = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);
const turn = (axis: THREE.Vector3, a: number) => new THREE.Quaternion().setFromAxisAngle(axis, a);

// Which way each painted view looks at the figure (it faces +z): model axis across the picture, its
// sign, and the normal axis and sign of the surfaces that view sees. Matches src/model/fit.ts.
const VIEWS = [['front', 'x', 1, 'z', 1], ['back', 'x', -1, 'z', -1], ['left', 'z', -1, 'x', 1], ['right', 'z', 1, 'x', -1]] as const;

// Kuwahara: flattens 3D shading into paint-like patches.
const KUWAHARA = `
uniform sampler2D tex; uniform vec2 texel; uniform int radius; varying vec2 vUv;
void main() {
  vec4 c0 = texture2D(tex, vUv);
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

type Leg = { thigh: number; shin: number; hipY: number; ankleY: number };

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
  private rest: Record<string, { q: THREE.Quaternion; parentWorld: THREE.Quaternion }> = {};
  private legs!: Record<'Left' | 'Right', Leg>;
  private arms!: Record<'Left' | 'Right', THREE.Vector3>;
  private hipsRest!: THREE.Vector3;

  static async load(info: ModelInfo, url: (file: string) => string, paint = 1): Promise<Figure3D> {
    const f = new Figure3D(paint);
    await f.build(info, url);
    return f;
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
    root.traverse((o) => {
      if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = o as THREE.SkinnedMesh;
      if ((o as THREE.Mesh).isMesh) {
        const mesh = o as THREE.Mesh;
        mesh.frustumCulled = false;
        const map = (mesh.material as THREE.MeshStandardMaterial).map;
        if (map) map.colorSpace = THREE.SRGBColorSpace;
        mesh.geometry.computeVertexNormals();
        mesh.material = new THREE.MeshStandardMaterial({ map, metalness: 0, roughness: 1 });
      }
    });
    if (!skinned) throw new Error(`${info.glb}: no skinned mesh`);
    for (const b of skinned.skeleton.bones) this.bones[b.name.replace(/^mixamorig:?/, '')] = b;
    // Feet at 0, height 1, centred: measured on the mesh as posed now.
    this.holder.add(root);
    this.holder.updateMatrixWorld(true);
    skinned.skeleton.update();
    const box = new THREE.Box3();
    const v = new THREE.Vector3();
    const pos = skinned.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) box.expandByPoint(skinned.getVertexPosition(i, v).applyMatrix4(skinned.matrixWorld));
    const h = box.max.y - box.min.y;
    const inner = new THREE.Group();
    this.holder.add(inner);
    inner.add(root);
    inner.scale.setScalar(1 / h);
    inner.position.set(-(box.min.x + box.max.x) / 2 / h, -box.min.y / h, -(box.min.z + box.max.z) / 2 / h);
    this.holder.updateMatrixWorld(true);
    await this.paintViews(skinned, info, url);
    for (const [k, b] of Object.entries(this.bones)) this.rest[k] = { q: b.quaternion.clone(), parentWorld: b.parent!.getWorldQuaternion(new THREE.Quaternion()) };
    const at = (k: string) => this.bones[k].getWorldPosition(new THREE.Vector3());
    const leg = (s: string): Leg => {
      const [hip, knee, ankle] = [at(`${s}UpLeg`), at(`${s}Leg`), at(`${s}Foot`)];
      return { thigh: hip.distanceTo(knee), shin: knee.distanceTo(ankle), hipY: hip.y, ankleY: ankle.y };
    };
    this.legs = { Left: leg('Left'), Right: leg('Right') };
    this.arms = { Left: at('LeftForeArm').sub(at('LeftArm')).normalize(), Right: at('RightForeArm').sub(at('RightArm')).normalize() };
    this.fixCoat(skinned, 0.035);
    this.hipsRest = this.bones.Hips.position.clone();
  }

  /** Muse's views, projected in the bind pose, so the paint rides on the surface while it moves. */
  private async paintViews(skinned: THREE.SkinnedMesh, info: ModelInfo, url: (file: string) => string) {
    const g = skinned.geometry;
    const pos = g.attributes.position;
    const nrm = g.attributes.normal;
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
    const uniforms: Record<string, THREE.IUniform> = {};
    let bg = [0.87, 0.87, 0.87];
    await Promise.all(VIEWS.map(async ([name]) => {
      const img = new Image();
      img.src = url(info.views[name].image);
      await img.decode();
      if (name === 'front') {
        const c = Object.assign(document.createElement('canvas'), { width: 4, height: 4 }).getContext('2d')!;
        c.drawImage(img, 0, 0, 4, 4, 0, 0, 4, 4);
        bg = [...c.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((x) => (x / 255) ** 2.2);
      }
      const tex = new THREE.Texture(img);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      const f = info.views[name];
      uniforms[`p_${name}`] = { value: tex };
      uniforms[`f_${name}`] = { value: new THREE.Vector4(f.u[0], f.u[1], f.v[0], f.v[1]) };
    }));
    uniforms.pBg = { value: new THREE.Vector3(...bg) };
    const decl = VIEWS.map(([k]) => `uniform sampler2D p_${k}; uniform vec4 f_${k};`).join('\n');
    const body = VIEWS.map(([k, ax, sx, nax, ns]) => `
  { vec2 uv = vec2(f_${k}.x * ${sx.toFixed(1)} * vRest.${ax} + f_${k}.y, 1. - (f_${k}.z * vRest.y + f_${k}.w));
    vec4 c = texture2D(p_${k}, uv);
    float w = pow(max(0., ${ns.toFixed(1)} * rn.${nax}), 4.) * notBg(c.rgb);
    acc += c.rgb * w; wsum += w; }`).join('');
    const m = skinned.material as THREE.MeshStandardMaterial;
    m.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, uniforms);
      sh.vertexShader = 'attribute vec3 restPos; attribute vec3 restNrm; varying vec3 vRest; varying vec3 vRestN;\n'
        + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n vRest = restPos; vRestN = restNrm;');
      sh.fragmentShader = `${decl}
uniform vec3 pBg; varying vec3 vRest; varying vec3 vRestN;
float notBg(vec3 c) { return smoothstep(0.14, 0.32, abs(c.r - pBg.r) + abs(c.g - pBg.g) + abs(c.b - pBg.b)); }
` + sh.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
  vec3 rn = normalize(vRestN); vec3 acc = vec3(0.); float wsum = 0.;${body}
  if (wsum > 0.001) diffuseColor.rgb = mix(diffuseColor.rgb, acc / wsum, smoothstep(0.05, 0.4, wsum));`);
    };
    m.needsUpdate = true;
  }

  // A long coat is skinned to the thighs and tears between the legs: weight on a leg bone for a vertex
  // further than `radius` (figure heights) from that leg's bones moves to the hips. The boot stays on
  // the leg: the foot segment counts, and nothing below the ankle moves.
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
        if (v.y < f.y) continue;
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
      if (!f.stance) foot += 0.35 * Math.sin(Math.PI * f.u) - (f.u < 0.3 ? 0.25 * (1 - f.u) : 0);
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
      const down = new THREE.Vector3(sign * Math.sin(0.22), -Math.cos(0.22), 0);
      this.turnBone(`${side}Arm`, turn(X, -a).multiply(new THREE.Quaternion().setFromUnitVectors(this.arms[side], down)));
      this.turnBone(`${side}ForeArm`, turn(X, -(0.25 + Math.max(0, a) * 0.6)));
    }
    this.turnBone('Neck', new THREE.Quaternion());
    this.turnBone('Head', new THREE.Quaternion());
    const g = gesture === undefined ? undefined : GESTURES[gesture % GESTURES.length];
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
  draw({ phase = 0, walking = false, yaw = 0, elevation = 0.18, px = 300, light, armSwing = 0.12, gesture }: {
    phase?: number; walking?: boolean; yaw?: number; elevation?: number; px?: number; light?: FigureLight; armSwing?: number;
    /** A talking pose (index into GESTURES), standing. */
    gesture?: number;
  }): HTMLCanvasElement {
    this.pose(phase, walking && gesture === undefined, armSwing, gesture);
    this.holder.rotation.y = yaw;
    this.holder.updateMatrixWorld(true);
    const [w, h] = [Math.ceil(px * 0.9), Math.ceil(px * 1.12)];
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.renderer.setSize(w, h, false);
      this.rt.setSize(w, h);
      (this.post.uniforms.texel.value as THREE.Vector2).set(1 / w, 1 / h);
    }
    this.feetAt = 1 - 0.06 / 1.12;
    const cam = this.camera;
    Object.assign(cam, { left: -0.45, right: 0.45, top: 1.06 * Math.cos(elevation), bottom: -0.06 });
    cam.position.set(0, Math.sin(elevation) * 5, Math.cos(elevation) * 5);
    cam.lookAt(0, 0, 0);
    cam.updateProjectionMatrix();
    const L = light ?? { sky: 0xffffff, ground: 0x888888, ambient: 2.2 };
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
    return this.canvas;
  }
}
