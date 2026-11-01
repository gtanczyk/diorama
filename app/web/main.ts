// The browser runtime: a painted place, a hero who walks on its grid, hides behind things and uses them.
import { hashSeed } from '../src/play/weather.ts';
import { FLAME_GLOW, FLAME_SWAY_M, flameAt, depthStretch, flicker, floorYAt, hiddenRuns, lightFor, onStep, personPx, stepAt, stepFootY, stepRestY, treadY, type GeoThing, type Geometry, type Occluder } from '../src/play/geometry.ts';
import { backdropTransforms, backEdge, cardY, flatDisparities, shiftAtDisparity, type Layers, floorPoint, overscan, PARALLAX_PX, pivot, shiftAt, STACK_GAP, stackCards, type Camera, type Parallax } from '../src/play/parallax.ts';
import { WalkGrid, type Point } from '../src/play/path.ts';
import { behindWeight, FOCUS_BLUR, focusMask, planeDepth, RIM_ALPHA, RIM_COLOUR, RIM_WIDTH, SEPARATE_ALPHA, SEPARATE_BLUR, SEPARATE_SHIFT } from '../src/play/focus.ts';
import { catchers, decodeDepth, DEPTH_SCALE, shadowAt, sunFor, thingShadows, type Depth } from '../src/play/shadow.ts';
import { CYCLE, pose, sheetCell, type PartName, type Rig } from '../src/play/rig.ts';
import { actions, activeChanges, apply, hiddenThings, holds, pickDialogue, pickInteraction, speakerOf, startState, type Action, type State } from '../src/story/engine.ts';
import type { Story } from '../src/story/schema.ts';
import type { Place as PlaceSpec, World } from '../src/world/schema.ts';
import { Mixer, type Listened } from './audio.ts';
import { PLAYER_COLOURS, readEachPad, readPads, Turns, type PadButton, type PadFrame } from './pad.ts';
import { Answers, Bag, displayName, fitHud, showEnding, type ItemLook } from './ui.ts';
import { useLanguage, words } from './words.ts';
import { spokenLine, type SoundData } from '../src/play/sound.ts';
import type { Figure3D, ModelInfo } from './hero3d.ts';
import type { Weather } from '../src/play/weather.ts';
import { WeatherFx } from './weather.ts';
import type { Reactions } from '../src/play/reactions.ts';
import { ReactionFx } from './reactions.ts';
import { GlowFx } from './glows.ts';
import type { Glow } from '../src/play/glow.ts';
import { creatureMotion } from '../src/play/creature.ts';
import { PaintedFace } from './face.ts';
import { mouthAt, offsetFace, faceAt, type FaceDefinition } from '../src/play/lipsync.ts';

type Data = {
  slug: string;
  world: World;
  places: Record<string, { geometry: Geometry | null; painting: string | null; backdrop?: string; layers?: Layers; weather?: Weather; reactions?: Reactions; glows?: Glow[]; issue?: string }>;
  /** Figure per hero or NPC key: a cut-out image, and its rig when `diorama cast` could cut it into parts. */
  cast: Record<string, { image: string; height?: number; upright?: boolean; face?: { dir: string; info: FaceDefinition }; rig?: Rig; parts?: string; model?: { dir: string; info: ModelInfo }; sprites?: { dir: string; info: SpriteInfo } }>;
  story: Story | null;
  /** Index into story.changes → the painting as it looks once that change holds. */
  changes?: Record<string, string>;
  /** Music, ambience, loops, footsteps and one-shots (diorama sound); without it the page is silent. */
  sound?: SoundData;
  /** An icon per story item (diorama icons); an item without one shows its name. */
  items?: Record<string, { icon: string }>;
  /** Heroes for more gamepads (cast keys, drawings marked player): player 2 plays the first. */
  players?: string[];
};

type Bits = { bits: Uint8Array; area: number };
type Who = { npc?: Hot; body?: Body; y: number };
type Hot = { thing: GeoThing; spec?: PlaceSpec['things'][number]; mask?: Bits; area: number; plate?: HTMLImageElement; outline?: HTMLCanvasElement; npc?: Npc };
type Rect = [number, number, number, number];
/** sprites.json, written by `diorama sprites`: one walk cycle per facing, a cols x rows grid of frames per sheet. */
export type SpriteInfo = {
  cols: number; rows: number; frames: number; width: number; height: number;
  /** Feet at (cell width / 2, cell height * feetAt); the figure is about `px` tall. */
  feetAt: number; px: number;
  /** Walk facings the story's routes use (also patrols and travelling NPCs). */
  facings: Record<string, { sheet: string; yaw: number; iou?: number[]; stand?: number; off?: number[] }>;
  /** Talking sheets, same grid, usually one: cell i shows gestures[i] (cell 0 listens). */
  talk?: Record<string, { sheet: string; yaw: number; gestures?: string[] }>;
  /** The gesture the story gives each line this character says; a line not listed is said listening. */
  lines?: Record<string, string>;
};
/** walk: the cells a walk steps through, without the ones the sprites step found off the gait (a crouch, a sit). */
type Sheet = { file: string; yaw: number; stand: number; img: HTMLImageElement; gestures: string[]; walk: number[] };
/** height: metres standing (a grown-up 1.62, a cat 0.3), so each is drawn at its own size; upright false: an animal, drawn as painted. */
type Figure = { img: HTMLImageElement; face?: PaintedFace; faceInfo?: FaceDefinition; height?: number; upright?: boolean; rig?: { rig: Rig; parts: Map<PartName, HTMLImageElement>; sheet?: HTMLImageElement; canvas: HTMLCanvasElement }; model?: Figure3D; sprites?: { info: SpriteInfo; sheets: Sheet[]; talk: Sheet[] } };
/** y: the floor row the cut stands on, which sets how far it slides with parallax. */
/** Things that float and ride the swell, by their names. */
const FLOATS = /\b(boat|rowboat|dinghy|skiff|canoe|kayak|raft|ship|barge|punt|gondola|sampan|junk|ferry|trawler|yacht|sailboat)s?\b/i;

type Cut = { occ: Occluder; canvas: HTMLCanvasElement; x0: number; y0: number; y: number };

type Place = {
  key: string;
  spec: PlaceSpec;
  g: Geometry;
  grid: WalkGrid;
  bg?: HTMLImageElement;
  /** The painting without its cards (backdrop.png): with it the place is drawn as a parallax diorama. */
  backdrop?: HTMLImageElement;
  /** The depth that stays put while the camera sways. */
  pivot: number;
  /** Per walk-grid column, the floor's back edge: what stands above it slides with it (see backEdge). */
  edge: Float32Array;
  /** The far view as flats: the sky drawn still, then each flat (farthest first) at its own disparity. */
  /** Water set flowing: a texture over box (reaching past the banks), its soft mask, a canvas to compose in. */
  water?: { tex: HTMLImageElement; mask: HTMLImageElement; box: [number, number, number, number]; flow: [number, number]; canvas: HTMLCanvasElement };
  /** Painted fog set drifting: its veil over box (reaching past its edges), where it may show, which way (-1, 1; 0 with the wind) and how fast. */
  mist?: { tex: HTMLImageElement; mask: HTMLImageElement; box: [number, number, number, number]; drift: number; speed: number; canvas: HTMLCanvasElement };
  /** Painted smoke curling: each plume's feathered copy of the painting and where it sits. */
  smoke?: Array<{ img: HTMLImageElement; box: [number, number, number, number] }>;
  /** Painted boats rocking on the water. */
  floats?: Array<{ img: HTMLImageElement; box: [number, number, number, number] }>;
  far?: { sky?: HTMLImageElement; flats: Array<{ img: HTMLImageElement; box: [number, number, number, number]; d: number }> };
  hots: Hot[];
  cuts: Cut[];
  byKey: Map<string, Occluder>;
  /** Mean luma of the painting per LIGHT_CELL square, to light people like the place around them. */
  light?: { cols: number; rows: number; luma: Float32Array };
  /** Painted shadows on the floors (geometry.shadows): a person standing in one is darkened. */
  shade?: Bits;
  /** How far every pixel is (geometry.depth): cast shadows follow the ground's shape with it. */
  depth?: Depth;
  /** How far every pixel is for focus and separation: the depth map, or the floor plane with the cards stood on it. */
  focus?: Depth;
  /** The water's soft mask over the frame, 0..255: a shadow barely shows on water. */
  wet?: Uint8Array;
  /** The fire or lamp's work here (see Game.fireOf), made on first use. */
  fire?: Fire;
  /** Where a person's shadow can land (see Game.catchesOf): the things not carried off when made, and the floors. */
  catches?: { gone: string; on: Uint8Array };
  /** Rain or snow, rings, splashes and drips (weather.json). */
  weather?: WeatherFx;
  reactions?: ReactionFx;
  /** The painted lights breathing, flickering, twinkling or turning a beam (layout.lights). */
  glows?: GlowFx;
};

/**
 * What a fire or a lamp on the floor (light.at) does to the place: the shadows the painted things cast from
 * it, worked out once for the flame swayed left, centred and right (one for a steady lamp) and mixed each
 * frame as it sways; and for a flame, its bright pixels to set dancing.
 */
type Fire = {
  /** The things carried off when the shadows were worked out: they cast none. */
  gone: string;
  shadows: Array<ReturnType<typeof thingShadows>>;
  /** This frame's mix of them, its pixels and the canvas they go up on. */
  mix: Float32Array;
  img: ImageData;
  canvas: HTMLCanvasElement;
  /** A person's height in px at the fire. */
  px: number;
  flame?: { canvas: HTMLCanvasElement; x0: number; y0: number };
};

const LIGHT_CELL = 40;
/** A whole line wrapped in one pair of quotes, without them. */
const unquoted = (text: string) => {
  const m = text.trim().match(/^(['"\u2018\u201c])([\s\S]+)(['"\u2019\u201d])$/);
  return m && !m[2].includes(m[1] === "'" || m[1] === '\u2018' ? "' " : '"') ? m[2].trim() : text;
};
const fract = (v: number) => v - Math.floor(v);

function lightMap(bg: HTMLImageElement, w: number, h: number): Place['light'] {
  const cols = Math.ceil(w / LIGHT_CELL);
  const rows = Math.ceil(h / LIGHT_CELL);
  const c = Object.assign(document.createElement('canvas'), { width: cols, height: rows });
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(bg, 0, 0, cols, rows);
  const px = cx.getImageData(0, 0, cols, rows).data;
  const luma = new Float32Array(cols * rows);
  for (let i = 0; i < luma.length; i++) luma[i] = 0.2126 * px[i * 4] + 0.7152 * px[i * 4 + 1] + 0.0722 * px[i * 4 + 2];
  return { cols, rows, luma };
}

/** The cards' pixels at the depth map's size: what stands there (thingShadows' casters, a shadow's catchers). */
function ownerMap(depth: Depth, cuts: Cut[]): Uint8Array {
  const S = DEPTH_SCALE;
  const owner = new Uint8Array(depth.w * depth.h);
  for (const c of cuts) {
    const a = c.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, c.canvas.width, c.canvas.height).data;
    for (let r = Math.max(0, Math.floor(c.y0 / S)); r < Math.min(depth.h, (c.y0 + c.canvas.height) / S); r++) {
      for (let k = Math.max(0, Math.floor(c.x0 / S)); k < Math.min(depth.w, (c.x0 + c.canvas.width) / S); k++) {
        const [u, v] = [k * S + 1 - c.x0, r * S + 1 - c.y0];
        if (u >= 0 && v >= 0 && u < c.canvas.width && v < c.canvas.height && a[(v * c.canvas.width + u) * 4 + 3] > 127) owner[r * depth.w + k] = 1;
      }
    }
  }
  return owner;
}

type Events = 'enter' | 'arrive' | 'say' | 'silent' | 'use' | 'exit' | 'ending' | 'npc-enter';
type Verb = 'look' | 'use' | 'take' | 'talk';

function lineChoice(story: Story, state: State, index: number): string {
  const talk = state.talk!;
  return story.dialogues[talk.dialogue].lines.find((l) => l.key === talk.line)?.choices[index]?.text ?? '…';
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const params = new URLSearchParams(location.search);
const capture = params.has('capture');
const nobody = params.get('people') === '0';
const hideCursor = capture || params.get('cursor') === '0';
// ?parallax=0 turns the diorama sway off, ?parallax=1.5 makes it stronger. Capture runs (QA, the bot) stay flat
// unless they ask for it, since they read frame pixels at painting coordinates. ?sway=1 adds a slow idle drift.
const parallaxScale = Number(params.get('parallax') ?? (capture ? '0' : '1')) || 0;
const sway = params.get('sway') === '1';
// ?focus=1: the camera focuses on the hero, so what stands behind them softens and pales with its distance
// (off by default: it only tells apart things far behind, and blurs the painting doing it).
const focusScale = Number(params.get('focus') ?? '0') || 0;
// ?separate=0 turns off the soft shade a person throws on what stands just behind them; ?separate=1.5 darker.
// Capture runs keep it off unless asked, since they read frame pixels.
const separateScale = Number(params.get('separate') ?? (capture ? '0' : '1')) || 0;
// ?rim=0 turns off the light edge on each person on the side the light comes from; ?rim=1.5 wider.
// Capture runs keep it off unless asked.
const rimScale = Number(params.get('rim') ?? (capture ? '0' : '1')) || 0;
// ?track=1: walking along a place, the camera is closer in and pans after the hero, so near things pass faster
// than far ones, like a side-scroller. It only drives the parallax, so a flat place stays as it was.
const track = Number(params.get('track') ?? '0') || 0;
const TRACK_ZOOM = 0.2;
/** Water drifts this many px per second at its near edge (40% of it at its far edge). */
const FLOW = 20;
/** How far the water texture reaches past the banks (WATER_PAD in src/scene/layers.ts). */
const WATER_PAD = 64;
/** Painted fog drifts this many px per second (times its speed), and its texture reaches this far past it (MIST_PAD in src/scene/layers.ts). */
const MIST_DRIFT = 14;
const MIST_PAD = 160;
/** The pointer over the canvas, 0..1 across and down; null when it is elsewhere. */
let pointer: { x: number; y: number } | null = null;
const LONG_PRESS_MS = 500;
// Relative paths, so the same page runs from `diorama play` and from an exported folder.
const files = (p: string) => `files/${p}`;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cannot load ${src}`));
    img.src = src;
  });

/** depth.png as floor rows per pixel (src/play/shadow.ts). */
async function loadDepth(src: string): Promise<Depth> {
  const img = await loadImage(src);
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const cx = c.getContext('2d', { willReadFrequently: true, colorSpace: 'srgb' })!;
  cx.drawImage(img, 0, 0);
  return decodeDepth(cx.getImageData(0, 0, img.width, img.height).data, img.width, img.height);
}

/** Depth for the camera's focus without a depth map: the floor plane, each card standing at its floor row. */
function standIn(g: Geometry, edge: Float32Array, cuts: Cut[]): Depth {
  const d = planeDepth(g.frame, g.scale.horizonY, g.cell, edge, DEPTH_SCALE);
  for (const c of cuts) {
    const { width: cw, height: ch } = c.canvas;
    if (!cw || !ch) continue;
    const a = c.canvas.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, cw, ch).data;
    const rows = Math.max(0, c.y - g.scale.horizonY);
    for (let r = Math.floor(c.y0 / DEPTH_SCALE); r < Math.min(d.h, (c.y0 + ch) / DEPTH_SCALE); r++) {
      for (let k = Math.floor(c.x0 / DEPTH_SCALE); k < Math.min(d.w, (c.x0 + cw) / DEPTH_SCALE); k++) {
        const [u, v] = [k * DEPTH_SCALE - c.x0, r * DEPTH_SCALE - c.y0];
        if (r >= 0 && k >= 0 && u >= 0 && v >= 0 && u < cw && v < ch && a[(v * cw + u) * 4 + 3] > 127) d.rows[r * d.w + k] = rows;
      }
    }
  }
  return d;
}

/** The water's soft mask (drawn over its box) as one byte per frame pixel. */
async function loadWet(src: string, box: [number, number, number, number], w: number, h: number): Promise<Uint8Array> {
  const img = await loadImage(src);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, box[0], box[1], box[2] - box[0], box[3] - box[1]);
  const px = cx.getImageData(0, 0, w, h).data;
  const out = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = (px[i * 4] * px[i * 4 + 3]) / 255;
  return out;
}

/** A mask image as one byte per frame pixel (set where the red channel is bright). */
async function loadBits(src: string, w: number, h: number): Promise<Bits> {
  const img = await loadImage(src);
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0, w, h);
  const px = cx.getImageData(0, 0, w, h).data;
  const bits = new Uint8Array(w * h);
  let area = 0;
  for (let i = 0; i < bits.length; i++) if (px[i * 4] > 127) (bits[i] = 1), area++;
  return { bits, area };
}

/** A walking person: where they are, the path ahead, and how they are drawn. */
/** run: hurrying (a double click, Shift held) until the walk ends. */
type Body = { x: number; y: number; path: Point[]; facing: number; phase: number; yaw: number; figure: Figure | undefined; foot: number | undefined; along: number | undefined; colour?: string; run?: boolean };
/** Walking and hurrying pace, in person heights a second (a brisk walk, about 1.7 m/s; a run). */
const WALK = 1.05;
const RUN = 2.1;
const newBody = (): Body => ({ x: 0, y: 0, path: [], facing: 1, phase: 0, yaw: Math.PI / 2, figure: undefined, foot: undefined, along: undefined });
type Npc = { key: string; home: string; place: string; body: Body; hot: Hot; stop: number; wait: number;
  patrol?: NonNullable<Story['patrols']>[number]; target?: Place; journey?: Place[]; leaving?: Place; arriving?: boolean; blocked?: boolean };

class Game {
  data!: Data;
  place!: Place;
  private cache = new Map<string, Place>();
  private figures = new Map<string, Figure>();
  /** Bodies keep their positions when the hero leaves a place. Off-screen patrols pause. */
  private npcs = new Map<string, Npc>();
  private meeting?: Npc;
  /** phase counts walk cycles; it only advances with distance walked, so feet keep pace with the floor. */
  hero: Body = newBody();
  /**
   * The other heroes on screen (?pads=party): one per extra gamepad, the hero's figure with a ring in its player's
   * colour. They walk on their own; whoever uses something becomes `hero` for it (lead), so the story stays one.
   */
  party: Body[] = [];
  /** A walk-and-use is under way: the lead does not change hands until it ends. */
  busy = false;
  speech: { text: string; until: number; who?: string; from: number; audioUntil?: number } | null = null;
  state!: State;
  /** The inventory item the next click uses. */
  holding: string | undefined;
  readonly bag = new Bag((key) => this.itemLook(key), (key) => this.hold(this.holding === key ? undefined : key), !hideCursor);
  readonly answers = new Answers();
  private endingShown = '';
  hover: Hot | undefined;
  grid = params.has('grid');
  /** 0 clear, 1 black; eases toward darkTarget. */
  dark = 0;
  private darkTarget = 0;
  time = 0;
  /** The diorama camera, -1..1 each way; eases toward where the pointer and the hero pull it. */
  cam: Camera = { x: 0, y: 0 };
  /** The scene column at the middle of the view; W/2 unless the camera tracks the hero. */
  viewX = 0;
  /** The scene row at the middle of the view; H/2 unless tracking, which keeps the hero's feet in view. */
  viewY = 0;
  private pending: (() => void) | null = null;
  private listeners: Array<(event: Events, detail: object) => void> = [];
  frame = 0;

  async start() {
    this.data = await (await fetch('world-data.json')).json();
    useLanguage(this.data.world.language);
    await Promise.all(Object.entries(this.data.cast).map(async ([key, cast]) => {
      const img = await loadImage(files(cast.image)).catch(() => undefined);
      if (!img) return;
      const figure: Figure = { img, height: cast.height, upright: cast.upright };
      if (cast.rig && cast.parts) {
        const parts = new Map<PartName, HTMLImageElement>();
        await Promise.all(cast.rig.parts.map(async (p) => parts.set(p.name, await loadImage(files(`${cast.parts}/${p.file}`)))));
        const sheet = cast.rig.sheet ? await loadImage(files(`${cast.parts}/${cast.rig.sheet.file}`)) : undefined;
        const canvas = Object.assign(document.createElement('canvas'), { width: cast.rig.size[0], height: cast.rig.size[1] });
        figure.rig = { rig: cast.rig, parts, sheet, canvas };
      }
      if (cast.sprites && params.get('model') !== '1') {
        const { dir, info } = cast.sprites;
        const sheets = (list: Array<{ sheet: string; yaw: number; stand?: number; off?: number[]; gestures?: string[] }>) =>
          Promise.all(list.map(async (f) => {
            const img = await loadImage(files(`${dir}/${f.sheet}`));
            const walk = [...Array(info.frames).keys()].filter((i) => !f.off?.includes(i));
            return { file: f.sheet, yaw: f.yaw, stand: f.stand ?? 0, gestures: f.gestures ?? ['listen'], img, walk };
          }));
        const [walk, talk] = await Promise.all([sheets(Object.values(info.facings ?? {})), sheets(Object.values(info.talk ?? {})).catch(() => [])]);
        if (walk.length || talk.length) figure.sprites = { info, sheets: walk, talk };
      }
      // A 3D figure needs WebGL; without it (or if the model fails) the 2D rig or cut-out stays.
      else if (cast.model && params.get('model') !== '0') {
        const dir = cast.model.dir;
        figure.model = await import('./hero3d.ts').then(({ Figure3D }) => Figure3D.load(cast.model!.info, (f) => files(`${dir}/${f}`), params.get('modelPaint') === '0' ? 0 : 1))
          .catch((e) => (console.warn(`no 3D figure for ${key}:`, e), undefined));
      }
      if (cast.face && params.get('lipsync') !== '0') {
        try {
          const atlas = await loadImage(files(`${cast.face.dir}/${cast.face.info.image}`));
          const views=[cast.face.info.imagePose?.atlas ?? 'default',cast.face.info.rigPose?.atlas ?? 'default',...Object.entries(cast.face.info.sheets).filter(([name])=>!name.startsWith('model:')).flatMap(([,poses])=>poses.filter(Boolean).map(p=>p!.atlas ?? 'default'))];
          figure.face = new PaintedFace(cast.face.info, atlas,views); figure.faceInfo = cast.face.info;
          figure.model?.setFace(cast.face.info,atlas);
        }
        catch (e) { console.warn(`no facial animation for ${key}:`, e); }
      }
      this.figures.set(key, figure);
    }));
    this.hero.figure = this.figures.get(this.data.world.hero.key);
    this.state = startState(this.data.world);
    const at = params.get('place');
    if (at) this.state.place = at;
    await this.enter(this.state.place);
    this.ui();
    if (this.data.story && !at) await this.say(this.data.story.intro);
  }

  on(fn: (event: Events, detail: object) => void) {
    this.listeners.push(fn);
  }

  private emit(event: Events, detail: object) {
    // The frame number lets a recorder cut on the fixed-step clock instead of wall time.
    for (const fn of this.listeners) fn(event, { ...detail, frame: this.frame, time: this.time });
  }

  /** Plays a list of steps in order, for scripted runs and recordings; resolves when the last one is done. */
  async play(steps: Array<{ walkTo: Point } | { use: string; verb?: Verb; with?: string } | { act: Action } | { wait: number }>) {
    for (const step of steps) {
      if ('walkTo' in step) await this.walkTo(...step.walkTo);
      else if ('use' in step) {
        this.holding = step.with;
        await this.use(step.use, step.verb);
      } else if ('act' in step) await this.act(step.act);
      else await this.wait(step.wait);
    }
  }

  /** For QA: a figure's walk drawn at `frames` evenly spaced phases (plus standing), side by side, as a PNG data URL. */
  figureSheet(key: string, frames = 8): string | undefined {
    const rig = this.figures.get(key)?.rig;
    if (!rig) return undefined;
    const [w, h] = rig.rig.size;
    const sheet = Object.assign(document.createElement('canvas'), { width: w * (frames + 1), height: h });
    const c = sheet.getContext('2d')!;
    c.fillStyle = '#d8d4cc';
    c.fillRect(0, 0, sheet.width, h);
    for (let i = 0; i <= frames; i++) {
      drawRig(rig, pose(rig.rig, i / frames, i < frames), i / frames, i < frames);
      c.drawImage(rig.canvas, i * w, 0);
      c.fillStyle = '#c33';
      c.fillRect(i * w, rig.rig.ground, w, 1);
    }
    return sheet.toDataURL('image/png');
  }

  /** Waits on the game clock, so a wait lasts the same number of frames in capture mode. */
  wait(ms: number): Promise<void> {
    const until = this.time + ms / 1000;
    return new Promise((resolve) => {
      const check = () => (this.time >= until ? resolve() : setTimeout(check, 10));
      check();
    });
  }

  async load(key: string): Promise<Place> {
    if (this.cache.has(key)) return this.cache.get(key)!;
    const spec = this.data.world.places.find((p) => p.key === key);
    const entry = this.data.places[key];
    if (!spec || !entry?.geometry) throw new Error(`${key}: ${entry?.issue ?? 'not a place of this world'}`);
    const g = entry.geometry;
    const dir = (p: string) => files(`places/${key}/${p}`);
    const bg = entry.painting ? await loadImage(files(entry.painting)) : undefined;
    const backdrop = entry.backdrop && parallaxScale > 0 ? await loadImage(files(entry.backdrop)).catch(() => undefined) : undefined;
    const edge = backEdge(g);
    let far: Place['far'];
    if (backdrop && entry.layers) {
      const sky = entry.layers.sky ? await loadImage(files(entry.layers.sky)).catch(() => undefined) : undefined;
      const imgs = await Promise.all(entry.layers.flats.map((f) => loadImage(files(f.file)).catch(() => undefined)));
      const ds = flatDisparities(g, edge, imgs.length);
      if (imgs.every(Boolean)) far = { sky, flats: entry.layers.flats.map((f, i) => ({ img: imgs[i]!, box: f.box, d: ds[i] })) };
    }
    let water: Place['water'];
    const w = entry.layers?.water;
    if (backdrop && w && !params.has('still')) {
      const [tex, mask] = await Promise.all([loadImage(files(w.tex)), loadImage(files(w.mask))].map((p) => p.catch(() => undefined)));
      if (tex && mask) water = { tex, mask, box: w.box, flow: w.flow ?? [1, 0], canvas: Object.assign(document.createElement('canvas'), { width: w.box[2] - w.box[0], height: w.box[3] - w.box[1] }) };
    }
    const smoke = backdrop && entry.layers?.smoke?.length && !params.has('still')
      ? (await Promise.all(entry.layers.smoke.map(async (sm) => ({ img: await loadImage(files(sm.file)).catch(() => undefined), box: sm.box })))).filter((sm): sm is { img: HTMLImageElement; box: [number, number, number, number] } => !!sm.img)
      : undefined;
    const floats = backdrop && entry.layers?.floats?.length && !params.has('still')
      ? (await Promise.all(entry.layers.floats.map(async (f) => ({ img: await loadImage(files(f.file)).catch(() => undefined), box: f.box })))).filter((f): f is { img: HTMLImageElement; box: [number, number, number, number] } => !!f.img)
      : undefined;
    let mist: Place['mist'];
    const m = entry.layers?.mist;
    if (backdrop && m && !params.has('still')) {
      const [tex, mask] = await Promise.all([loadImage(files(m.tex)), loadImage(files(m.mask))].map((p) => p.catch(() => undefined)));
      if (tex && mask) mist = { tex, mask, box: m.box, drift: m.drift ?? 0, speed: m.speed ?? 1, canvas: Object.assign(document.createElement('canvas'), { width: m.box[2] - m.box[0], height: m.box[3] - m.box[1] }) };
    }
    const maskOf = (p?: string) => (p ? loadBits(dir(p), g.frame.width, g.frame.height).catch(() => undefined) : Promise.resolve(undefined));
    const byPath = new Map<string, Promise<Bits | undefined>>();
    const shared = (p?: string) => {
      if (!p) return Promise.resolve(undefined);
      if (!byPath.has(p)) byPath.set(p, maskOf(p));
      return byPath.get(p)!;
    };
    const hots: Hot[] = await Promise.all(
      g.things.map(async (thing) => {
        const mask = await shared(thing.mask);
        const [x0, y0, x1, y1] = thing.box;
        const plate = thing.plate ? await loadImage(dir(thing.plate)).catch(() => undefined) : undefined;
        return { thing, spec: spec.things.find((t) => t.key === thing.key), mask, plate, area: mask?.area ?? (x1 - x0) * (y1 - y0) };
      }),
    );
    hots.sort((a, b) => a.area - b.area);
    // With parallax, a thing cut into stacked pieces slides as one card (see stackCards).
    const cards: Array<Occluder & { stacked?: boolean }> = backdrop ? stackCards(g.occluders) : g.occluders;
    const cuts = await Promise.all(cards.map(async (occ) => this.cut(occ, bg, await shared(occ.mask), g, occ.stacked)));
    const byKey = new Map(g.occluders.map((o) => [o.key, o]));
    const kept = cuts.filter((c): c is Cut => !!c).map((c) => ({ ...c, y: cardY(g, c.occ, (k) => byKey.get(k)) }));
    // Far cards first, so nearer ones cover them when they slide.
    kept.sort((a, b) => a.y - b.y);
    const shade = await shared(g.shadows);
    const depth = g.depth ? await loadDepth(dir(g.depth)).catch(() => undefined) : undefined;
    const wet = depth && entry.layers?.water ? await loadWet(files(entry.layers.water.mask), entry.layers.water.box, g.frame.width, g.frame.height).catch(() => undefined) : undefined;
    // ?weather=0 (or ?still) keeps the place dry, for pixel checks.
    const wx = entry.weather && !params.has('still') && params.get('weather') !== '0' ? entry.weather : undefined;
    const ripples = wx?.ripples ? await loadBits(files(wx.ripples), g.frame.width, g.frame.height).catch(() => undefined) : undefined;
    const weather = wx && new WeatherFx(wx, g, ripples?.bits, key);
    const reactions = entry.reactions && params.get('reactions') !== '0' ? new ReactionFx(entry.reactions, g, key, matchMedia('(prefers-reduced-motion: reduce)').matches) : undefined;
    // ?glow=0 (or ?still; capture unless ?glow=1) keeps the painted lights as painted, for pixel checks.
    const glows = (entry.glows?.length || bg) && !params.has('still') && (params.get('glow') ?? (capture ? '0' : '1')) !== '0' ? new GlowFx(entry.glows ?? [], g.frame.height, bg, wet, backdrop ? kept.map((c) => c.occ.box) : []) : undefined;
    const focus = focusScale > 0 || separateScale > 0 ? depth ?? standIn(g, edge, kept) : undefined;
    const place: Place = { key, spec, g, grid: new WalkGrid(g), bg, backdrop, pivot: pivot(g), edge, far, water, mist, smoke, floats, light: bg && lightMap(bg, g.frame.width, g.frame.height), shade, depth, focus, wet, hots, cuts: kept, byKey, weather, reactions, glows };
    this.cache.set(key, place);
    for (const hot of hots.filter((h) => (h.spec?.role ?? h.thing.role) === 'npc')) {
      const id = `${key}/${hot.thing.key}`;
      if (this.npcs.has(id)) continue;
      const body = newBody();
      [body.x, body.y] = [(hot.thing.box[0] + hot.thing.box[2]) / 2, hot.thing.box[3]];
      body.figure = this.figures.get(hot.thing.key);
      const copy: Hot = { ...hot, thing: { ...hot.thing } };
      const npc: Npc = { key: hot.thing.key, home: key, place: key, body, hot: copy, stop: 0, wait: 2 };
      copy.npc = npc;
      this.npcs.set(id, npc);
    }
    return place;
  }

  /** The painting's own pixels of an occluder, to put back over the hero where he stands behind it. */
  private cut(occ: Occluder, bg: HTMLImageElement | undefined, mask: Bits | undefined, g: Geometry, closeGaps = false): Cut | undefined {
    if (!bg) return undefined;
    const x0 = Math.max(0, Math.floor(occ.box[0]));
    const y0 = Math.max(0, Math.floor(occ.box[1]));
    const w = Math.min(g.frame.width, Math.ceil(occ.box[2])) - x0;
    const h = Math.min(g.frame.height, Math.ceil(occ.box[3])) - y0;
    if (w <= 0 || h <= 0) return undefined;
    const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const cx = c.getContext('2d')!;
    cx.drawImage(bg, x0, y0, w, h, 0, 0, w, h);
    if (mask) {
      const img = cx.getImageData(0, 0, w, h);
      const on = (x: number, y: number) => mask.bits[(y0 + y) * g.frame.width + x0 + x] === 1;
      for (let x = 0; x < w; x++) {
        // A stacked card fills short gaps down each column, so the piece SAM missed between two parts stays on it.
        let last = -1;
        for (let y = 0; y < h; y++) {
          if (on(x, y)) {
            if (closeGaps && last >= 0 && y - last - 1 <= STACK_GAP) for (let f = last + 1; f < y; f++) img.data[(f * w + x) * 4 + 3] = 255;
            last = y;
          } else img.data[(y * w + x) * 4 + 3] = 0;
        }
      }
      cx.putImageData(img, 0, 0);
    }
    return { occ, canvas: c, x0, y0, y: occ.baseY };
  }

  /** Enters a place, at the thing that leads back to where the hero came from, or at its start. */
  async enter(key: string, from?: string) {
    const place = await this.load(key);
    this.place = place;
    this.drawn = [];
    this.hover = undefined;
    await this.syncNpcs();
    place.reactions?.reset();
    const back = from ? place.spec.exits.find((e) => e.to === from) : undefined;
    const arrive = back ? place.g.things.find((t) => t.key === back.via)?.stand : undefined;
    [this.hero.x, this.hero.y] = arrive ?? place.g.start;
    // ?spawn=x,y,left|right places the hero exactly on the first entry, to match a shot cut into the game.
    const spawn = !from && params.get('spawn')?.split(',');
    if (spawn && spawn.length >= 2) {
      [this.hero.x, this.hero.y] = [Number(spawn[0]), Number(spawn[1])];
      if (spawn[2]) this.hero.facing = spawn[2] === 'left' ? -1 : 1;
    }
    this.hero.path = [];
    this.hero.foot = undefined;
    this.hero.along = undefined;
    for (const b of this.party) this.beside(b);
    this.speech = null;
    this.darkTarget = 0;
    canvas.width = place.g.frame.width;
    canvas.height = place.g.frame.height;
    document.getElementById('where')!.textContent = `${this.data.world.title} · ${key}${place.g.preview ? ' (layout preview)' : ''}`;
    this.emit('enter', { place: key, from });
  }

  /** Walks to a point; resolves on arrival, or at once when there is no way there. Another body (`who`) just sets off. */
  walkTo(x: number, y: number, who: Body = this.hero): Promise<boolean> {
    if (who !== this.hero) return Promise.resolve(this.route(who, x, y).length > 0);
    this.pending?.();
    const path = this.route(this.hero, x, y);
    if (!path.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.pending = () => {
        this.pending = null;
        resolve(this.hero.path.length === 0);
      };
    });
  }

  /** Sets a body's path to a point and returns it (empty when there is no way there). */
  private route(who: Body, x: number, y: number): Point[] {
    // Along one step the walk follows it; elsewhere nobody stops on a riser, so on stairs the walk ends
    // on the next tread ahead.
    let path = this.alongStep([who.x, who.y], [x, y]);
    who.along = path ? stepAt(this.place.g, who.x, who.y)?.step : undefined;
    if (!path) {
      const ry = stepRestY(this.place.g, x, y, y < who.y ? -1 : 1);
      if (ry !== y && this.place.grid.walkable(x, ry)) y = ry;
      path = this.place.grid.route([who.x, who.y], [x, y]);
    }
    who.path = path;
    return path;
  }

  /**
   * A walk along one stair step: it follows the step's curve instead of a straight line that would cut
   * across to the next step. Undefined when the two points are not on the same step or the way is blocked.
   */
  private alongStep(from: Point, to: Point): Point[] | undefined {
    const g = this.place.g;
    const a = stepAt(g, ...from);
    const b = stepAt(g, ...to);
    if (!a || !b || a.step !== b.step) return undefined;
    const n = Math.max(1, Math.ceil(Math.abs(to[0] - from[0]) / 12));
    const path: Point[] = [];
    for (let k = 1; k <= n; k++) {
      const x = from[0] + ((to[0] - from[0]) * k) / n;
      // It ends on the tread part of the band, where the feet stand still.
      const end = Math.min(0.7, Math.max(0.3, b.at));
      // Round a hole in the floor (a thing's foot) by moving across the tread, not off the step.
      const want = a.at + ((end - a.at) * k) / n;
      // A little past the band's edges too: a thing standing at the step's end may take its whole depth.
      const ats = Array.from({ length: 45 }, (_, j) => -0.6 + j / 20).sort((p, q) => Math.abs(p - want) - Math.abs(q - want));
      const y = [want, ...ats].map((at) => onStep(g, a.step, x, at)).find((v) => v !== undefined && this.place.grid.walkable(x, v));
      if (y === undefined) return undefined;
      path.push([x, y]);
    }
    return path;
  }

  /** Puts a party body on the floor next to the hero (or on the hero's spot when nothing beside is free). */
  beside(b: Body) {
    const g = this.place.g;
    const gap = personPx(g, this.hero.y) * 0.45;
    const k = this.party.indexOf(b) + 1;
    const offsets = [k * gap, -k * gap, (k + 1) * gap, -(k + 1) * gap, 0];
    const spot = offsets.map((dx) => this.place.grid.snap(this.hero.x + dx, this.hero.y)).find((p) => !!p) ?? [this.hero.x, this.hero.y];
    [b.x, b.y] = spot;
    Object.assign(b, { path: [], foot: undefined, along: undefined, facing: this.hero.facing, figure: b.figure ?? this.hero.figure });
  }

  /** The figure player n (from 1) plays: the hero's, then each drawn player's; the hero's when there are too few. */
  playerFigure(n: number): Figure | undefined {
    const key = n > 1 ? this.data.players?.[n - 2] : undefined;
    return (key && this.figures.get(key)) || this.figures.get(this.data.world.hero.key);
  }

  /** A new party member next to the hero, in a player's colour, as its own drawn hero when it has one. */
  join(colour: string, figure?: Figure): Body {
    const b = { ...newBody(), colour, figure };
    this.party.push(b);
    if (this.place) this.beside(b);
    return b;
  }

  /** Makes a party body the hero (the one the story, the camera and the bubbles follow); the old hero joins the party. */
  lead(b: Body) {
    if (b === this.hero || this.busy) return;
    const i = this.party.indexOf(b);
    if (i < 0) return;
    this.pending?.();
    this.party[i] = this.hero;
    this.hero = b;
  }

  /** Walks to a thing, faces it and clicks it: through an exit, talk to someone, or the verb the story offers. */
  async use(key: string, verb?: Verb) {
    this.busy = true;
    try {
      await this.useNow(key, verb);
    } finally {
      this.busy = false;
    }
  }

  private async useNow(key: string, verb?: Verb) {
    const hot = this.hots().find((h) => h.thing.key === key);
    if (!hot) throw new Error(`${this.place.key} has no thing "${key}"`);
    if (hot.npc?.target) return;
    this.meeting = hot.npc;
    try {
      const placeKey = this.place.key;
      const [sx, sy] = this.approach(hot);
      if (!(await this.walkTo(sx, sy)) && Math.hypot(this.hero.x - sx, this.hero.y - sy) > this.place.g.cell * 2) return;
      if (this.place.key !== placeKey) return;
      const [x0, , x1] = hot.thing.box;
      this.hero.facing = (hot.npc?.body.x ?? (x0 + x1) / 2) >= this.hero.x ? 1 : -1;
      // Three-quarter towards it, the way a painted figure talks to someone.
      this.hero.yaw = this.hero.facing * Math.PI / 3;
      this.emit('use', { thing: key, verb });
      await this.act(this.actionFor(key, hot, verb));
    } finally {
      if (this.meeting) this.meeting.wait = 2;
      this.meeting = undefined;
    }
  }

  /** The thing the hero stands near enough to use from the keyboard: the one whose spot is nearest, within reach. */
  within(who: Body = this.hero): Hot | undefined {
    const gone = this.gone();
    let best: Hot | undefined;
    let bestD = personPx(this.place.g, who.y) * 1.2;
    for (const hot of this.hots()) {
      if (gone.has(hot.thing.key)) continue;
      const [sx, sy] = this.approach(hot, who);
      const d = Math.hypot(sx - who.x, sy - who.y);
      if (d < bestD) [best, bestD] = [hot, d];
    }
    return best;
  }

  /** Where to stand to use a thing; beside a person rather than inside them, on the side the hero comes from. */
  private approach(hot: Hot, who: Body = this.hero): Point {
    if ((hot.spec?.role ?? hot.thing.role) !== 'npc') return hot.thing.stand;
    const [x0, , x1, y1] = hot.thing.box;
    const x = hot.npc?.body.x ?? (x0 + x1) / 2;
    const y = hot.npc?.body.y ?? y1;
    const side = who.x < x ? -1 : 1;
    const gap = personPx(this.place.g, y) * 0.42;
    for (const s of [side, -side]) {
      const spot = this.place.grid.snap(x + s * gap, y);
      if (spot && Math.abs(spot[0] - x) > gap * 0.6) return spot;
    }
    return this.place.grid.snap(x, y) ?? hot.thing.stand;
  }

  /** What a click on a thing means: the exit, the talk, the held item, or the first verb the story answers. */
  private actionFor(key: string, hot: Hot, verb?: Verb): Action {
    if (verb === 'look') return { kind: 'do', thing: key, verb: 'look' };
    if (this.place.spec.exits.some((e) => e.via === key)) return { kind: 'go', via: key };
    const role = hot.spec?.role ?? hot.thing.role;
    // A person talks: in a conversation when the story has one for them now, else in their own talk lines.
    const story = this.data.story;
    if (role === 'npc' && !this.holding && (!story || pickDialogue(story, this.state, key, this.data.world) >= 0)) return { kind: 'talk', npc: key };
    if (this.holding) return { kind: 'do', thing: key, verb: 'use', with: this.holding };
    if (verb) return { kind: 'do', thing: key, verb };
    const offered = story ? (['take', 'use', 'talk'] as const).find((v) => pickInteraction(story, this.state, { thing: key, verb: v }, this.data.world) >= 0) : undefined;
    return { kind: 'do', thing: key, verb: offered ?? 'look' };
  }

  /** Runs one story action: says its lines, follows a change of place, shows an ending. */
  async act(action: Action) {
    const story = this.data.story;
    const from = this.state.place;
    const before = this.state;
    // A new action supersedes speech from the previous one, including replies that have not started yet.
    const speechTurn = ++this.speechTurn;
    this.speech = null;
    this.emit('silent', {});
    let say: string[];
    if (story) {
      const matched = action.kind === 'do' ? pickInteraction(story, this.state, action, this.data.world) : -1;
      const step = apply(this.data.world, story, this.state, action);
      if (matched >= 0 && action.kind === 'do' && !this.gone().has(action.thing)) {
        const target = this.hots().find((h) => h.thing.key === action.thing);
        // act() is also exposed to scripts; physical effects require the hero to be in reach.
        if (target) {
          const [x, y] = this.approach(target);
          if (Math.hypot(this.hero.x - x, this.hero.y - y) <= this.place.g.cell * 2)
            this.place.reactions?.triggers.interact(JSON.stringify(story.interactions[matched]), this.hero, (k) => this.thingY(k));
        }
      }
      this.state = step.state;
      say = step.say;
      // A new item flies into the bag from the thing it was, or from whoever handed it over.
      const from = action.kind === 'do' ? action.thing : action.kind === 'talk' ? action.npc : before.talk ? story.dialogues[before.talk.dialogue]?.npc : undefined;
      for (const key of this.state.items.filter((i) => !before.items.includes(i))) void this.bag.pickUp(key, from ? this.pageRect(from) : undefined);
    } else {
      // Without story.json the world alone answers: exits lead on, everything else is looked at.
      const exit = action.kind === 'go' ? this.place.spec.exits.find((e) => e.via === action.via) : undefined;
      if (exit) this.state = { ...this.state, place: exit.to };
      const key = action.kind === 'do' ? action.thing : action.kind === 'talk' ? action.npc : '';
      say = exit || !key ? [] : [this.hots().find((h) => h.thing.key === key)?.spec?.looks ?? key];
    }
    if (action.kind === 'do' && action.with) this.holding = undefined;
    if (!say.length && action.kind === 'do') say = [action.with ? this.nopeLine(action.with) : this.lookLine(action.thing, action.verb)];
    this.ui();
    // Who says each line: in a conversation the NPC answers after the hero's choice; everything else is the hero's.
    const hero = this.data.world.hero.key;
    const npc = story && (action.kind === 'talk' ? action.npc : action.kind === 'choose' && before.talk ? story.dialogues[before.talk.dialogue]?.npc : undefined);
    // A person talked to without a conversation answers with their own talk line.
    const answers = action.kind === 'do' && speakerOf(this.data.world, { place: from, thing: action.thing, verb: action.verb }) !== hero;
    const after = this.state;
    // Keep action side effects in order, but skip outdated speech if another action was picked in the meantime.
    const turn = this.saying.then(async () => {
      for (const [i, line] of say.entries()) {
        if (speechTurn !== this.speechTurn) break;
        await this.say(line, answers ? (action as { thing: string }).thing : npc && (action.kind === 'talk' || i > 0) ? npc : hero);
      }
      if (after.place !== from) {
        this.emit('exit', { from, to: after.place });
        await this.fadeOut();
        await this.enter(after.place, from);
      }
      await this.syncNpcs();
      if (after.ending) this.emit('ending', { ending: after.ending });
      this.ui();
    });
    this.saying = turn.catch(() => undefined);
    await turn;
  }

  /** Action effects stay ordered; a new action invalidates older speech. */
  private saying: Promise<void> = Promise.resolve();
  private speechTurn = 0;

  /** An item tried where it does not help: the story's own line for it, else a plain one. */
  private nopeLine(item: string): string {
    const it = this.data.story?.items.find((i) => i.key === item);
    return it?.nope ?? words.nope(it?.name ?? item.replace(/-/g, ' '));
  }

  private lookLine(thing: string, verb: string): string {
    const looks = this.hots().find((h) => h.thing.key === thing)?.spec?.looks ?? thing.replace(/-/g, ' ');
    return verb === 'look' ? looks : `Nothing happens. ${looks[0].toUpperCase()}${looks.slice(1)}.`;
  }

  /** An item's name from the story and its icon from the icons step. */
  itemLook(key: string): ItemLook {
    const icon = this.data.items?.[key]?.icon;
    return { name: this.data.story?.items.find((i) => i.key === key)?.name ?? key.replace(/-/g, ' '), ...(icon && { icon: files(icon) }) };
  }

  /** Takes an item in hand (it becomes the cursor), or puts it back with undefined. */
  hold(key: string | undefined) {
    this.holding = key;
    this.ui();
  }

  /** Where a thing (or a person in this place) is on the page, for an item to fly from. */
  pageRect(key: string): DOMRect | undefined {
    const figure = this.drawn.find((d) => d.hot.thing.key === key)?.rect;
    const box = figure ?? this.hots().find((h) => h.thing.key === key)?.thing.box;
    if (!box) return undefined;
    const z = this.zoom();
    const { width: W, height: H } = this.place.g.frame;
    const [x0, y0] = [(box[0] - (this.viewX || W / 2)) * z + W / 2, (box[1] - (this.viewY || H / 2)) * z + H / 2];
    const r = canvas.getBoundingClientRect();
    const k = r.width / canvas.width;
    return new DOMRect(r.left + x0 * k, r.top + y0 * k, (box[2] - box[0]) * z * k, (box[3] - box[1]) * z * k);
  }

  /** Ends the conversation as its Goodbye would: the player walked away, clicked elsewhere or pressed Esc. */
  leave(): boolean {
    if (!this.state.talk || this.state.ending) return false;
    void this.act({ kind: 'leave' });
    return true;
  }

  /** Inventory, conversation choices and the ending, as plain HTML over the canvas. */
  ui() {
    const story = this.data.story;
    if (this.holding && !this.state.items.includes(this.holding)) this.holding = undefined;
    this.bag.show(this.state.items, this.holding);
    this.bag.quiet(!!this.state.talk);
    if (this.state.ending) document.getElementById('inventory')!.hidden = true;
    const options = story && this.state.talk ? actions(this.data.world, story, this.state) : [];
    const hero = this.data.world.hero.key;
    this.answers.show(options.map((a) => ({
      text: a.kind === 'choose' ? lineChoice(story!, this.state, a.index) : words.goodbye,
      action: a.kind === 'choose' ? `choose:${a.index}` : a.kind,
      pick: () => void this.act(a),
    })), { name: displayName(hero, this.data.world.names), portrait: this.data.cast[hero] && files(this.data.cast[hero].image) });
    const ending = story?.endings.find((e) => e.key === this.state.ending);
    // Drawn once per ending, so the card's entrance plays once.
    if ((ending?.key ?? '') !== this.endingShown) {
      this.endingShown = ending?.key ?? '';
      showEnding(ending, this.state.items.map((k) => this.itemLook(k)));
    }
  }

  /** Shows (and voices) a line; `who` (a cast key) gestures while it lasts. */
  say(text: string, who?: string): Promise<void> {
    // A voiced line stays up until it has been said.
    const voiced = spokenLine(this.data.sound, text, who ?? 'narrator')?.seconds ?? 0;
    const seconds = Math.max(2.2 + text.length * 0.045, voiced + 0.5);
    // A line the story wrote inside quotes ('Off with you!') is shown without them: the bubble is the quotes.
    this.speech = { text: unquoted(text), until: this.time + seconds, who, from: this.time };
    this.emit('say', { text, who: who ?? 'narrator' });
    return new Promise((resolve) => {
      const done = this.speech;
      const check = () => (this.speech !== done ? resolve() : setTimeout(check, 50));
      check();
    });
  }

  /** The audio clock owns voiced lines; slow rendering must not lengthen their pauses. */
  voiceStarted(speech: unknown) {
    if (this.speech && this.speech === speech) this.speech.audioUntil = Infinity;
  }

  voiceEnded(speech: unknown) {
    // Ignore completion of an interrupted line and audio that was muted/suspended.
    if (this.speech && this.speech === speech && this.speech.audioUntil !== undefined) this.speech.audioUntil = performance.now() + 250;
  }

  private fadeOut(): Promise<void> {
    this.darkTarget = 1;
    return new Promise((resolve) => {
      const tick = () => (this.dark >= 1 ? resolve() : setTimeout(tick, 16));
      tick();
    });
  }

  private changeImgs = new Map<number, HTMLImageElement | null>();

  /** Images of the story changes that hold now in this place; each loads on first use. */
  changed(): Array<{ img: HTMLImageElement; i: number }> {
    const story = this.data.story;
    if (!story || !this.data.changes) return [];
    const out: Array<{ img: HTMLImageElement; i: number }> = [];
    for (const i of activeChanges(story, this.state)) {
      if (story.changes[i].place !== this.place.key || !this.data.changes[i]) continue;
      if (!this.changeImgs.has(i)) {
        this.changeImgs.set(i, null);
        void loadImage(files(this.data.changes[i])).then((img) => this.changeImgs.set(i, img)).catch(() => undefined);
      }
      const img = this.changeImgs.get(i);
      if (img) out.push({ img, i });
    }
    return out;
  }

  /** Things of this place the story has carried off: drawn from their clean plate, not clickable, hiding no one. */
  gone(): Set<string> {
    const story = this.data.story;
    if (!story) return new Set();
    return new Set(hiddenThings(story, this.state).filter((h) => h.place === this.place.key).map((h) => h.thing));
  }

  /** Where each NPC was drawn last frame, nearest last, so a click lands on the figure people see. */
  private drawn: Array<{ hot: Hot; rect: Rect }> = [];

  /** Original NPC hotspots are replaced by the bodies actually in this place. */
  private hots(): Hot[] {
    return [...this.place.hots.filter((h) => (h.spec?.role ?? h.thing.role) !== 'npc'),
      ...[...this.npcs.values()].filter((n) => n.place === this.place.key).map((n) => n.hot)];
  }

  /** Reconcile the deterministic story location after the action's lines have been heard. */
  private async syncNpcs() {
    for (const [key, to] of Object.entries(this.state.npcs ?? {})) {
      const home = this.data.world.places.find((p) => p.things.some((t) => t.key === key && t.role === 'npc'))?.key;
      if (!home) continue;
      await this.load(home);
      const npc = this.npcs.get(`${home}/${key}`);
      if (!npc) continue;
      if (npc.place === to) {
        if (npc.target) { npc.body.path = []; npc.leaving = undefined; }
        npc.target = undefined; npc.journey = undefined;
        continue;
      }
      npc.target = await this.load(to);
      npc.blocked = false;
      // Several events may fire before a departure finishes. Keep walking through real exits.
      const paths = [[npc.place]];
      const seen = new Set([npc.place]);
      let journey: string[] | undefined;
      for (let i = 0; i < paths.length; i++) {
        const path = paths[i];
        if (path.at(-1) === to) { journey = path.slice(1); break; }
        for (const e of this.data.world.places.find((p) => p.key === path.at(-1))?.exits ?? [])
          if (!seen.has(e.to)) { seen.add(e.to); paths.push([...path, e.to]); }
      }
      npc.journey = journey ? await Promise.all(journey.map((p) => this.load(p))) : undefined;
      // If the player has already left, finish the departure off screen.
      if (npc.place !== this.place.key) this.arriveNpc(npc, npc.target);
    }
  }

  private arriveNpc(npc: Npc, target: Place) {
    const from = npc.place;
    const destination = npc.target;
    npc.journey = npc.journey?.slice(1);
    npc.place = target.key;
    npc.target = target.key === destination?.key ? undefined : destination;
    npc.leaving = undefined;
    npc.blocked = false;
    npc.patrol = undefined;
    npc.stop = 0;
    npc.body.path = [];
    npc.body.foot = undefined;
    npc.body.along = undefined;
    const back = target.spec.exits.find((e) => e.to === from);
    const entry = target.g.things.find((t) => t.key === back?.via)?.stand ?? target.g.start;
    [npc.body.x, npc.body.y] = target.grid.snap(...entry) ?? entry;
    npc.arriving = true;
    npc.wait = 0;
    // On return to a former home, use the original standing place rather than a second copy.
    this.emit('npc-enter', { npc: npc.key, from, to: target.key });
    if (npc.target && npc.place !== this.place.key) this.arriveNpc(npc, npc.target);
  }

  private updateNpcs(dt: number) {
    if (this.state.ending || this.state.place !== this.place.key) return;
    for (const npc of this.npcs.values()) {
      if (npc.place !== this.place.key) continue;
      const body = npc.body;
      const speaking = this.speech?.who === npc.key;
      const talking = this.state.talk && this.data.story?.dialogues[this.state.talk.dialogue]?.npc === npc.key;
      if (npc === this.meeting || speaking || talking) { npc.wait = 2; continue; }
      const patrol = this.data.story?.patrols?.find((p) => p.npc === npc.key && p.place === npc.place && holds(this.state, p.when));
      if (patrol !== npc.patrol && !npc.target) { npc.patrol = patrol; npc.stop = 0; body.path = []; npc.wait = 0; }
      const nextPlace = npc.journey?.[0] ?? npc.target;
      if (nextPlace && npc.leaving !== nextPlace) {
        if (npc.blocked) continue;
        const exit = this.place.spec.exits.find((e) => e.to === nextPlace.key);
        const spot = this.place.g.things.find((t) => t.key === exit?.via)?.stand;
        if (!spot || !this.route(body, ...spot).length) {
          if (!npc.blocked) console.warn(`NPC ${npc.key} cannot walk from ${npc.place} to ${nextPlace.key}`);
          npc.blocked = true;
          continue;
        }
        npc.leaving = nextPlace;
        npc.blocked = false;
      }
      if (body.path.length) {
        this.move(body, dt);
        if (body.path.length) continue;
        npc.wait = patrol?.pause ?? 2;
      }
      if (npc.leaving) { this.arriveNpc(npc, npc.leaving); continue; }
      npc.wait -= dt;
      if (npc.wait > 0) continue;
      let spot: Point | undefined;
      if (npc.arriving) {
        const own = this.place.g.things.find((t) => t.key === npc.key);
        spot = patrol ? this.place.g.things.find((t) => t.key === patrol.via[0])?.stand
          : own ? [(own.box[0] + own.box[2]) / 2, own.box[3]] : this.place.g.start;
        npc.arriving = false;
      } else if (patrol) {
        const key = patrol.via[npc.stop++ % patrol.via.length];
        spot = this.place.g.things.find((t) => t.key === key)?.stand;
      }
      if (spot) this.route(body, ...spot);
      npc.wait = patrol?.pause ?? 2;
    }
  }

  thingAt(x: number, y: number): Hot | undefined {
    const g = this.place.g;
    const gone = this.gone();
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const [x0, y0, x1, y1] = this.drawn[i].rect;
      // The rect includes the shadow; trim it and the transparent margin at the sides.
      const inset = (x1 - x0) * 0.12;
      if (x >= x0 + inset && x <= x1 - inset && y >= y0 && y <= y1 - 4) return this.drawn[i].hot;
    }
    const [sx0, sy0] = [x, y];
    for (const hot of this.hots()) {
      if (this.drawn.some((d) => d.hot === hot)) continue;
      if (gone.has(hot.thing.key)) continue;
      // Each thing is tested where it is drawn: moved by its own parallax shift.
      [x, y] = this.paintingPoint(hot, sx0, sy0);
      const [x0, y0, x1, y1] = hot.thing.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (!hot.mask || hot.mask.bits[Math.floor(y) * g.frame.width + Math.floor(x)]) return hot;
    }
    return undefined;
  }

  update(dt: number) {
    this.time += dt;
    this.frame++;
    const hero = this.hero;
    const step = dt / 0.3;
    this.dark = this.darkTarget > this.dark ? Math.min(this.darkTarget, this.dark + step) : Math.max(this.darkTarget, this.dark - step);
    if (this.speech && (this.speech.audioUntil === undefined ? this.time > this.speech.until : performance.now() > this.speech.audioUntil)) {
      this.speech = null;
      this.emit('silent', {});
    }
    this.swayCamera(dt);
    this.place.weather?.update(dt);
    this.place.glows?.step(dt);
    this.place.reactions?.update(dt);
    this.updateNpcs(dt);
    for (const b of this.party) this.move(b, dt);
    this.move(hero, dt);
  }

  /** Walks a body along its path for dt; the hero's arrival ends its walkTo. */
  private move(hero: Body, dt: number) {
    let budget = personPx(this.place.g, hero.y) * (hero.run ? RUN : WALK) * dt;
    const fromY = hero.y;
    // The budget is floor walked, not screen pixels: going into the picture or out of it covers more floor per
    // pixel than going across, so the body moves fewer pixels there and its feet do not skate over the floor.
    while (budget > 0 && hero.path.length) {
      const beforeStep = { x: hero.x, y: hero.y, phase: hero.phase, foot: hero.foot };
      const [tx, ty] = hero.path[0];
      const k = depthStretch(this.place.g, hero.y);
      const d = Math.hypot(tx - hero.x, (ty - hero.y) * k);
      const moved = Math.min(d, budget);
      if (Math.abs(tx - hero.x) > 1) hero.facing = tx > hero.x ? 1 : -1;
      if (d > 0.5) hero.yaw = turnToward(hero.yaw, Math.atan2(tx - hero.x, ty - hero.y), dt * 10);
      if (d <= budget) {
        [hero.x, hero.y] = [tx, ty];
        hero.path.shift();
        budget -= d;
      } else {
        hero.x += ((tx - hero.x) / d) * budget;
        hero.y += ((ty - hero.y) / d) * budget;
        budget = 0;
      }
      // One cycle per CYCLE heights walked: the rig's planted foot keeps pace with the floor.
      hero.phase += moved / (CYCLE * personPx(this.place.g, hero.y));
      this.place.reactions?.triggers.move(hero, beforeStep, { x: hero.x, y: hero.y, phase: hero.phase,
        foot: stepFootY(this.place.g, hero.x, hero.y) }, this.state);
      if (!hero.path.length) hero.run = false;
      if (!hero.path.length && hero === this.hero) {
        this.emit('arrive', { x: hero.x, y: hero.y });
        this.pending?.();
      }
    }
    // On stairs the feet only go the way the hero goes: a curved tread would otherwise sink them back
    // as he crosses it, and they stay put when he stops. Off the stairs (or after a jump) they follow.
    // Walking along one step, the feet stay on its tread all the way.
    const alongTread = hero.along === undefined ? undefined : treadY(this.place.g, hero.along, hero.x);
    const tread = alongTread ?? stepFootY(this.place.g, hero.x, hero.y);
    const dy = alongTread === undefined ? hero.y - fromY : 0;
    if (alongTread !== undefined) hero.foot = alongTread;
    else if (hero.foot === undefined || tread === hero.y || Math.abs(hero.foot - tread) > 0.3 * personPx(this.place.g, hero.y)) hero.foot = tread;
    else if (dy < 0) hero.foot = Math.min(hero.foot, tread);
    else if (dy > 0) hero.foot = Math.max(hero.foot, tread);
  }

  /** The parallax of this frame, or undefined when the place is drawn flat (no backdrop, or turned off). */
  parallax(): Parallax | undefined {
    return this.place.backdrop ? { cam: this.cam, pivot: this.place.pivot, px: PARALLAX_PX * parallaxScale * (1 + 1.5 * track) } : undefined;
  }

  /** How far something standing on the floor row y slides this frame. */
  shift(y: number): [number, number] {
    const p = this.parallax();
    return p ? shiftAt(this.place.g, p, y) : [0, 0];
  }

  /** The floor row a thing stands on: its card's, or its box's bottom. */
  private thingY(key: string): number {
    const cut = this.place.cuts.find((c) => (c.occ.thing ?? c.occ.key) === key);
    return cut ? cut.y : (this.hots().find((h) => h.thing.key === key)?.thing.box[3] ?? this.place.g.frame.height);
  }

  /** The zoom that keeps the frame's edges covered while the cards sway (and leaves room to pan when tracking); 1 when flat. */
  zoom(): number {
    const p = this.parallax();
    return p ? overscan(this.place.g, { ...p, cam: { x: 1, y: 1 } }) * (1 + TRACK_ZOOM * track) : 1;
  }

  /** How far the view's middle may pan from the frame's middle when tracking. */
  private panRoom(): number {
    const W = this.place.g.frame.width;
    return this.parallax() && track ? W / 2 - W / (2 * (1 + TRACK_ZOOM * track)) : 0;
  }

  /** A canvas point as a point of the zoomed (and panned) scene. */
  unzoom(x: number, y: number): Point {
    const z = this.zoom();
    const { width: W, height: H } = this.place.g.frame;
    return [(x - W / 2) / z + (this.viewX || W / 2), (y - H / 2) / z + (this.viewY || H / 2)];
  }

  /** The parallax shift of a card at column x: a card with a floor line (a railing along the quay) slides
   * column by column as the floor under it, so its far end moves less than its near end. */
  private cardShift(cut: Cut, x: number): [number, number] {
    const o = cut.occ;
    if (!o.floor?.length || o.on || o.front) return this.shift(cut.y);
    // SAM often splits one thing into stacked blobs (a post's cap above its rope coil): in each column the
    // whole thing stands where its lowest blob meets the floor, so the pieces stay together.
    let y = floorYAt(o, x);
    for (const c of this.place.cuts) {
      const b = c.occ;
      if (b !== o && o.thing && b.thing === o.thing && !b.on && !b.front && x >= b.box[0] && x <= b.box[2]) y = Math.max(y, floorYAt(b, x));
    }
    return this.shift(y);
  }

  /** Draws the card's columns [xa, xb) (frame x) in strips, each slid by the floor under it. */
  private drawCard(cut: Cut, xa = cut.x0, xb = cut.x0 + cut.canvas.width, ya = cut.y0, yb = cut.y0 + cut.canvas.height) {
    // A boat on the water rides the swell: rises and sinks a little and rolls about its keel, slowly, each on its own phase.
    if (this.afloat(cut) && !params.has('still')) {
      const t = this.time + (hashSeed(cut.occ.key) % 1000) / 160;
      const [w, hgt] = [cut.canvas.width, cut.canvas.height];
      const [px, py] = [cut.x0 + w / 2, cut.y0 + hgt * 0.85];
      ctx.save();
      // Big enough to read at a glance: a few pixels of rise and fall and a visible roll, never a jitter.
      ctx.translate(px + Math.sin(t * 0.55) * Math.min(3, hgt * 0.01), py + Math.sin(t * 1.3) * Math.max(2, Math.min(6, hgt * 0.025)));
      ctx.rotate(0.035 * Math.sin(t * 0.9 + 1.1));
      ctx.translate(-px, -py);
      this.drawStrips(cut, xa, xb, ya, yb);
      ctx.restore();
      return;
    }
    this.drawStrips(cut, xa, xb, ya, yb);
  }

  private readonly floating = new WeakMap<Cut, boolean>();

  /** A boat whose hull meets water (beside it and under it), not one up on a stand on the quay. */
  private afloat(cut: Cut): boolean {
    let known = this.floating.get(cut);
    if (known !== undefined) return known;
    const wet = this.place.wet;
    const { width: W, height: H } = this.place.g.frame;
    const [x0, y0, x1, y1] = cut.occ.box;
    const at = (x: number, y: number) => (wet ? wet[Math.max(0, Math.min(H - 1, Math.round(y))) * W + Math.max(0, Math.min(W - 1, Math.round(x)))] > 100 : false);
    const hy = y1 - 0.15 * (y1 - y0);
    known = FLOATS.test(cut.occ.thing ?? cut.occ.key) && [at(x0 - 6, hy), at(x1 + 6, hy), at((x0 + x1) / 2, y1 + 6)].filter(Boolean).length >= 2;
    this.floating.set(cut, known);
    return known;
  }

  private drawStrips(cut: Cut, xa: number, xb: number, ya: number, yb: number) {
    const STRIP = 6;
    const right = cut.x0 + cut.canvas.width;
    let [sx, sy] = this.cardShift(cut, xa + Math.min(STRIP, xb - xa) / 2);
    for (let x = xa; x < xb; x += STRIP) {
      const w = Math.min(STRIP, xb - x);
      const next = x + STRIP < xb ? this.cardShift(cut, x + STRIP + Math.min(STRIP, xb - x - STRIP) / 2) : undefined;
      // Wider than the strip by however far the next one slid right, and 2px more: under the zoom a strip's
      // edges land on fractions of a pixel and come out half see-through, and the backdrop showed through the
      // seams as thin vertical lines. The next strip is drawn over the overlap.
      const reach = Math.min(w + 2 + Math.ceil(Math.max(0, (next?.[0] ?? sx) - sx)), right - x);
      ctx.drawImage(cut.canvas, x - cut.x0, ya - cut.y0, reach, yb - ya, x + sx, ya + sy, reach, yb - ya);
      if (next) [sx, sy] = next;
    }
  }

  /** Where a click on screen lands on the floor, in painting coordinates. */
  floorAt(x: number, y: number): Point {
    const p = this.parallax();
    return p ? floorPoint(this.place.g, p, x, y) : [x, y];
  }

  private swayCamera(dt: number) {
    const W = this.place.g.frame.width;
    const k = 1 - Math.exp(-dt * 2.5);
    const H = this.place.g.frame.height;
    this.viewX ||= W / 2;
    this.viewY ||= H / 2;
    const room = this.panRoom();
    if (room > 0) {
      // Tracking: the view pans after the hero; how far it has panned is the camera's swing.
      const want = Math.max(W / 2 - room, Math.min(W / 2 + room, this.hero.x));
      this.viewX += (want - this.viewX) * (1 - Math.exp(-dt * 1.6));
      // Up and down only as far as the frame allows, and only as low as it takes to keep the feet in view:
      // the rest of the view goes to the skyline.
      const roomY = (room * H) / W;
      const wantY = Math.max(H / 2 - roomY, Math.min(H / 2 + roomY, this.hero.y + 24 - H / (2 * this.zoom())));
      this.viewY += (wantY - this.viewY) * (1 - Math.exp(-dt * 1.6));
      this.cam.x = -(this.viewX - W / 2) / room;
      const ty = sway ? Math.sin(this.time * 0.31 + 1) * 0.4 : 0;
      this.cam.y += (ty - this.cam.y) * k;
      return;
    }
    this.viewX = W / 2;
    this.viewY = H / 2;
    // The pointer looks around the diorama; the hero walking across pulls the view after him.
    let tx = -0.5 * (this.hero.x / W - 0.5) * 2;
    let ty = 0;
    if (pointer && !hideCursor) {
      tx += (0.5 - pointer.x) * 2 * 0.8;
      ty += (0.5 - pointer.y) * 2 * 0.8;
    }
    if (sway) {
      tx += Math.sin(this.time * 0.45) * 0.6;
      ty += Math.sin(this.time * 0.31 + 1) * 0.5;
    }
    this.cam.x += (Math.max(-1, Math.min(1, tx)) - this.cam.x) * k;
    this.cam.y += (Math.max(-1, Math.min(1, ty)) - this.cam.y) * k;
  }

  /** The card a thing slides with at column x (the piece covering x, else its nearest), if it has one. */
  private cardOf(key: string, x: number): Cut | undefined {
    let best: Cut | undefined;
    let gap = Infinity;
    for (const c of this.place.cuts) {
      if ((c.occ.thing ?? c.occ.key) !== key) continue;
      const d = Math.max(0, c.occ.box[0] - x, x - c.occ.box[2]);
      if (d < gap) [best, gap] = [c, d];
    }
    return best;
  }

  /** The painting point a thing shows at screen (x, y): on its card, or on the sheared floor for a flat thing. */
  private paintingPoint(hot: Hot, x: number, y: number): Point {
    const p = this.parallax();
    if (!p) return [x, y];
    const key = hot.thing.key;
    if (!this.cardOf(key, x)) return floorPoint(this.place.g, p, x, y);
    // The card's shift depends on the column, so step from the screen column to the painting one.
    let px = x;
    for (let i = 0; i < 3; i++) px = x - this.cardShift(this.cardOf(key, px)!, px)[0];
    const cut = this.cardOf(key, px)!;
    const [sx, sy] = this.cardShift(cut, px);
    return [x - sx, y - sy];
  }

  /** The hover outline, moved exactly as what it outlines: strip by strip with its card, or with the floor. */
  private drawLit(hot: Hot) {
    const p = this.parallax();
    if (!p) return this.drawOutline(hot);
    const key = hot.thing.key;
    if (!this.cardOf(key, hot.thing.box[0])) {
      const { above, below } = backdropTransforms(this.place.g, p);
      const h = this.place.g.scale.horizonY;
      const { width: W, height: H } = this.place.g.frame;
      for (const [m, y0, y1] of [[above, 0, h], [below, h, H]] as const) {
        ctx.save();
        ctx.transform(...(m as [number, number, number, number, number, number]));
        ctx.beginPath();
        ctx.rect(-W, y0, 3 * W, y1 - y0);
        ctx.clip();
        this.drawOutline(hot);
        ctx.restore();
      }
      return;
    }
    const [bx0, , bx1] = hot.thing.box;
    const STRIP = 6;
    for (let x = Math.floor(bx0) - 4; x < bx1 + 4; x += STRIP) {
      const [sx, sy] = this.cardShift(this.cardOf(key, x + STRIP / 2)!, x + STRIP / 2);
      ctx.save();
      ctx.translate(sx, sy);
      ctx.beginPath();
      ctx.rect(x - 1, -1e4, STRIP + 2, 2e4);
      ctx.clip();
      this.drawOutline(hot);
      ctx.restore();
    }
  }

  /**
   * The water moves. Running water flows: two copies of its texture drift downstream, each fading in and out half a cycle apart, so
   * their sum always weighs one and no copy is seen jumping back. They drift along the flow Spark read (into the
   * depth too), near rows faster than far ones. The result is cut to the water's soft mask and slides with the
   * bank behind.
   */
  private drawWater(p: Parallax) {
    const water = this.place.water;
    if (!water) return;
    const { g, edge } = this.place;
    const [x0, y0, x1, y1] = water.box;
    const [ux, uy] = water.flow;
    const w = x1 - x0;
    const c = water.canvas.getContext('2d')!;
    c.globalCompositeOperation = 'source-over';
    c.globalAlpha = 1;
    c.clearRect(0, 0, w, y1 - y0);
    const PERIOD = 6;
    const STRIP = 3;
    const phase = (this.time / PERIOD) % 1;
    // Still water (the sea, a lake, a harbour basin) does not run, but it is never dead: rows sway in slow
    // swells, small far off and wider near, so waves roll across it in place.
    // On the crests the painted light (a moon's path, lit windows) glints: the strip is added over itself, brighter
    // where its pixels already are bright, as the swell passes.
    if (!ux && !uy) {
      for (let y = y0; y < y1; y += STRIP) {
        const near = (y - y0) / Math.max(1, y1 - y0);
        const dx = Math.sin(this.time * 0.9 + y * 0.09) * (1.2 + 6 * near) + Math.sin(this.time * 0.37 + y * 0.023) * (1 + 3.5 * near);
        const dy = Math.sin(this.time * 0.6 + y * 0.05) * (0.6 + 2.2 * near);
        const sy = Math.min(y1 - y0 - STRIP, Math.max(0, y - y0 + dy));
        c.globalCompositeOperation = 'source-over';
        c.globalAlpha = 1;
        c.drawImage(water.tex, 0, sy, w, STRIP, dx, y - y0, w, STRIP);
        const crest = Math.max(0, Math.sin(this.time * 1.3 - y * 0.06 + Math.sin(this.time * 0.4) * 2));
        if (crest > 0.4) {
          c.globalCompositeOperation = 'lighter';
          c.globalAlpha = 0.22 * (crest - 0.4) * (0.5 + near);
          c.drawImage(water.tex, 0, sy, w, STRIP, dx * 1.6, y - y0, w, STRIP);
        }
      }
      c.globalCompositeOperation = 'source-over';
    } else for (const [k, alpha] of [[0, 1], [0.5, 1 - Math.abs(2 * ((phase + 0.5) % 1) - 1)]] as const) {
      const ph = (phase + k) % 1;
      c.globalAlpha = k === 0 ? 1 : alpha;
      for (let y = y0; y < y1; y += STRIP) {
        // By the row's place within the water, not the floor depth: a river near the horizon would barely move.
        // At most the texture's reach past the banks per cycle, so a shifted strip never runs out of texture.
        const near = (y - y0) / Math.max(1, y1 - y0);
        const travel = Math.min(2 * WATER_PAD - 4, FLOW * (0.4 + 0.6 * near) * PERIOD) * (ph - 0.5);
        // Running into the depth, a strip shows the water from further up (or down) the channel.
        const sy = Math.min(y1 - y0 - STRIP, Math.max(0, y - y0 - uy * travel));
        c.drawImage(water.tex, 0, sy, w, STRIP, ux * travel, y - y0, w, STRIP);
      }
    }
    // Glints: short light dashes on the swell, each fading in and out on its own beat and drifting with the
    // water, so even a dark, smooth painted sea is seen to move. Seeded by index, the same every run.
    c.globalCompositeOperation = 'lighter';
    const hh = y1 - y0;
    const count = Math.round((w * hh) / 1400);
    for (let i = 0; i < count; i++) {
      const r1 = fract(Math.sin(i * 12.9898) * 43758.5453);
      const r2 = fract(Math.sin(i * 78.233) * 12543.123);
      const r3 = fract(Math.sin(i * 39.425) * 24634.632);
      const life = 1.6 + 2.4 * r3;
      const beat = (this.time + r1 * life * 7) / life;
      const a = Math.sin(fract(beat) * Math.PI);
      if (a < 0.15) continue;
      // A glint lands somewhere new each beat; near ones (low in the box) are longer and brighter.
      const k = Math.floor(beat);
      const gy = fract(r2 + k * 0.618) * hh;
      const near = gy / hh;
      const gx = fract(r1 + k * 0.381) * w + (ux * FLOW + 6) * fract(beat) * (0.4 + near);
      const len = (8 + 30 * r3) * (0.4 + near);
      c.globalAlpha = a * (0.2 + 0.4 * near);
      c.fillStyle = 'rgb(220,232,255)';
      c.fillRect(gx - len / 2, gy, len, 1.5 + near * 2);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(water.mask, 0, 0);
    // It lies behind the bank's back edge, so it slides as that edge does.
    const bank = Math.min(y1, edge.reduce((a, b) => a + b, 0) / edge.length);
    const [sx, sy] = shiftAt(g, p, bank);
    // A little of the still painting shows through, so reflections (a low sun, lit windows) hold their place.
    ctx.save();
    ctx.globalAlpha = 0.9;
    ctx.drawImage(water.canvas, x0 + sx, y0 + sy);
    ctx.restore();
  }

  /** Painted boats (not cards) rock on the swell: rise and sink a pixel or two and roll about the waterline. */
  private drawFloats(p: Parallax) {
    for (const [k, { img, box }] of (this.place.floats ?? []).entries()) {
      const [x0, y0, x1, y1] = box;
      const [sx, sy] = shiftAt(this.place.g, p, y1);
      const t = this.time + k * 1.7;
      const [px, py] = [(x0 + x1) / 2 + sx, y1 - (y1 - y0) * 0.2 + sy];
      ctx.save();
      // A far boat is a few dozen pixels tall: a share of its height would be under a pixel, so it gets a floor of
      // ~2 px of bob, a clear roll and a slow drift, enough for the eye to catch across the harbour.
      const hh = y1 - y0;
      ctx.translate(px + Math.sin(t * 0.5 + 0.3) * Math.min(2, Math.max(0.8, hh * 0.03)), py + Math.sin(t * 1.25) * Math.max(1.8, Math.min(4, hh * 0.07)));
      ctx.rotate(0.05 * Math.sin(t * 0.85 + 0.7));
      ctx.drawImage(img, x0 + sx - px, y0 + sy - py);
      ctx.restore();
    }
  }

  /**
   * Painted smoke curls: each plume's rows are bent sideways by a wave that rises through it, wider the higher
   * it gets, so the smoke billows and leans with the wind while its foot (the chimney) stays where it was painted.
   */
  private drawSmoke(p: Parallax) {
    const smoke = this.place.smoke;
    if (!smoke?.length) return;
    const wind = this.place.weather?.w.wind ?? 0;
    const STRIP = 2;
    for (const [k, { img, box }] of smoke.entries()) {
      const [x0, y0, , y1] = box;
      const h = y1 - y0;
      const [sx, sy] = shiftAt(this.place.g, p, y1);
      for (let y = 0; y < h; y += STRIP) {
        // 0 at the foot of the plume, 1 at its top.
        const up = 1 - y / Math.max(1, h);
        const amp = 1.5 + 7 * up * up;
        const dx = amp * (0.65 * Math.sin(y * 0.045 + this.time * 1.4 + k * 2.1) + 0.35 * Math.sin(y * 0.11 - this.time * 0.9 + k)) + wind * 30 * up * up;
        ctx.drawImage(img, 0, y, img.width, STRIP, x0 + sx + dx, y0 + y + sy, img.width, STRIP);
      }
    }
  }

  /**
   * The painted fog drifts. Like running water: two copies of its veil (its colour, shaped like its denser and
   * lighter patches) slide sideways half a cycle apart, each fading in and out, so their sum weighs one and none
   * is seen jumping back; with the wind (or the way the author set with fog_drift). Cut to where the fog may
   * show and laid over the still painting, so wisps roll across the land, breathing a little, and sliding with
   * the parallax as its lowest row.
   */
  private drawMist(p: Parallax) {
    const mist = this.place.mist;
    if (!mist) return;
    const [x0, y0, x1, y1] = mist.box;
    const dir = mist.drift || ((this.place.weather?.w.wind ?? 0) < 0 ? -1 : 1);
    const v = MIST_DRIFT * mist.speed;
    // At most the texture's reach past the fog per cycle, so a shifted copy never runs out of fog.
    const period = Math.min(16, (2 * MIST_PAD - 8) / v);
    const phase = (this.time / period) % 1;
    const c = mist.canvas.getContext('2d')!;
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, x1 - x0, y1 - y0);
    for (const k of [0, 0.5]) {
      const ph = (phase + k) % 1;
      c.globalAlpha = k === 0 ? 1 : 1 - Math.abs(2 * ((phase + 0.5) % 1) - 1);
      c.drawImage(mist.tex, dir * v * period * (ph - 0.5), Math.sin(this.time * 0.21 + k * 3) * 3);
    }
    c.globalAlpha = 1;
    c.globalCompositeOperation = 'destination-in';
    c.drawImage(mist.mask, 0, 0);
    const [sx, sy] = shiftAt(this.place.g, p, y1);
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.12 * Math.sin(this.time * 0.35);
    ctx.drawImage(mist.canvas, x0 + sx, y0 + sy);
    ctx.restore();
  }

  /** Draws `draw` moved by the parallax shift of floor row y. */
  private at(y: number, draw: () => void) {
    const [dx, dy] = this.shift(y);
    ctx.save();
    ctx.translate(dx, dy);
    draw();
    ctx.restore();
  }

  render() {
    const { g, bg, backdrop } = this.place;
    const W = g.frame.width;
    const H = g.frame.height;
    const p = this.parallax();
    const z = this.zoom();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#20232a';
    ctx.fillRect(0, 0, W, H);
    ctx.setTransform(z, 0, 0, z, W / 2 - z * (this.viewX || W / 2), H / 2 - z * (this.viewY || H / 2));
    const gone = this.gone();
    const npcs = this.hots().filter((h) => (h.spec?.role ?? h.thing.role) === 'npc' && !h.mask);
    const people: Who[] = [...npcs.map((h) => ({ npc: h, y: h.npc?.body.y ?? h.thing.box[3] })), ...[this.hero, ...this.party].map((body) => ({ body, y: body.y }))].sort((a, b) => a.y - b.y);
    const fire = this.fireOf(gone);
    this.climbs.length = 0;
    if (p && backdrop) {
      // A diorama: the backdrop's floor shears with depth, then every card slides as the floor row it stands on.
      const { above, below } = backdropTransforms(g, p);
      const h = Math.round(g.scale.horizonY);
      if (h > 0) {
        ctx.save();
        ctx.transform(...(above as [number, number, number, number, number, number]));
        // A few rows past the horizon, under the upright band, so a small vertical slide leaves no gap.
        const top = this.place.far?.sky ?? backdrop;
        ctx.drawImage(top, 0, 0, W, Math.min(H, h + 12), 0, 0, W, Math.min(H, h + 12));
        ctx.restore();
      }
      // The far view, flat behind flat, each sliding a little more than the one behind it.
      for (const f of this.place.far?.flats ?? []) {
        const [sx, sy] = shiftAtDisparity(p, f.d);
        ctx.drawImage(f.img, f.box[0] + sx, f.box[1] + sy);
      }
      ctx.save();
      ctx.transform(...(below as [number, number, number, number, number, number]));
      ctx.drawImage(backdrop, 0, h, W, H - h, 0, h, W, H - h);
      ctx.restore();
      // Between the horizon and the floor's back edge stands the upright band (a wall, a railing): column by
      // column it slides as one piece with the edge it stands on. With no far view (no sky, no flats: a room)
      // what is above the horizon is that same wall, so the band reaches the top: a door is not cut in two at eye level.
      const edge = this.place.edge;
      const top = this.place.far?.sky || this.place.far?.flats.length ? h : 0;
      for (let c = 0; c < edge.length; c++) {
        const e = Math.round(edge[c]);
        if (e <= h + 1) continue;
        const x0 = c * g.cell;
        const w = Math.min(g.cell + 1, W - x0);
        if (w <= 0) break;
        const [sx, sy] = shiftAt(g, p, e);
        ctx.drawImage(backdrop, x0, top, w, e - top + 1, x0 + sx, top + sy, w, e - top + 1);
      }
      this.drawWater(p);
      this.drawFloats(p);
      this.drawSmoke(p);
      this.drawMist(p);
      this.place.weather?.drawGround(ctx, (y) => this.shift(y));
      const carded = new Set(this.place.cuts.map((c) => c.occ.thing ?? c.occ.key));
      for (const hot of this.hots()) {
        // A carried-off card is simply not drawn; a flat thing gets its clean plate, on the floor it lies on.
        if (!hot.plate || !gone.has(hot.thing.key) || carded.has(hot.thing.key)) continue;
        const [x0, y0, x1, y1] = hot.thing.box.map((v, i) => (i < 2 ? Math.max(0, v - 16) : v + 16));
        this.at(hot.thing.box[3], () => ctx.drawImage(hot.plate!, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0));
      }
      this.drawFireShadows(fire, backdropTransforms(g, p).below as [number, number, number, number, number, number]);
      for (const who of people) this.drawWho(who, undefined, 'shadow');
      for (const cut of this.place.cuts) {
        if (cut.occ.thing && gone.has(cut.occ.thing)) continue;
        this.drawCard(cut);
      }
      this.drawClimbs();
      // A change belongs to its thing's card, so it slides with it (and its glow with it).
      const story = this.data.story;
      for (const { img, i } of this.changed()) this.at(this.thingY(story!.changes[i].thing), () => ctx.drawImage(img, 0, 0, W, H));
    } else {
      if (bg) ctx.drawImage(bg, 0, 0, W, H);
      // What the story has changed here (a beacon lit): each change is the thing as it looks after, transparent elsewhere.
      for (const { img } of this.changed()) ctx.drawImage(img, 0, 0, W, H);
      this.place.weather?.drawGround(ctx, () => [0, 0]);
      for (const hot of this.hots()) {
        if (!hot.plate || !gone.has(hot.thing.key)) continue;
        // The plate differs from the painting only near the thing, so its grown box is enough.
        const [x0, y0, x1, y1] = hot.thing.box.map((v, i) => (i < 2 ? Math.max(0, v - 16) : v + 16));
        ctx.drawImage(hot.plate, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      }
      // The shadows on the floor, then the things put back over them: shadows never climb onto a thing.
      this.drawFireShadows(fire);
      for (const who of people) this.drawWho(who, undefined, 'shadow');
      for (const cut of this.place.cuts) if (!cut.occ.thing || !gone.has(cut.occ.thing)) this.drawCard(cut);
      this.drawClimbs();
    }
    this.place.glows?.draw(ctx, (y) => this.shift(y));
    this.place.weather?.drawDrips(ctx, (y) => this.shift(y));
    this.drawFocus();
    // Everyone is drawn far to near, and each one gets the things in front of them put back.
    let rect: Rect = [0, 0, 0, 0];
    const lit = this.hover && !hideCursor ? this.hover : undefined;
    // Under the people, so someone standing in front of a highlighted thing stays in front of its outline.
    if (lit && !this.drawn.some((d) => d.hot === lit)) this.drawLit(lit);
    this.drawn = [];
    // The flame burns among the people, far to near: over whoever stands behind it, under whoever stands in front.
    let burnt = !fire?.flame;
    const burn = () => {
      if (!burnt) this.drawFlame(fire!);
      burnt = true;
    };
    let reactionDepth = -Infinity;
    const drawReactions = (until: number) => {
      this.place.reactions?.draw(ctx, reactionDepth, until, (y) => this.shift(y), (r, y) => this.occlude(r, y, gone));
      reactionDepth = until;
    };
    for (const who of people) {
      drawReactions(who.y);
      if (!burnt && who.y > g.light!.at![1] + 2) burn();
      // ?people=0: the place alone, for a landscape take; everyone keeps playing, just unseen.
      if (nobody) continue;
      if (who.npc) {
        const drawn = this.drawWho(who, lit, 'body');
        this.drawn.push({ hot: who.npc, rect: drawn });
        this.occlude(drawn, who.y, gone);
      } else {
        const drawn = this.drawWho(who, lit, 'body');
        if (who.body === this.hero) rect = drawn;
        this.occlude(drawn, who.y, gone);
      }
    }
    burn();
    drawReactions(Infinity);
    // The rain falls in front of everyone; the speech bubble stays over it.
    this.place.weather?.drawAir(ctx);
    if (this.grid) {
      ctx.save();
      if (p) ctx.transform(...(backdropTransforms(g, p).below as [number, number, number, number, number, number]));
      this.drawGrid();
      ctx.restore();
    }
    // The bubble sits over whoever says the line; the narrator (no speaker) and the hero use the hero.
    const speaker = this.speech?.who ? this.drawn.find((d) => d.hot.thing.key === this.speech!.who)?.rect : undefined;
    this.drawSpeech(speaker ?? rect, this.speech?.who && displayName(this.speech.who, this.data.world.names));
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.dark > 0) {
      ctx.fillStyle = `rgba(0,0,0,${this.dark})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  private rimA = document.createElement('canvas');
  private rimB = document.createElement('canvas');

  /**
   * A rim of light on the person's edge facing the light: the silhouette minus itself shifted away from the
   * light, tinted warm and laid over the figure. ctx stands at the feet, not mirrored (paint mirrors itself).
   */
  private rim(h: number, paint: (c: CanvasRenderingContext2D) => number, bright: number, light: NonNullable<Geometry['light']>) {
    const [bw, bh] = [Math.ceil(h * 1.3), Math.ceil(h * 1.2)];
    const [ox, oy] = [Math.round(bw / 2), Math.ceil(h * 1.12)];
    for (const c of [this.rimA, this.rimB]) if (c.width < bw || c.height < bh) Object.assign(c, { width: Math.max(c.width, bw), height: Math.max(c.height, bh) });
    const a = this.rimA.getContext('2d')!;
    a.setTransform(1, 0, 0, 1, 0, 0);
    a.clearRect(0, 0, this.rimA.width, this.rimA.height);
    a.translate(ox, oy);
    paint(a);
    a.setTransform(1, 0, 0, 1, 0, 0);
    // Toward the light: against the way shadows fall. Without a measured light there is no rim at all.
    const dir = light.dir;
    const n = Math.hypot(dir[0], dir[1]) || 1;
    const k = Math.max(1.5, h * RIM_WIDTH * rimScale);
    const b = this.rimB.getContext('2d')!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.globalCompositeOperation = 'copy';
    b.drawImage(this.rimA, 0, 0);
    b.globalCompositeOperation = 'source-in';
    b.fillStyle = RIM_COLOUR;
    b.fillRect(0, 0, bw, bh);
    b.globalCompositeOperation = 'destination-out';
    b.drawImage(this.rimA, (dir[0] / n) * k, (dir[1] / n) * k);
    b.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.filter = `blur(${Math.max(0.5, k * 0.35).toFixed(1)}px)`;
    ctx.globalAlpha = Math.min(1, RIM_ALPHA * Math.min(1.2, bright));
    ctx.globalCompositeOperation = 'screen';
    ctx.drawImage(this.rimB, 0, 0, bw, bh, -ox, -oy, bw, bh);
    ctx.restore();
  }

  private sepCanvas = document.createElement('canvas');
  private sepMask = document.createElement('canvas');

  /**
   * A soft shade the person throws on what stands just behind them (src/play/focus.ts separation): their
   * silhouette, blurred and pushed a little away from the light, darkening only pixels a short way farther
   * than the feet. Painted figures and painted things are equally lit and equally sharp; this occlusion is
   * the cue that puts the figure in front. ctx is already shifted for parallax.
   */
  private separate(x: number, y: number, h: number, paint: (c: CanvasRenderingContext2D) => number) {
    const { focus: d, g } = this.place;
    const feet = y - g.scale.horizonY;
    if (!d || separateScale <= 0 || feet < 4 || h < 8) return;
    const blur = h * SEPARATE_BLUR;
    const pad = Math.ceil(blur * 2.5 + h * SEPARATE_SHIFT);
    const [bw, bh] = [Math.ceil(h * 1.2) + 2 * pad, Math.ceil(h * 1.15) + 2 * pad];
    const [ox, oy] = [Math.round(bw / 2), Math.ceil(pad + h * 1.1)];
    const c = this.sepCanvas;
    if (c.width < bw || c.height < bh) Object.assign(c, { width: Math.max(c.width, bw), height: Math.max(c.height, bh) });
    const cc = c.getContext('2d')!;
    cc.setTransform(1, 0, 0, 1, 0, 0);
    cc.clearRect(0, 0, c.width, c.height);
    // Away from the light, as a shadow would fall on a wall behind; without a measured light, a little down-right.
    const dir = g.light?.dir ?? [0.6, 0.25];
    const n = Math.hypot(dir[0], dir[1]) || 1;
    const [dx, dy] = [(dir[0] / n) * h * SEPARATE_SHIFT, (Math.max(0, dir[1]) / n) * h * SEPARATE_SHIFT * 0.5];
    cc.filter = `blur(${blur.toFixed(1)}px)`;
    cc.translate(ox + dx, oy + dy);
    paint(cc);
    cc.setTransform(1, 0, 0, 1, 0, 0);
    cc.filter = 'none';
    cc.globalCompositeOperation = 'source-in';
    cc.fillStyle = '#121830';
    cc.fillRect(0, 0, bw, bh);
    // Only on what stands a short way behind: the depth mask, one value per depth pixel under the box.
    const S = DEPTH_SCALE;
    const [fx, fy] = [x - ox, y - oy];
    const [c0, r0] = [Math.floor(fx / S), Math.floor(fy / S)];
    const [mw, mh] = [Math.ceil(bw / S) + 1, Math.ceil(bh / S) + 1];
    const m = this.sepMask;
    if (m.width < mw || m.height < mh) Object.assign(m, { width: Math.max(m.width, mw), height: Math.max(m.height, mh) });
    const mc = m.getContext('2d')!;
    const img = mc.createImageData(mw, mh);
    for (let r = 0; r < mh; r++) {
      const dr = r0 + r;
      if (dr < 0 || dr >= d.h) continue;
      for (let k = 0; k < mw; k++) {
        const dc = c0 + k;
        if (dc < 0 || dc >= d.w) continue;
        const i = (r * mw + k) * 4;
        img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
        img.data[i + 3] = Math.round(255 * behindWeight(d.rows[dr * d.w + dc], feet));
      }
    }
    mc.clearRect(0, 0, m.width, m.height);
    mc.putImageData(img, 0, 0);
    cc.globalCompositeOperation = 'destination-in';
    cc.imageSmoothingEnabled = true;
    cc.drawImage(m, 0, 0, mw, mh, c0 * S - fx, r0 * S - fy, mw * S, mh * S);
    cc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = Math.min(0.8, SEPARATE_ALPHA * separateScale);
    ctx.drawImage(c, 0, 0, bw, bh, fx, fy, bw, bh);
    ctx.restore();
  }

  private soft = document.createElement('canvas');
  private maskCanvas = document.createElement('canvas');
  private focusAt = { place: '', row: -1, eased: 0 };

  /**
   * The camera focuses where the hero stands: the frame drawn so far (the painting and its cards, no people yet)
   * is laid over itself blurred and a little paler, through a mask of how far behind the hero each pixel is
   * (src/play/focus.ts). People and the cards put back in front of them are drawn after, sharp.
   */
  private drawFocus() {
    const { focus, g } = this.place;
    if (!focus || focusScale <= 0) return;
    const W = canvas.width;
    const H = canvas.height;
    // Eased, so walking toward or away from the camera pulls focus smoothly instead of stepping.
    const target = Math.max(1, this.hero.y - g.scale.horizonY);
    const f = this.focusAt;
    if (f.place !== this.place.key) Object.assign(f, { place: this.place.key, row: -1, eased: target });
    f.eased += (target - f.eased) * 0.15;
    // The mask is remade only when the focus has moved a few rows.
    const row = Math.round(f.eased / 3) * 3;
    const m = this.maskCanvas;
    if (row !== f.row) {
      if (m.width !== focus.w || m.height !== focus.h) Object.assign(m, { width: focus.w, height: focus.h });
      const mc = m.getContext('2d')!;
      const img = mc.createImageData(focus.w, focus.h);
      focusMask(focus, row, img.data);
      mc.putImageData(img, 0, 0);
      f.row = row;
    }
    // Blurred at half size: cheaper, and the upscale softens it further.
    const s = this.soft;
    const [sw, sh] = [Math.ceil(W / 2), Math.ceil(H / 2)];
    if (s.width !== sw || s.height !== sh) Object.assign(s, { width: sw, height: sh });
    const sc = s.getContext('2d')!;
    const z = ctx.getTransform();
    sc.setTransform(1, 0, 0, 1, 0, 0);
    sc.globalCompositeOperation = 'copy';
    sc.filter = `blur(${((FOCUS_BLUR * focusScale * z.a) / 2).toFixed(2)}px) saturate(0.85) contrast(0.92) brightness(1.04)`;
    sc.drawImage(canvas, 0, 0, sw, sh);
    sc.filter = 'none';
    // The mask in painting coordinates, under the same camera as the frame (zoom, tracking).
    sc.globalCompositeOperation = 'destination-in';
    sc.setTransform(z.a / 2, z.b / 2, z.c / 2, z.d / 2, z.e / 2, z.f / 2);
    sc.imageSmoothingEnabled = true;
    sc.drawImage(m, 0, 0, focus.w * DEPTH_SCALE, focus.h * DEPTH_SCALE);
    sc.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(s, 0, 0, W, H);
    ctx.restore();
  }

  /** A glowing line along the edge of the thing's mask (its box, when it has no mask). */
  private drawOutline(hot: Hot) {
    const [bx0, by0, bx1, by1] = hot.thing.box.map(Math.round);
    ctx.save();
    ctx.shadowColor = 'rgba(255,225,150,0.9)';
    ctx.shadowBlur = 8;
    if (!hot.mask) {
      ctx.strokeStyle = 'rgba(255,233,168,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(bx0, by0, bx1 - bx0, by1 - by0, 8);
      ctx.stroke();
    } else {
      hot.outline ??= edgeCanvas(hot.mask, this.place.g.frame.width, [bx0, by0, bx1, by1]);
      ctx.drawImage(hot.outline, bx0 - 2, by0 - 2);
    }
    ctx.restore();
  }

  /** Draws one person of the scene, an NPC or the hero: their shadow on the floor, or their body. */
  private drawWho(who: Who, lit: Hot | undefined, layer: 'shadow' | 'body'): Rect {
    if (who.npc) {
      const npc = who.npc.npc;
      if (npc) {
        const b = npc.body;
        const inConversation = this.state.talk && this.data.story?.dialogues[this.state.talk.dialogue]?.npc === npc.key;
        const talk = this.speech?.who === npc.key ? 'speak' : inConversation || this.meeting === npc ? 'listen' : undefined;
        const faceHero = talk || (!npc.patrol && !npc.target && !b.path.length);
        const facing = faceHero ? (b.x < this.hero.x ? 1 : -1) : b.facing;
        return this.drawPerson(b.x, b.y, facing, b.phase, b.path.length > 0 && !talk, b.figure, '#4b3b2a', lit === who.npc,
          this.shift(b.y), faceHero ? facing * Math.PI / 3 : b.yaw, talk, b.foot, layer);
      }
      const [x0, , x1, y1] = who.npc.thing.box;
      const x = (x0 + x1) / 2;
      return this.drawPerson(x, y1, x < this.hero.x ? 1 : -1, 0, false, this.figures.get(who.npc.thing.key), '#4b3b2a', lit === who.npc, this.shift(y1), undefined, this.talking(who.npc.thing.key), undefined, layer);
    }
    const h = who.body ?? this.hero;
    // In a party each hero stands on a ring in its player's colour, so a child finds theirs.
    if (h.colour && this.party.length && layer === 'shadow') this.drawRing(h);
    // Copies of one figure are dressed in their player's colours; a child's own drawn hero stays as drawn.
    const copies = h.figure && [this.hero, ...this.party].filter((b) => b.figure === h.figure).length > 1;
    const figure = h.colour && copies ? this.tinted(h.figure, h.colour) : h.figure;
    const rect = this.drawPerson(h.x, h.y, h.facing, h.phase, h.path.length > 0, figure, '#2b2733', false, this.shift(h.y), h.yaw, h === this.hero ? this.talking(this.data.world.hero.key) : undefined, h.foot, layer, this.party.length ? h.colour : undefined);
    if (h.colour && this.party.length && layer === 'body') this.drawTag(h, rect);
    return rect;
  }

  /** The player's number in their colour over a party member's head. */
  private drawTag(h: Body, [x0, y0, x1]: Rect) {
    const r = Math.max(14, personPx(this.place.g, h.y) * 0.06);
    const [x, y] = [(x0 + x1) / 2, y0 - r * 1.6];
    ctx.save();
    ctx.fillStyle = h.colour!;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = r * 0.22;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(r * 1.3)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(PLAYER_COLOURS.indexOf(h.colour!) + 1), x, y + r * 0.08);
    ctx.restore();
  }

  private tints = new Map<string, Figure | null>();

  /**
   * The figure dressed in a player's colour, so each child's hero looks their own: made once per colour in the
   * background (the plain figure stands in meanwhile). A rig or 3D figure keeps its look and only gets the edge.
   */
  private tinted(figure: Figure | undefined, colour: string): Figure | undefined {
    if (!figure || figure.rig || (figure.model && !figure.sprites)) return figure;
    const done = this.tints.get(colour);
    if (done !== undefined) return done ?? figure;
    this.tints.set(colour, null);
    setTimeout(() => {
      const sprites = figure.sprites;
      const sheet = (s: Sheet): Sheet => ({ ...s, img: dressSheet(s.img, colour, sprites!.info) });
      this.tints.set(colour, {
        ...figure,
        img: dressSheet(figure.img, colour),
        ...(sprites && { sprites: { ...sprites, sheets: sprites.sheets.map(sheet), talk: sprites.talk.map(sheet) } }),
      });
    }, 0);
    return figure;
  }

  /** A coloured ring on the floor round a party member's feet. */
  private drawRing(h: Body) {
    const unit = personPx(this.place.g, h.y);
    const [sx, sy] = this.shift(h.y);
    const y = (h.foot ?? stepFootY(this.place.g, h.x, h.y)) + sy;
    ctx.save();
    ctx.strokeStyle = h.colour!;
    ctx.fillStyle = `${h.colour}55`;
    ctx.lineWidth = Math.max(3, unit * 0.022);
    ctx.beginPath();
    ctx.ellipse(h.x + sx, y, unit * 0.2, unit * 0.06, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  /** Draws a person with feet at (x, y): their shadow (layer 'shadow', returns its box) or their body (returns the box it covers). */
  private drawPerson(x: number, y: number, facing: number, phase: number, walking: boolean, figure: Figure | undefined, colour: string, lit = false, [sx, sy]: [number, number] = [0, 0], yaw = facing * Math.PI / 3, talk?: 'speak' | 'listen', foot?: number, layer: 'shadow' | 'body' = 'body', glow?: string): Rect {
    const g = this.place.g;
    // Size comes from where the person stands on the floor and how tall they are (a cat, a child); on stairs
    // the feet sit on the tread under them.
    const unit = personPx(g, y);
    const h = unit * ((figure?.height ?? 1.62) / 1.62);
    y = foot ?? stepFootY(g, x, y);
    const articulation = talk === 'speak' ? mixer?.mouth(this.speech) ?? mouthAt(undefined, undefined) : mouthAt(undefined, undefined);
    const faceTime = performance.now() / 1000;
    // Older NPCs may have only a talking sheet. While walking, use their rig/model/cut-out instead.
    const sprites = figure?.sprites && (!walking || figure.sprites.sheets.length) ? figure.sprites : undefined;
    // A walk sheet warped from the painting looks like the painting; the bare 3D model (TRELLIS's textures up
    // close) does not, so it walks a person only with ?model=1. A creature has no sheet and keeps its model.
    let model = sprites || (figure?.rig?.rig.sheet && params.get('model') !== '1') ? undefined : figure?.model;
    let modelCanvas: HTMLCanvasElement | undefined;
    const modelDensity=Math.max(1,Math.min(4,this.zoom()));
    try {
      modelCanvas = model?.draw({ phase, walking, yaw, px: h*modelDensity, frame:this.frame, time: this.time, talk, face: params.get('lipsync') === '0' ? undefined : faceAt(articulation, faceTime, figure?.faceInfo?.seed) });
    } catch (error) {
      console.warn('3D figure failed; using its 2D figure:', error);
      model?.dispose();
      if (figure) figure.model = undefined;
      model = undefined;
    }
    const rig = model || sprites ? undefined : figure?.rig;
    // A creature's cut-out (not upright, no 3D model) moves as one body: hops, squashes, leans, breathes, blinks.
    const creature = figure?.upright === false && !model && !sprites ? creatureMotion({ phase, walking, time: this.time, talk, seed: x * 0.05 }) : undefined;
    // A rig walks its legs; a plain cut-out (or the stand-in) only bobs and rocks as it slides.
    const bob = creature ? creature.lift * h : rig || model || sprites || !walking ? 0 : Math.abs(Math.sin(phase * Math.PI * 2)) * h * 0.025;
    const rock = creature ? creature.lean * (facing < 0 ? -1 : 1) : rig || model || sprites || !walking ? 0 : Math.sin(phase * Math.PI * 2) * 0.035;
    let rigCanvas: CanvasImageSource | undefined;
    if (rig) {
      const at = pose(rig.rig, phase, walking);
      drawRig(rig, at, phase, walking);
      const sheet = rig.rig.sheet;
      const definition = figure?.faceInfo;
      // A legacy parts rig follows the torso; a baked mesh walk has registrations for its individual cells.
      const imagePose = definition?.rigPose;
      const mapped = !sheet && imagePose ? offsetFace(imagePose, at.torso.to[0] - at.torso.from[0], at.torso.to[1] - at.torso.from[1]) : undefined;
      rigCanvas = figure?.face && (sheet || mapped) ? figure.face.draw(rig.canvas, sheet ? `rig:${sheet.file}` : '$image', sheet ? sheetCell(sheet, phase, walking) : 0,
        1, 1, articulation, faceTime, 0, mapped) : rig.canvas;
    }
    /** Draws the figure into c with its feet at c's origin; returns its half width. */
    const paintRaw = (c: CanvasRenderingContext2D): number => {
      if (sprites) {
        // The nearest painted facing; the left-facing ones are the right ones mirrored.
        const a = Math.atan2(Math.sin(yaw), Math.cos(yaw));
        const nearest = (list: Sheet[], to: number) => list.reduce((best, s) => (Math.abs(s.yaw - to) < Math.abs(best.yaw - to) ? s : best));
        // A figure with no walk sheets (an NPC) always stands on its talk sheet, listening when it isn't speaking.
        const onTalk = sprites.talk.length > 0 && ((talk && !walking) || sprites.sheets.length === 0);
        const sheet = onTalk ? nearest(sprites.talk, Math.abs(a)) : nearest(sprites.sheets, Math.abs(a));
        const { cols, rows, frames, feetAt, px } = sprites.info;
        const [cw, ch] = [sheet.img.width / cols, sheet.img.height / rows];
        const steps = sheet.walk.length ? sheet.walk : [...Array(frames).keys()];
        const i = onTalk ? (talk === 'speak' ? this.gestureCell(sheet, sprites.info) : 0) : walking ? steps[Math.floor((((phase % 1) + 1) % 1) * steps.length) % steps.length] : sheet.stand;
        const s = h / px;
        if (a < 0) c.scale(-1, 1);
        const face = figure?.face ? figure.face.draw(sheet.img, sheet.file, i, cols, rows,
          talk === 'speak' ? mixer?.mouth(this.speech) ?? mouthAt(undefined, undefined) : mouthAt(undefined, undefined), performance.now() / 1000) : undefined;
        if (face && face !== sheet.img) c.drawImage(face, (-cw / 2) * s, -ch * feetAt * s, cw * s, ch * s);
        else c.drawImage(sheet.img, (i % cols) * cw, Math.floor(i / cols) * ch, cw, ch, (-cw / 2) * s, -ch * feetAt * s, cw * s, ch * s);
        return (cw / 2) * s;
      }
      if (modelCanvas && model) {
        // yaw turns the model itself, so no mirroring; feet sit at (width / 2, height * feetAt).
        const w=modelCanvas.width/modelDensity,h=modelCanvas.height/modelDensity;
        c.drawImage(modelCanvas,-w/2,-h*model.feetAt,w,h);
        return w/2;
      }
      c.scale(facing, 1);
      if (rig) {
        const s = h / rig.rig.height;
        const [ax, ay] = [rig.rig.hip[0], rig.rig.ground];
        c.drawImage(rigCanvas ?? rig.canvas, -ax * s, -ay * s, rig.canvas.width * s, rig.canvas.height * s);
        return Math.max(ax, rig.canvas.width - ax) * s;
      }
      const img = figure?.img;
      const w = img ? (h * img.width) / img.height : h * 0.36;
      // A creature squashes and stretches from the feet up, keeping its volume.
      const [sx2, sy2] = creature ? [1 / Math.sqrt(creature.stretch), creature.stretch] : [1, 1];
      if (img) c.drawImage(figure?.face?.draw(img, '$image', 0, 1, 1, articulation, faceTime) ?? img, (-w / 2) * sx2, -h * sy2, w * sx2, h * sy2);
      else drawFigure(c, h, colour);
      return w / 2;
    };
    // Standing is never a still picture: the body bends a little from the planted feet, the head swaying most (a slow
    // weight shift plus a shorter drift), and the chest and shoulders rise with each breath. Each person keeps their
    // own phase; talking makes it livelier. ?idle=0 turns it off.
    const idle = !walking && !creature && params.get('idle') !== '0';
    // The body and its rim share one bent picture: it is painted once per person per frame.
    const token = {};
    const paint = (c: CanvasRenderingContext2D): number => {
      if (!idle) return paintRaw(c);
      const t = this.time + (Math.abs(x * 0.37 + y * 0.11) % 7);
      const k = talk === 'speak' ? 1.5 : 1;
      const sway = k * (0.024 * Math.sin(t * ((2 * Math.PI) / 5.3)) + 0.009 * Math.sin(t * ((2 * Math.PI) / 2.3) + 1.1));
      const breath = 0.5 + 0.5 * Math.sin(t * ((2 * Math.PI) / 3.6));
      const m = c.getTransform();
      const density = Math.max(1, Math.min(1.5, Math.hypot(m.a, m.b)));
      return idleWarp(c, paintRaw, token, h, density, sway, k * 0.02 * breath, 0.009 * k * Math.sin(t * ((2 * Math.PI) / 4.1) + 0.7));
    };
    // How much of the floor under the feet lies in a painted shadow: the person stands in it too.
    const shaded = Math.max(this.shadeAt(x, y, h), this.fireShadeAt(x, y, h));
    const strength = g.light?.strength ?? 0.35;
    ctx.save();
    // Parallax: the person slides with the floor under their feet; size and light still come from where they stand.
    ctx.translate(sx, sy);
    // One shadow per person. Under the sun the cast shadow is it, so the soft blob around the feet gives way to
    // it (two shadows read as two lights) and only a thin dark contact under the soles stays. In shade, fog or
    // no measured light, the blob is the whole shadow.
    // The sun, or a fire's light on this person (its own way, fading with distance).
    const light = lightFor(g, x, y, unit, this.time);
    const cast = light && light.length > 0 && light.strength > 0.02 && shaded < 0.98 ? 1 - shaded : 0;
    const blob = (0.12 + 0.4 * strength) * (1 - cast);
    // Shadows lie on the floor: every one is drawn before the things and the people (the shadow layer), so a
    // near person's long shadow never darkens someone farther away or a fire behind them.
    if (layer === 'shadow') {
      if (blob > 0.01) {
        ctx.fillStyle = `rgba(0,0,0,${blob.toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(x, y, h * 0.16, Math.max(2, h * 0.035), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      if (cast > 0) {
        ctx.fillStyle = `rgba(0,0,0,${(0.3 * cast).toFixed(3)})`;
        ctx.beginPath();
        ctx.ellipse(x, y, h * 0.07, Math.max(1.5, h * 0.014), 0, 0, Math.PI * 2);
        ctx.fill();
      }
      const rect = cast > 0 ? this.castShadow(x, y, h, unit / 1.62, light!, cast * light!.strength, paintRaw, [sx, sy]) : undefined;
      ctx.restore();
      return rect ?? [x + sx, y + sy, x + sx, y + sy];
    }
    // Near a flame a person's light breathes with it.
    const breath = light?.at && g.light?.flame && g.light.strength > 0 ? 1 + 0.5 * FLAME_GLOW * flicker(this.time).glow * Math.min(1, light.strength / g.light.strength) * (1 - shaded) : 1;
    const bright = this.lightAt(x, y - h * 0.5) * (1 - shaded * strength) * breath;
    // A party member is edged in its player's colour (twice, so the edge reads at a glance on a busy painting).
    const edge = glow ? ` drop-shadow(0 0 ${Math.max(2, h * 0.008).toFixed(1)}px ${glow}) drop-shadow(0 0 ${Math.max(2, h * 0.008).toFixed(1)}px ${glow})` : '';
    this.separate(x, y, h, paintRaw);
    ctx.filter = `brightness(${bright.toFixed(2)})${lit ? ' drop-shadow(0 0 5px rgba(255,225,150,0.95))' : ''}${edge}`;
    ctx.translate(x, y - bob);
    ctx.rotate(rock);
    // paint mirrors ctx for a figure facing left; the rim is drawn already mirrored, so it goes on the unmirrored frame.
    const feetAt = ctx.getTransform();
    const half = paint(ctx);
    // The light on this person here (the sun, or a lamp's own way); none measured, no rim.
    if (rimScale > 0 && light && light.strength > 0.02 && Math.hypot(light.dir[0], light.dir[1]) > 0) {
      ctx.setTransform(feetAt);
      this.rim(h, paint, bright * (1 - shaded), light);
    }
    ctx.restore();
    return [x - half - 2 + sx, y - h * 1.04 - bob - 2 + sy, x + half + 2 + sx, y + Math.max(3, h * 0.04) + sy];
  }

  /**
   * The talk cell for the line being said: listening for its first moment, then the story's gesture for that
   * line, easing back to listening now and then so a long line has a rhythm.
   */
  private gestureCell(sheet: Sheet, info: SpriteInfo): number {
    const speech = this.speech;
    const cell = speech ? sheet.gestures.indexOf(info.lines?.[speech.text] ?? 'listen') : -1;
    if (!speech || cell <= 0) return 0;
    const t = this.time - speech.from;
    return t < 0.3 || (t - 0.3) % 1.5 > 1.0 ? 0 : cell;
  }

  /** Whether `key` is speaking a line now, or listening in a conversation (between lines, both listen). */
  private talking(key: string): 'speak' | 'listen' | undefined {
    if (this.speech?.who === key) return 'speak';
    return this.speech?.who || this.state.talk ? 'listen' : undefined;
  }

  private shadowCanvas = document.createElement('canvas');

  /**
   * The figure's silhouette laid on the floor away from the light: its feet stay put and its head lands
   * length * h along dir. Drawn soft, at the painting's own shadow strength. ctx is already shifted for parallax.
   */
  private castShadow(x: number, y: number, h: number, perM: number, light: NonNullable<Geometry['light']>, alpha: number, paint: (c: CanvasRenderingContext2D) => number, [sx, sy]: [number, number]): Rect {
    const sc = this.shadowCanvas;
    const [w, hh] = [Math.ceil(h * 1.4), Math.ceil(h * 1.25)];
    const [ox, oy] = [w / 2, Math.ceil(h * 1.15)];
    // Sized once for the tallest person the place can hold: resizing a canvas mid-walk stalls a frame.
    if (sc.width < w || sc.height < hh) {
      const most = personPx(this.place.g, this.place.g.frame.height);
      Object.assign(sc, { width: Math.ceil(Math.max(w, most * 1.4)), height: Math.ceil(Math.max(hh, most * 1.25)) });
    }
    const c = sc.getContext('2d', { willReadFrequently: true })!;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, sc.width, sc.height);
    c.translate(ox, oy);
    const half = paint(c);
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-in';
    // Painted shadows are cool, not black: a deep blue reads like the shade the painter used.
    c.fillStyle = '#121830';
    c.fillRect(0, 0, sc.width, sc.height);
    c.globalCompositeOperation = 'source-over';
    const onGround = this.place.depth && this.groundShadow(x, y, h, perM, light, alpha, sc, w, hh, ox, oy, half, [sx, sy]);
    if (onGround) return onGround;
    const [dx, dy] = light.dir;
    const n = Math.hypot(dx, dy) || 1;
    const [ux, uy] = [(dx / n) * light.length, (dy / n) * light.length];
    ctx.save();
    ctx.translate(x, y);
    // (u, v) in the figure (v up is negative) goes to (u - ux * v, -uy * v): a head at v = -h lands at h * (ux, uy).
    ctx.transform(1, 0, -ux, -uy, 0, 0);
    ctx.globalAlpha = Math.min(0.85, alpha * 1.35);
    // A little softer the farther it reaches, like a real penumbra, but as crisp as the painted ones.
    ctx.filter = `blur(${Math.max(0.6, h * 0.004 * (1 + light.length)).toFixed(1)}px)`;
    ctx.drawImage(sc, 0, 0, w, hh, -ox, -oy, w, hh);
    ctx.restore();
    const [hx, hy] = [x + ux * h * 1.15, y + uy * h * 1.15];
    return [Math.min(x, hx) - half - 4 + sx, Math.min(y, hy) - 4 + sy, Math.max(x, hx) + half + 4 + sx, Math.max(y, hy) + 4 + sy];
  }

  private groundCanvas = document.createElement('canvas');

  /**
   * The cast shadow laid on the ground as the depth map shapes it (src/play/shadow.ts): each ground pixel
   * asks whether the figure stands between it and the sun. Worked out at the depth map's half resolution
   * and drawn up soft. Painted shadow and water take it away. Undefined: no sun found here, use the flat one.
   */
  private groundShadow(x: number, y: number, h: number, perM: number, light: NonNullable<Geometry['light']>, alpha: number, sc: HTMLCanvasElement, w: number, hh: number, ox: number, oy: number, half: number, [sx, sy]: [number, number]): Rect | undefined {
    const { g, depth, shade, wet } = this.place;
    const sun = depth && sunFor(g, depth, light, x, y, h);
    if (!depth || !sun) return undefined;
    const px = sc.getContext('2d', { willReadFrequently: true })!.getImageData(0, 0, w, hh).data;
    const sil = { alpha: new Uint8ClampedArray(w * hh), w, h: hh, ox, oy, perM };
    for (let i = 0; i < w * hh; i++) sil.alpha[i] = px[i * 4 + 3];
    // Where it can fall: past the flat shadow's reach (a drop lengthens it), wide as the figure, inside the frame.
    const n = Math.hypot(light.dir[0], light.dir[1]) || 1;
    const reach = h * Math.max(1, light.length) * 2.2;
    const [ex, ey] = [x + (light.dir[0] / n) * reach, y + (light.dir[1] / n) * reach];
    const pad = half + h * 0.15;
    const S = DEPTH_SCALE;
    const x0 = Math.max(0, Math.floor((Math.min(x, ex) - pad) / S));
    const y0 = Math.max(0, Math.floor((Math.min(y, ey) - pad) / S));
    const x1 = Math.min(depth.w, Math.ceil((Math.max(x, ex) + pad) / S));
    const y1 = Math.min(depth.h, Math.ceil((Math.max(y, ey) + pad) / S));
    if (x1 <= x0 || y1 <= y0) return undefined;
    const gc = this.groundCanvas;
    const [bw, bh] = [x1 - x0, y1 - y0];
    if (gc.width < bw || gc.height < bh) Object.assign(gc, { width: Math.max(gc.width, bw), height: Math.max(gc.height, bh) });
    const out = new ImageData(bw, bh);
    const W = g.frame.width;
    const on = this.catchesOf(this.gone());
    let any = false;
    for (let r = y0; r < y1; r++) for (let c = x0; c < x1; c++) {
      const [fx, fy] = [c * S + S / 2, r * S + S / 2];
      let a = shadowAt(depth, sun, sil, fx, fy, on);
      if (a <= 0) continue;
      const i = Math.round(fy) * W + Math.round(fx);
      // Already in the painting's shade: no darker. On water a shadow hardly shows (it mirrors the sky).
      if (shade?.bits[i]) continue;
      if (wet) a *= 1 - 0.8 * (wet[i] / 255);
      const o = ((r - y0) * bw + (c - x0)) * 4;
      [out.data[o], out.data[o + 1], out.data[o + 2], out.data[o + 3]] = [0x12, 0x18, 0x30, Math.round(a * 255)];
      any = true;
    }
    if (!any) return [x + sx, y + sy, x + sx, y + sy];
    const gx = gc.getContext('2d')!;
    gx.clearRect(0, 0, gc.width, gc.height);
    gx.putImageData(out, 0, 0);
    const [dark, blur] = [Math.min(0.85, alpha * 1.35), `blur(${Math.max(0.8, h * 0.004 * (1 + light.length)).toFixed(1)}px)`];
    ctx.save();
    ctx.globalAlpha = dark;
    ctx.filter = blur;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(gc, 0, 0, bw, bh, x0 * S, y0 * S, bw * S, bh * S);
    ctx.restore();
    this.climb(gc, [x0 * S, y0 * S, bw, bh], y, dark, blur, [sx, sy]);
    return [x0 * S + sx, y0 * S + sy, x1 * S + sx, y1 * S + sy];
  }

  /** Shadows that land on things standing behind their person (a tent wall): drawn over the cards. */
  private climbs: Array<{ canvas: HTMLCanvasElement; box: [number, number, number, number]; dark: number; blur: string; shift: [number, number] }> = [];
  private climbPool: HTMLCanvasElement[] = [];
  private climbMask = document.createElement('canvas');

  /**
   * Keeps the part of a person's shadow (src: bw x bh cells of DEPTH_SCALE px from frame (x, y)) that falls on
   * the things standing behind them: the shadow layer lies under the cards, so this part goes back on top.
   */
  private climb(src: HTMLCanvasElement, [x, y, bw, bh]: [number, number, number, number], feetY: number, dark: number, blur: string, shift: [number, number]) {
    const S = DEPTH_SCALE;
    const gone = this.gone();
    const behind = this.place.cuts.filter((c) => !c.occ.front && c.y < feetY - 2 && !(c.occ.thing && gone.has(c.occ.thing)) && c.x0 < x + bw * S && c.x0 + c.canvas.width > x && c.y0 < y + bh * S && c.y0 + c.canvas.height > y);
    if (!behind.length) return;
    const canvas = (this.climbPool[this.climbs.length] ??= document.createElement('canvas'));
    if (canvas.width < bw || canvas.height < bh) Object.assign(canvas, { width: Math.max(canvas.width, bw), height: Math.max(canvas.height, bh) });
    const m = this.climbMask;
    if (m.width < bw || m.height < bh) Object.assign(m, { width: Math.max(m.width, bw), height: Math.max(m.height, bh) });
    const mc = m.getContext('2d')!;
    mc.clearRect(0, 0, m.width, m.height);
    for (const c of behind) mc.drawImage(c.canvas, (c.x0 - x) / S, (c.y0 - y) / S, c.canvas.width / S, c.canvas.height / S);
    const cc = canvas.getContext('2d')!;
    cc.clearRect(0, 0, canvas.width, canvas.height);
    cc.drawImage(src, 0, 0, bw, bh, 0, 0, bw, bh);
    cc.globalCompositeOperation = 'destination-in';
    cc.drawImage(m, 0, 0, bw, bh, 0, 0, bw, bh);
    cc.globalCompositeOperation = 'source-over';
    this.climbs.push({ canvas, box: [x, y, bw, bh], dark, blur, shift });
  }

  private drawClimbs() {
    const S = DEPTH_SCALE;
    for (const { canvas, box: [x, y, bw, bh], dark, blur, shift } of this.climbs) {
      ctx.save();
      ctx.translate(...shift);
      ctx.globalAlpha = dark;
      ctx.filter = blur;
      ctx.drawImage(canvas, 0, 0, bw, bh, x, y, bw * S, bh * S);
      ctx.restore();
    }
  }

  /**
   * Where a person's shadow can land on this place (src/play/shadow.ts catchers): its floors and the things
   * standing there, not the fog, sky or far backdrop. Made on first use and again when a thing is carried off.
   */
  private catchesOf(gone: Set<string>): Uint8Array | undefined {
    const { g, depth, cuts } = this.place;
    if (!depth) return undefined;
    const key = [...gone].sort().join(',');
    if (this.place.catches?.gone !== key) {
      const owner = ownerMap(depth, cuts.filter((c) => !c.occ.front && !(c.occ.thing && gone.has(c.occ.thing))));
      this.place.catches = { gone: key, on: catchers(depth, g, owner) };
    }
    return this.place.catches.on;
  }

  /**
   * The fire or lamp standing on this place's floor (light.at), made on first use and again when the story
   * carries a thing off: the painted things' shadows from it (needs the depth map) and the flame to animate.
   */
  private fireOf(gone: Set<string>): Fire | undefined {
    const { g, depth, cuts, shade, wet, bg } = this.place;
    const at = g.light?.at;
    if (!at) return undefined;
    const key = [...gone].sort().join(',');
    if (this.place.fire?.gone === key) return this.place.fire;
    const px = personPx(g, at[1]);
    const holds = (b: number[]) => at[0] >= b[0] && at[0] <= b[2] && at[1] >= b[1] && at[1] <= b[3];
    // The light's own thing: the smallest one holding it. A tall one (a lamp post) shines from its top.
    const own = g.things.filter((t) => holds(t.box)).sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
    const tall = own && own.box[3] - own.box[1] > 1.5 * (own.box[2] - own.box[0]);
    const up = tall ? (0.9 * (own.box[3] - own.box[1]) * 1.62) / px : 1;
    const shadows: Fire['shadows'] = [];
    if (depth) {
      const S = DEPTH_SCALE;
      const owner = ownerMap(depth, cuts.filter((c) => !c.occ.front && !holds(c.occ.box) && !(c.occ.thing && (gone.has(c.occ.thing) || c.occ.thing === own?.key))));
      for (const side of g.light!.flame ? [-1, 0, 1] : [0]) {
        const s = thingShadows(depth, g, owner, at, { up, shift: side * FLAME_SWAY_M });
        const W = g.frame.width;
        // Painted shade is dark already; on water a shadow hardly shows.
        for (let r = 0; r < s.h; r++) for (let k = 0; k < s.w; k++) {
          if (!s.alpha[r * s.w + k]) continue;
          const i = Math.min(g.frame.height - 1, Math.round((r + 0.5) * s.cell * S)) * W + Math.min(W - 1, Math.round((k + 0.5) * s.cell * S));
          if (shade?.bits[i]) s.alpha[r * s.w + k] = 0;
          else if (wet) s.alpha[r * s.w + k] *= 1 - 0.8 * (wet[i] / 255);
        }
        shadows.push(s);
      }
    }
    const [w, h] = shadows.length ? [shadows[0].w, shadows[0].h] : [1, 1];
    const fire: Fire = { gone: key, shadows, mix: new Float32Array(w * h), img: new ImageData(w, h), canvas: Object.assign(document.createElement('canvas'), { width: w, height: h }), px };
    if (g.light!.flame && bg) fire.flame = this.flamePixels(bg, at, px);
    this.place.fire = fire;
    return fire;
  }

  /** The painting's flame over a fire at `at`: its bright warm pixels, to sway and flare on top of it. */
  private flamePixels(bg: HTMLImageElement, at: [number, number], px: number): Fire['flame'] {
    const { width: W, height: H } = this.place.g.frame;
    const x0 = Math.max(0, Math.round(at[0] - 0.35 * px));
    const y0 = Math.max(0, Math.round(at[1] - 0.8 * px));
    const [w, h] = [Math.min(W, Math.round(at[0] + 0.35 * px)) - x0, Math.min(H, Math.round(at[1] + 0.1 * px)) - y0];
    if (w <= 0 || h <= 0) return undefined;
    const canvas = Object.assign(document.createElement('canvas'), { width: w, height: h });
    const c = canvas.getContext('2d', { willReadFrequently: true })!;
    c.drawImage(bg, x0, y0, w, h, 0, 0, w, h);
    const img = c.getImageData(0, 0, w, h);
    const d = img.data;
    const ramp = (v: number, a: number, b: number) => Math.max(0, Math.min(1, (v - a) / (b - a)));
    for (let i = 0; i < d.length; i += 4) {
      const luma = 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2];
      d[i + 3] = Math.round(255 * ramp(luma, 140, 215) * ramp(d[i] - d[i + 2], 40, 100));
    }
    c.putImageData(img, 0, 0);
    return { canvas, x0, y0 };
  }

  /** The things' shadows from the fire as it sways now; under the floor's own shear in a diorama. */
  private drawFireShadows(fire: Fire | undefined, below?: [number, number, number, number, number, number]) {
    const light = this.place.g.light;
    if (!fire?.shadows.length || !light) return;
    const { sway, glow } = flicker(this.time);
    const { mix, img, shadows } = fire;
    // Between the two swayed shadows nearest the flame's place now.
    const [a, b, k] = shadows.length === 1 ? [shadows[0], shadows[0], 0] : sway < 0 ? [shadows[1], shadows[0], -sway] : [shadows[1], shadows[2], sway];
    let any = false;
    for (let i = 0; i < mix.length; i++) {
      mix[i] = a.alpha[i] * (1 - k) + b.alpha[i] * k;
      img.data[i * 4] = 0x12;
      img.data[i * 4 + 1] = 0x18;
      img.data[i * 4 + 2] = 0x30;
      img.data[i * 4 + 3] = Math.round(mix[i] * 255);
      any ||= mix[i] > 0;
    }
    if (!any) return;
    fire.canvas.getContext('2d')!.putImageData(img, 0, 0);
    const cell = shadows[0].cell * DEPTH_SCALE;
    ctx.save();
    if (below) ctx.transform(...below);
    ctx.globalAlpha = Math.min(0.85, light.strength * 1.35 * (light.flame ? 1 + FLAME_GLOW * glow : 1));
    ctx.filter = `blur(${(cell * 0.6).toFixed(1)}px)`;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(fire.canvas, 0, 0, fire.canvas.width * cell, fire.canvas.height * cell);
    ctx.restore();
  }

  /** How much of the feet at (x, y) stand in a thing's shadow from the fire, 0..1. */
  private fireShadeAt(x: number, y: number, h: number): number {
    const fire = this.place.fire;
    if (!fire?.shadows.length) return 0;
    const { w, h: rows, cell } = fire.shadows[0];
    const S = cell * DEPTH_SCALE;
    let sum = 0;
    for (const dx of [-0.08, 0, 0.08]) {
      const [c, r] = [Math.floor((x + dx * h) / S), Math.floor((y - 2) / S)];
      if (c >= 0 && r >= 0 && c < w && r < rows) sum += fire.mix[r * w + c];
    }
    return Math.min(1, sum);
  }

  /** The flame flickers: its bright pixels sway and flare over the painted ones, a warm glow breathes round it, sparks rise. */
  private drawFlame(fire: Fire) {
    const g = this.place.g;
    const at = g.light!.at!;
    const t = this.time;
    const { glow } = flicker(t);
    const [fx] = flameAt(g, t);
    const px = fire.px;
    this.at(at[1], () => {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const [gx, gy] = [fx, at[1] - 0.2 * px];
      const halo = ctx.createRadialGradient(gx, gy, 0, gx, gy, 1.3 * px);
      halo.addColorStop(0, `rgba(255,150,60,${(0.07 + 0.04 * glow).toFixed(3)})`);
      halo.addColorStop(1, 'rgba(255,150,60,0)');
      ctx.fillStyle = halo;
      ctx.fillRect(gx - 1.3 * px, gy - 1.3 * px, 2.6 * px, 2.6 * px);
      const flame = fire.flame;
      if (flame) {
        const { canvas, x0, y0 } = flame;
        const base = at[1];
        const amp = 0.012 * px;
        ctx.globalAlpha = Math.max(0, 0.3 + 0.15 * glow);
        for (let y = 0; y < canvas.height; y += 3) {
          // Higher up it sways more, and the whole flame stretches and settles with its glow.
          const rise = Math.max(0, (base - (y0 + y)) / (0.8 * px));
          const dx = (0.6 * Math.sin((y0 + y) * 0.11 - t * 8) + 0.4 * Math.sin((y0 + y) * 0.05 - t * 5.3)) * amp * rise + (fx - at[0]) * rise;
          const ty = base - (base - (y0 + y)) * (1 + 0.05 * glow);
          ctx.drawImage(canvas, 0, y, canvas.width, 3, x0 + dx, ty, canvas.width, 3 * (1 + 0.05 * glow));
        }
      }
      // A few sparks, each on its own loop: up from the flames, drifting, dimming.
      ctx.globalAlpha = 1;
      for (let i = 0; i < 7; i++) {
        const life = 1.3 + ((i * 0.37) % 0.9);
        const age = (t + i * 0.61) % life;
        const loop = Math.floor((t + i * 0.61) / life);
        const seed = Math.sin(loop * 12.9898 + i * 78.233) * 43758.5453;
        const r = seed - Math.floor(seed);
        const k = age / life;
        const x = at[0] + (r - 0.5) * 0.25 * px + Math.sin(t * 3 + i) * 0.04 * px * k;
        const y = at[1] - 0.15 * px - k * (0.5 + 0.4 * r) * px;
        ctx.fillStyle = `rgba(255,${Math.round(170 + 60 * r)},90,${((1 - k) * 0.8).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.8, 0.006 * px * (1 - 0.5 * k)), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    });
  }

  /** The share of the floor under the feet (an ellipse a person's shadow would cover) inside a painted shadow. */
  private shadeAt(x: number, y: number, h: number): number {
    const shade = this.place.shade;
    if (!shade) return 0;
    const W = this.place.g.frame.width;
    const H = shade.bits.length / W;
    let n = 0;
    let hit = 0;
    for (let j = -2; j <= 2; j++) for (let i = -4; i <= 4; i++) {
      const px = Math.round(x + (i / 4) * h * 0.12);
      const py = Math.round(y + (j / 2) * h * 0.03);
      if (px < 0 || py < 0 || px >= W || py >= H) continue;
      n++;
      hit += shade.bits[py * W + px];
    }
    return n ? hit / n : 0;
  }

  /** How bright a person looks at (x, y): the painting's luma around that spot, softened. */
  private lightAt(x: number, y: number): number {
    const light = this.place.light;
    if (!light) return 1;
    const c = Math.min(light.cols - 1, Math.max(0, Math.floor(x / LIGHT_CELL)));
    const r = Math.min(light.rows - 1, Math.max(0, Math.floor(y / LIGHT_CELL)));
    let sum = 0;
    let n = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= light.rows || cc >= light.cols) continue;
      sum += light.luma[rr * light.cols + cc];
      n++;
    }
    return Math.min(1.1, Math.max(0.4, 0.35 + (0.65 * sum) / n / 150));
  }

  /** Puts the painting back over the hero, column by column, wherever an occluder stands in front of him. */
  private occlude(rect: [number, number, number, number], feetY: number, gone: Set<string>) {
    const support = (k: string) => this.place.byKey.get(k);
    for (const cut of this.place.cuts) {
      if (cut.occ.thing && gone.has(cut.occ.thing)) continue;
      // The person's box as seen from the card, which slid by its own amount.
      const [sx, sy] = this.cardShift(cut, (rect[0] + rect[2]) / 2);
      const [left, top, right, bottom] = [rect[0] - sx, rect[1] - sy, rect[2] - sx, rect[3] - sy];
      const [bx0, by0, bx1, by1] = cut.occ.box;
      if (bx1 < left || bx0 > right || by1 < top || by0 > bottom) continue;
      const y0 = Math.max(top, cut.y0);
      const y1 = Math.min(bottom, cut.y0 + cut.canvas.height);
      if (y1 <= y0) continue;
      for (const [a, b] of hiddenRuns(cut.occ, left, right, feetY, support)) {
        const xa = Math.max(a, cut.x0);
        const xb = Math.min(b, cut.x0 + cut.canvas.width);
        if (xb > xa) this.drawCard(cut, xa, xb, y0, y1);
      }
    }
  }

  /** A paper bubble over the speaker with their name on a tag; its tail points down at them. The narrator's has no tag. */
  private drawSpeech([left, top, right]: [number, number, number, number], name?: string) {
    if (!this.speech) return;
    if (!this.speech.who) return this.drawCaption(this.speech.text);
    ctx.save();
    ctx.font = '22px Georgia, serif';
    const words = this.speech.text.split(/\s+/);
    const lines: string[] = [];
    for (const word of words) {
      const last = lines[lines.length - 1];
      if (last && ctx.measureText(`${last} ${word}`).width < 420) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 40;
    const height = lines.length * 28 + (name ? 30 : 22);
    const head = (left + right) / 2;
    const cx = Math.min(canvas.width - width / 2 - 12, Math.max(width / 2 + 12, head));
    const tail = 22;
    const y = Math.max(name ? 24 : 10, top - height - tail - 6);
    const ink = '#2b2118';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = ink;
    ctx.fillStyle = '#fbf4e2';
    ctx.shadowColor = 'rgba(43,33,24,0.25)';
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.roundRect(cx - width / 2, y, width, height, 20);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
    // The tail leans from under the bubble toward the speaker's head; it is filled after the stroke so no line crosses its root.
    const tx = Math.min(cx + width / 2 - 34, Math.max(cx - width / 2 + 34, head));
    const tipX = Math.max(tx - 40, Math.min(tx + 40, head));
    ctx.beginPath();
    ctx.moveTo(tx - 13, y + height - 1.5);
    ctx.lineTo(tipX, y + height + tail);
    ctx.lineTo(tx + 13, y + height - 1.5);
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(tx - 11.5, y + height - 4, 23, 3);
    if (name) {
      ctx.font = 'bold 16px Georgia, serif';
      const tw = ctx.measureText(name).width + 24;
      const tagX = cx - width / 2 + 16;
      ctx.fillStyle = this.speech.who === this.data.world.hero.key ? '#c9774a' : '#5f8f8a';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(tagX, y - 14, tw, 26, 10);
      ctx.fill();
      ctx.stroke();
      ctx.fillStyle = '#fbf4e2';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, tagX + 12, y - 1);
    }
    ctx.font = '22px Georgia, serif';
    ctx.fillStyle = ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, cx, y + (name ? 18 : 12) + i * 28));
    ctx.restore();
  }

  /** The narrator (the intro) speaks in a caption across the top of the frame, not from anyone's mouth. */
  private drawCaption(text: string) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.font = 'italic 23px Georgia, serif';
    const max = Math.min(820, canvas.width - 80);
    const lines: string[] = [];
    for (const word of text.split(/\s+/)) {
      const last = lines[lines.length - 1];
      if (last && ctx.measureText(`${last} ${word}`).width < max - 56) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 56;
    const height = lines.length * 30 + 26;
    const x = (canvas.width - width) / 2;
    const y = 22;
    ctx.fillStyle = 'rgba(251,244,226,0.95)';
    ctx.strokeStyle = '#2b2118';
    ctx.lineWidth = 2.5;
    ctx.shadowColor = 'rgba(43,33,24,0.3)';
    ctx.shadowOffsetY = 4;
    ctx.beginPath();
    ctx.roundRect(x, y, width, height, 16);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.stroke();
    // A fold mark at each end, like a pinned paper strip.
    ctx.fillStyle = '#c9774a';
    for (const cx of [x + 16, x + width - 16]) {
      ctx.beginPath();
      ctx.arc(cx, y + 14, 4, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#2b2118';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, canvas.width / 2, y + 14 + i * 30));
    ctx.restore();
  }

  private drawGrid() {
    const { g, grid, hots } = this.place;
    ctx.save();
    ctx.fillStyle = 'rgba(80,255,140,0.22)';
    for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) if (grid.isOpen(c, r)) ctx.fillRect(c * g.cell, r * g.cell, g.cell - 1, g.cell - 1);
    ctx.strokeStyle = '#ff5050';
    ctx.lineWidth = 2;
    for (const o of g.occluders) {
      ctx.beginPath();
      const line = o.floor?.length ? o.floor : [[o.box[0], o.baseY], [o.box[2], o.baseY]];
      line.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.stroke();
    }
    ctx.fillStyle = '#ffd34d';
    for (const h of hots) ctx.fillRect(h.thing.stand[0] - 4, h.thing.stand[1] - 4, 8, 8);
    ctx.strokeStyle = 'rgba(120,180,255,0.7)';
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(0, g.scale.horizonY);
    ctx.lineTo(g.frame.width, g.scale.horizonY);
    ctx.stroke();
    ctx.restore();
  }
}

/** Poses a rig's parts into its own canvas, back to front, in the figure's coordinates. */
function drawRig(fig: NonNullable<Figure['rig']>, at: ReturnType<typeof pose>, phase = 0, walking = false) {
  const c = fig.canvas.getContext('2d')!;
  c.clearRect(0, 0, fig.canvas.width, fig.canvas.height);
  const sheet = fig.rig.sheet;
  if (sheet && fig.sheet) {
    // The walk drawn ahead (src/scene/warp.ts): one cell, scaled back up to the rig's size.
    const i = sheetCell(sheet, phase, walking);
    const [cw, ch] = sheet.cell;
    c.drawImage(fig.sheet, (i % sheet.cols) * cw, Math.floor(i / sheet.cols) * ch, cw, ch, 0, 0, fig.canvas.width, fig.canvas.height);
    return;
  }
  for (const part of fig.rig.parts) {
    const img = fig.parts.get(part.name);
    const p = at[part.name];
    if (!img || !p) continue;
    c.save();
    c.translate(p.to[0], p.to[1]);
    c.rotate(p.turn);
    c.translate(-p.from[0], -p.from[1]);
    c.drawImage(img, part.at[0], part.at[1]);
    c.restore();
  }
}

/**
 * A figure (one image, or a sprite sheet of cells) with its clothes in a player's colour: everything but skin and the
 * head (the top fifth of each figure, so hair and face stay) takes the colour's hue, keeping its own light and shade.
 */
function dressSheet(img: HTMLImageElement, colour: string, grid?: SpriteInfo): HTMLImageElement {
  const c = Object.assign(document.createElement('canvas'), { width: img.width, height: img.height });
  const cx = c.getContext('2d', { willReadFrequently: true })!;
  cx.drawImage(img, 0, 0);
  const data = cx.getImageData(0, 0, c.width, c.height);
  const px = data.data;
  const [hp, sp] = hsl(parseInt(colour.slice(1, 3), 16), parseInt(colour.slice(3, 5), 16), parseInt(colour.slice(5, 7), 16));
  const rows = grid ? grid.rows : 1;
  const ch = c.height / rows;
  // Where the head ends in a cell: a fifth of the figure down from its top (feet at feetAt, about px tall).
  const headEnd = grid ? ch * grid.feetAt - grid.px * 0.8 : 0;
  // A plain cut-out fills its image: its head is the top fifth of what is not transparent.
  let top = 0;
  if (!grid) {
    outer: for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) if (px[(y * c.width + x) * 4 + 3] > 40) { top = y; break outer; }
  }
  const plainHead = top + (c.height - top) * 0.2;
  for (let y = 0; y < c.height; y++) {
    const inCell = y % ch;
    if (grid ? inCell < headEnd : y < plainHead) continue;
    for (let x = 0; x < c.width; x++) {
      const i = (y * c.width + x) * 4;
      if (px[i + 3] < 8) continue;
      const [h, s, l] = hsl(px[i], px[i + 1], px[i + 2]);
      // Skin (warm, a little saturated, not too dark or bright) keeps its colour: hands, arms, bare legs.
      if (h <= 50 && s >= 0.18 && s <= 0.8 && l >= 0.28 && l <= 0.88) continue;
      const [r, g, b] = rgb(hp, Math.max(0.45, sp * 0.85), 0.16 + l * 0.62);
      px[i] = px[i] * 0.15 + r * 0.85;
      px[i + 1] = px[i + 1] * 0.15 + g * 0.85;
      px[i + 2] = px[i + 2] * 0.15 + b * 0.85;
    }
  }
  cx.putImageData(data, 0, 0);
  return c as unknown as HTMLImageElement;
}

/** Hue in degrees, saturation and lightness 0..1. */
function hsl(r: number, g: number, b: number): [number, number, number] {
  [r, g, b] = [r / 255, g / 255, b / 255];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

function rgb(h: number, s: number, l: number): [number, number, number] {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** The mask's edge pixels inside the box (plus 2 px), as a light line to draw over the painting. */
function edgeCanvas(mask: Bits, frameW: number, [x0, y0, x1, y1]: Rect): HTMLCanvasElement {
  const w = x1 - x0 + 4;
  const h = y1 - y0 + 4;
  const c = Object.assign(document.createElement('canvas'), { width: w, height: h });
  const cx = c.getContext('2d')!;
  const img = cx.createImageData(w, h);
  const frameH = mask.bits.length / frameW;
  const at = (x: number, y: number) => x >= 0 && y >= 0 && x < frameW && y < frameH && mask.bits[y * frameW + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const fx = x0 + x - 2;
      const fy = y0 + y - 2;
      if (!at(fx, fy)) continue;
      // Two pixels thick: set where something within 2 px is outside the mask.
      if (at(fx - 2, fy) && at(fx + 2, fy) && at(fx, fy - 2) && at(fx, fy + 2)) continue;
      const i = (y * w + x) * 4;
      img.data.set([255, 236, 180, 230], i);
    }
  }
  cx.putImageData(img, 0, 0);
  return c;
}

/** A plain stand-in person, drawn facing right with feet at the origin. */
function drawFigure(c: CanvasRenderingContext2D, h: number, colour: string) {
  c.fillStyle = colour;
  c.strokeStyle = '#f2e6c9';
  c.lineWidth = Math.max(1, h * 0.012);
  const body = new Path2D();
  body.ellipse(0, -h * 0.9, h * 0.075, h * 0.09, 0, 0, Math.PI * 2);
  body.roundRect(-h * 0.11, -h * 0.79, h * 0.22, h * 0.42, h * 0.05);
  body.roundRect(-h * 0.09, -h * 0.4, h * 0.075, h * 0.4, h * 0.02);
  body.roundRect(h * 0.015, -h * 0.4, h * 0.075, h * 0.4, h * 0.02);
  c.fill(body);
  c.stroke(body);
}

const game = new Game();
// ?sound=0 plays silent; m mutes.
const mixer = params.get('sound') === '0' ? undefined : new Mixer(game as unknown as Listened, files);
// Children who cannot read can hear answers by navigating with keys or a pad.
game.answers.hear = (text) => {
  if (game.data?.world.audience === 'kids') mixer?.hear(text);
};
/** The scene point under the pointer: canvas pixels, then out of the parallax zoom. */
const toFrame = (e: MouseEvent): Point => {
  const r = canvas.getBoundingClientRect();
  return game.unzoom(((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height);
};

canvas.addEventListener('pointermove', (e) => {
  // A finger has no hover: nothing follows it, and the view does not look around after it.
  if (!game.place || e.pointerType === 'touch') return;
  keyboard = false;
  usePad(false);
  const r = canvas.getBoundingClientRect();
  pointer = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  game.hover = game.thingAt(...toFrame(e));
  // Off the floor (a wall, the sky, the water) the cursor says no, so nobody clicks blind.
  const off = !game.hover && !game.place.grid.walkable(...game.floorAt(...toFrame(e)));
  canvas.style.cursor = hideCursor || game.holding ? 'none' : game.hover ? 'pointer' : off ? 'not-allowed' : 'default';
  game.bag.point(e.clientX, e.clientY, game.hover?.thing.key.replace(/-/g, ' '));
  document.getElementById('hover')!.textContent = game.hover ? game.hover.thing.key.replace(/-/g, ' ') : '';
});
// A finger holds where a mouse right-clicks: a long press looks at a thing, or puts the item in hand back.
let press: { timer: number; fired: boolean; x: number; y: number } | null = null;
canvas.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch' || !game.place) return;
  const at = toFrame(e);
  const p = { fired: false, x: e.clientX, y: e.clientY, timer: 0 };
  p.timer = window.setTimeout(() => {
    p.fired = true;
    if (game.holding) return game.hold(undefined);
    const hot = game.dark === 0 && !game.state.talk ? game.thingAt(...at) : undefined;
    if (hot) void game.use(hot.thing.key, 'look');
  }, LONG_PRESS_MS);
  press = p;
});
canvas.addEventListener('pointermove', (e) => {
  if (press && e.pointerType === 'touch' && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 12) clearTimeout(press.timer);
});
for (const type of ['pointerup', 'pointercancel'] as const) canvas.addEventListener(type, () => press && clearTimeout(press.timer));
canvas.addEventListener('click', (e) => {
  // The tap that ended a long press has done its work.
  if (press?.fired) return void (press = null);
  if (!game.place || game.dark > 0 || game.state.ending) return;
  // A click away from the answers says goodbye and goes where it points.
  game.leave();
  // A double click hurries the walk the first click set off; a single one walks.
  if (e.detail >= 2 && game.hero.path.length) return void (game.hero.run = true);
  game.hero.run = false;
  const [x, y] = toFrame(e);
  const hot = game.thingAt(x, y);
  if (hot) void game.use(hot.thing.key);
  else void game.walkTo(...game.floorAt(x, y));
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // With an item in hand, a right click puts it back in the bag.
  if (game.holding) return game.hold(undefined);
  const hot = game.place && game.dark === 0 ? game.thingAt(...toFrame(e)) : undefined;
  if (hot) void game.use(hot.thing.key, 'look');
});
canvas.addEventListener('mouseleave', () => (pointer = null));
// The keyboard: WASD or the arrows walk, E, Space or Enter use the nearest thing in reach (it lights up),
// 1 to 9 take an item from the bag when nobody is talking (in a conversation they pick an answer; Esc or a click away leaves it).
const DIRS: Record<string, Point> = { w: [0, -1], arrowup: [0, -1], s: [0, 1], arrowdown: [0, 1], a: [-1, 0], arrowleft: [-1, 0], d: [1, 0], arrowright: [1, 0] };
const keys = new Set<string>();
let keyboard = false;
const free = () => game.place && game.dark === 0 && !game.state.talk && !game.state.ending;
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'shift') keys.add(k);
  // In a talk the keys go through the answers: arrows or WASD light one, E, Space or Enter say it, Esc says goodbye.
  if (game.state.talk && !game.state.ending) {
    if (k in DIRS) {
      e.preventDefault();
      game.answers.move(DIRS[k][0] + DIRS[k][1] < 0 ? -1 : 1, true);
      return;
    }
    if (k === 'e' || k === ' ' || k === 'enter') {
      e.preventDefault();
      game.answers.pick();
      return;
    }
  }
  if (k in DIRS) {
    e.preventDefault();
    keys.add(k);
    keyboard = true;
    return;
  }
  if (k === 'g') game.grid = !game.grid;
  if (k === 'm') mixer?.toggleMute();
  if (k === 'escape' && !game.leave()) game.hold(undefined);
  if ((k === 'e' || k === ' ' || k === 'enter') && free()) {
    e.preventDefault();
    const hot = game.within();
    if (hot) void game.use(hot.thing.key);
  }
  const n = Number(k);
  if (n >= 1 && n <= 9 && free() && game.state.items[n - 1]) game.hold(game.holding === game.state.items[n - 1] ? undefined : game.state.items[n - 1]);
});
addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
addEventListener('blur', () => keys.clear());

// Gamepads, for a child who cannot use keys or a touchpad yet: the stick or d-pad walks, A uses the lit thing (or
// picks the lit answer, or plays again at the end), B puts the item in hand back (or looks), the other face buttons and
// the shoulders go through the bag one item at a time and back to empty hands. Any pad steers; several at once all do.
let pad: PadFrame = { dir: null, pressed: [], pads: 0 };
const soundless = document.getElementById('soundless')!;
const KEY_HINT = document.querySelector('#bar .hint')?.textContent ?? '';
/** Pad mode lights the answer and Play again cards and shows the pad's hints; the mouse moving ends it. */
function usePad(on: boolean) {
  if (document.body.classList.contains('pad') === on) return;
  document.body.classList.toggle('pad', on);
  const hint = document.querySelector('#bar .hint');
  if (hint) hint.textContent = on ? words.padHint : KEY_HINT;
}
// ?pads=turns: the pads take turns (see Turns); ?turn=60 sets the seconds of a turn.
const turns = params.get('pads') === 'turns' ? new Turns(Number(params.get('turn')) || 60) : undefined;
// ?pads=party: every pad has its own hero on screen (Game.party); the first pad pressed steers the hero there was.
const partyMode = params.get('pads') === 'party';
/** Each pad's hero in party mode, by gamepad index, in the order they joined (player 1, 2, ...). */
const bodies = new Map<number, Body>();
/** The party member whose nearest thing is lit: the one that moved or pressed last. */
let focus: Body | undefined;
let talked = false;
let talkEnded = false;
/** The turn badge (whose turn, in the player's colour) and the hand-over card when it passes. */
function showTurn(index: number | undefined, handOver: boolean) {
  const badge = document.getElementById('player')!;
  const many = !!turns && turns.connected().length > 1 && index !== undefined;
  badge.hidden = !many;
  if (!many) return;
  const n = turns!.player(index!);
  const colour = PLAYER_COLOURS[(n - 1) % PLAYER_COLOURS.length];
  badge.style.setProperty('--player', colour);
  badge.textContent = `${words.player} ${n}`;
  if (handOver) {
    const card = document.getElementById('handover')!;
    card.style.setProperty('--player', colour);
    card.textContent = `${words.player} ${n}`;
    card.hidden = false;
    card.animate([{ opacity: 0, transform: 'translate(-50%, -50%) scale(.6)' }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1.05)', offset: 0.2 }, { opacity: 1, transform: 'translate(-50%, -50%) scale(1)', offset: 0.8 }, { opacity: 0, transform: 'translate(-50%, -50%) scale(1)' }], { duration: 2600, easing: 'ease-out' }).finished.then(() => (card.hidden = true), () => undefined);
  }
}
function padInput() {
  if (partyMode) return partyInput();
  let only: number | undefined;
  if (turns) {
    const now = performance.now();
    const before = turns.active;
    // A turn passes when a conversation has ended, or its time is up, but never mid-line, mid-talk or mid-walk.
    const talking = !!game.state?.talk;
    if (talked && !talking) talkEnded = true;
    talked = talking;
    const calm = free() && !game.speech && !game.hero?.path.length;
    if (calm && (talkEnded || turns.due(now))) {
      turns.pass(now);
      talkEnded = false;
    }
    only = turns.current(now);
    if (only !== before || ((turns.connected().length > 1) === document.getElementById('player')!.hidden)) showTurn(only, before !== undefined && only !== before);
    // Each player plays their own drawn hero, when the children drew one each.
    if (only !== before && only !== undefined && game.data?.players?.length) game.hero.figure = game.playerFigure(turns.player(only));
    if (only === undefined) return void (pad = { dir: null, pressed: [], pads: 0 });
  }
  pad = readPads(only);
  if (!pad.dir && !pad.pressed.length) return;
  turns?.touched(performance.now());
  woke();
  if (game.place) for (const b of pad.pressed) padPress(b, game.hero);
}

/** Any pad input: pad mode on, the nearest thing lit, and the sound started where the browser allows it. */
function woke() {
  usePad(true);
  keyboard = true;
  // A pad press is not a gesture that unlocks sound everywhere, but where it is allowed this starts it.
  mixer?.resume();
}

/** One press from the pad steering `body`: at the end, in a talk (only the hero's player answers), or in play. */
function padPress(b: PadButton, body: Body) {
  if (game.state.ending) {
    if (b === 'use' || b === 'start') document.querySelector<HTMLButtonElement>('#ending .again')?.click();
  } else if (game.state.talk) {
    if (body !== game.hero) return;
    if (b === 'up' || b === 'left' || b === 'prev') game.answers.move(-1);
    if (b === 'down' || b === 'right' || b === 'next') game.answers.move(1);
    if (b === 'use') game.answers.pick();
    if (b === 'back') game.leave();
  } else if (free()) {
    const hot = game.within(body);
    // Using or looking at something makes this player's hero the one the story follows, unless the hero is still busy
    // with a walk-and-use of its own.
    const act = (verb?: Verb) => {
      if (!hot || (game.busy && body !== game.hero)) return;
      game.lead(body);
      void game.use(hot.thing.key, verb);
    };
    if (b === 'use') act();
    if (b === 'back') {
      if (game.holding) game.hold(undefined);
      else act('look');
    }
    if (b === 'next' || b === 'prev') {
      // Empty hands, then each item, then empty hands again.
      const ring = [undefined, ...game.state.items];
      const i = ring.indexOf(game.holding);
      game.hold(ring[(i + (b === 'next' ? 1 : -1) + ring.length) % ring.length]);
    }
  }
}

/** Party mode: each connected pad steers its own hero; a new pad brings a new hero in the next colour. */
function partyInput() {
  pad = { dir: null, pressed: [], pads: 0 };
  for (const [index, f] of readEachPad()) {
    if (!f.dir && !f.pressed.length) continue;
    if (!game.place) continue;
    let body = bodies.get(index);
    if (!body) {
      const colour = PLAYER_COLOURS[bodies.size % PLAYER_COLOURS.length];
      // The first pad takes the hero already there; each next one a new hero beside it.
      body = bodies.size === 0 ? Object.assign(game.hero, { colour }) : game.join(colour, game.playerFigure(bodies.size + 1));
      bodies.set(index, body);
    }
    woke();
    focus = body;
    if (f.dir) walkStep(body, f.dir[0], f.dir[1]);
    for (const b of f.pressed) padPress(b, body);
  }
}

/** Held direction keys (or a pad) walk the hero a short step at a time; along a wall it slides the way that is open. */
function steer() {
  if (keyboard && game.place) {
    const near = game.within(focus ?? game.hero);
    if (near !== game.hover) {
      game.hover = near;
      document.getElementById('hover')!.textContent = near ? near.thing.key.replace(/-/g, ' ') : '';
    }
    // With an item in hand, its "Use X on Y" hangs over the lit thing, as it would under a mouse.
    const r = near && game.holding ? game.pageRect(near.thing.key) : undefined;
    if (game.holding) game.bag.point(r ? r.left + r.width / 2 : -300, r ? r.top : -300, near?.thing.key.replace(/-/g, ' '));
  }
  if ((!keys.size && !pad.dir) || !free()) return void headings.delete(game.hero);
  let [dx, dy] = pad.dir ?? [0, 0];
  for (const k of keys) if (k in DIRS) [dx, dy] = [dx + DIRS[k][0], dy + DIRS[k][1]];
  game.hero.run = keys.has('shift');
  if (dx || dy) walkStep(game.hero, dx, dy);
}

/** The way each walker was last sent, so a held direction does not restart its step every frame. */
const headings = new Map<Body, string>();
/** Sends a walker one short step toward (dx, dy), sliding along walls and through gaps (WalkGrid.steer). */
function walkStep(hero: Body, dx: number, dy: number) {
  if (!free()) return void headings.delete(hero);
  const dir = `${dx},${dy}`;
  // A new step only near the end of the last one, unless the direction changed.
  const left = hero.path.length ? Math.hypot(hero.path.at(-1)![0] - hero.x, hero.path.at(-1)![1] - hero.y) : 0;
  const step = game.place.g.cell * 0.8;
  if (dir === headings.get(hero) && left > step * 0.4) return;
  headings.set(hero, dir);
  const to = game.place.grid.steer([hero.x, hero.y], [dx, dy], step);
  if (to) void game.walkTo(...to, hero);
}
if (capture) document.getElementById('bar')!.style.display = 'none';

// For scripts and recorders: drive the hero and listen to what happens.
// diorama.sound.record() / stopRecording() give a recorder the page's audio.
Object.assign(window, { diorama: Object.assign(game, { sound: mixer }) });

let last = performance.now();
const frame = (now: number) => {
  requestAnimationFrame(frame);
  fitHud(canvas);
  if (!game.place) return;
  // Capture mode steps a fixed 1/60 s per frame so a recorded run is the same every time.
  const dt = capture ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
  last = now;
  padInput();
  // A pad press cannot start the sound; while it is held back, the page asks for one click (pads only).
  soundless.hidden = !(mixer && mixer.ctx.state === 'suspended' && document.body.classList.contains('pad'));
  if (!soundless.hidden && soundless.textContent !== words.sound) soundless.textContent = words.sound;
  steer();
  game.update(dt);
  mixer?.update();
  game.render();
};
requestAnimationFrame(frame);
await game.start();

/** Turns angle `a` toward `b` by at most `step` radians, the short way round. */
function turnToward(a: number, b: number, step: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + Math.max(-step, Math.min(step, d));
}

function union(a: Rect, b?: Rect): Rect {
  return b ? [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])] : a;
}

/** One reusable scratch canvas for the idle bend: every standing person is drawn into it, then laid out in slices. */
let idleScratch: HTMLCanvasElement | undefined;
let idleBent: HTMLCanvasElement | undefined;
/** Who painted the scratch last (and its half width), so a second draw of the same person this frame reuses it. */
let idleOwner: { token: object; density: number; half: number } | undefined;

/**
 * Draws a standing figure (paint, feet at the origin) bent from its feet: each horizontal slice shifts sideways by
 * sway x height x u^1.7 (u = height above the feet as a share of the figure), so the feet stay planted and the head
 * moves most; the slices above the hips lift by up to `lift` x height (the breath), and the head nods by `nod`.
 */
function idleWarp(c: CanvasRenderingContext2D, paint: (c: CanvasRenderingContext2D) => number, token: object, h: number, density: number, sway: number, lift: number, nod: number): number {
  const W = Math.ceil(h * 1.6 * density), H = Math.ceil(h * 1.35 * density);
  const foot = Math.ceil(h * 0.15 * density);
  if (!(W >= 8 && H >= 8 && W <= 4096 && H <= 4096)) return paint(c);
  const scratch = (idleScratch ??= document.createElement('canvas'));
  const bent = (idleBent ??= document.createElement('canvas'));
  let half: number;
  if (idleOwner?.token === token && idleOwner.density === density) half = idleOwner.half;
  else {
    for (const cv of [scratch, bent]) if (cv.width < W || cv.height < H) Object.assign(cv, { width: Math.max(cv.width, W), height: Math.max(cv.height, H) });
    const s = scratch.getContext('2d')!;
    s.setTransform(1, 0, 0, 1, 0, 0);
    s.clearRect(0, 0, W, H);
    s.setTransform(density, 0, 0, density, W / 2, H - foot);
    half = paint(s);
    s.setTransform(1, 0, 0, 1, 0, 0);
    // The slices go into a second canvas, so the person's light and edge filters run once, on the whole figure.
    const b = bent.getContext('2d')!;
    b.setTransform(1, 0, 0, 1, 0, 0);
    b.clearRect(0, 0, W, H);
    const slices = 28;
    const band = H / slices;
    const smooth = (a: number, z: number, v: number) => { const q = Math.max(0, Math.min(1, (v - a) / (z - a))); return q * q * (3 - 2 * q); };
    for (let i = 0; i < slices; i++) {
      const top = i * band;
      const mid = top + band / 2;
      const u = Math.max(0, (H - foot - mid) / density / h);
      const dx = (sway * Math.pow(u, 1.7) + nod * smooth(0.82, 1, u)) * h * density;
      const dy = -lift * h * density * smooth(0.45, 0.78, u);
      // A breath stretches the torso: a slice that lifts more than the one under it reaches down to it, so no gap opens.
      const stretch = lift * h * density * (smooth(0.45, 0.78, u) - smooth(0.45, 0.78, u - band / density / h));
      b.drawImage(scratch, 0, top, W, band + 1, dx, top + dy, W, band + 1 + stretch);
    }
    idleOwner = { token, density, half };
  }
  c.drawImage(bent, 0, 0, W, H, -W / 2 / density, -(H - foot) / density, W / density, H / density);
  return half + Math.abs(sway) * h;
}
