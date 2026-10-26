// The browser runtime: a painted place, a hero who walks on its grid, hides behind things and uses them.
import { floorYAt, hiddenRuns, personPx, type GeoThing, type Geometry, type Occluder } from '../src/play/geometry.ts';
import { backdropTransforms, backEdge, cardY, flatDisparities, shiftAtDisparity, type Layers, floorPoint, overscan, PARALLAX_PX, pivot, shiftAt, STACK_GAP, stackCards, type Camera, type Parallax } from '../src/play/parallax.ts';
import { WalkGrid, type Point } from '../src/play/path.ts';
import { CYCLE, pose, type PartName, type Rig } from '../src/play/rig.ts';
import { actions, activeChanges, apply, hiddenThings, pickInteraction, startState, type Action, type State } from '../src/story/engine.ts';
import type { Story } from '../src/story/schema.ts';
import type { Place as PlaceSpec, World } from '../src/world/schema.ts';
import { Mixer, type Listened } from './audio.ts';
import type { SoundData } from '../src/play/sound.ts';
import type { Figure3D, ModelInfo } from './hero3d.ts';

type Data = {
  slug: string;
  world: World;
  places: Record<string, { geometry: Geometry | null; painting: string | null; backdrop?: string; layers?: Layers; issue?: string }>;
  /** Figure per hero or NPC key: a cut-out image, and its rig when `diorama cast` could cut it into parts. */
  cast: Record<string, { image: string; rig?: Rig; parts?: string; model?: { dir: string; info: ModelInfo } }>;
  story: Story | null;
  /** Index into story.changes → the painting as it looks once that change holds. */
  changes?: Record<string, string>;
  /** Music, ambience, loops, footsteps and one-shots (diorama sound); without it the page is silent. */
  sound?: SoundData;
};

type Bits = { bits: Uint8Array; area: number };
type Hot = { thing: GeoThing; spec?: PlaceSpec['things'][number]; mask?: Bits; area: number; plate?: HTMLImageElement; outline?: HTMLCanvasElement };
type Rect = [number, number, number, number];
type Figure = { img: HTMLImageElement; rig?: { rig: Rig; parts: Map<PartName, HTMLImageElement>; canvas: HTMLCanvasElement }; model?: Figure3D };
/** y: the floor row the cut stands on, which sets how far it slides with parallax. */
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
  far?: { sky: HTMLImageElement; flats: Array<{ img: HTMLImageElement; box: [number, number, number, number]; d: number }> };
  hots: Hot[];
  cuts: Cut[];
  byKey: Map<string, Occluder>;
  /** Mean luma of the painting per LIGHT_CELL square, to light people like the place around them. */
  light?: { cols: number; rows: number; luma: Float32Array };
};

const LIGHT_CELL = 40;

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

type Events = 'enter' | 'arrive' | 'say' | 'silent' | 'use' | 'exit' | 'ending';
type Verb = 'look' | 'use' | 'take' | 'talk';

function lineChoice(story: Story, state: State, index: number): string {
  const talk = state.talk!;
  return story.dialogues[talk.dialogue].lines.find((l) => l.key === talk.line)?.choices[index]?.text ?? '…';
}

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const params = new URLSearchParams(location.search);
const capture = params.has('capture');
const hideCursor = capture || params.get('cursor') === '0';
// ?parallax=0 turns the diorama sway off, ?parallax=1.5 makes it stronger. Capture runs (QA, the bot) stay flat
// unless they ask for it, since they read frame pixels at painting coordinates. ?sway=1 adds a slow idle drift.
const parallaxScale = Number(params.get('parallax') ?? (capture ? '0' : '1')) || 0;
const sway = params.get('sway') === '1';
// ?track=1: walking along a place, the camera is closer in and pans after the hero, so near things pass faster
// than far ones, like a side-scroller. It only drives the parallax, so a flat place stays as it was.
const track = Number(params.get('track') ?? '0') || 0;
const TRACK_ZOOM = 0.2;
/** The pointer over the canvas, 0..1 across and down; null when it is elsewhere. */
let pointer: { x: number; y: number } | null = null;
// Relative paths, so the same page runs from `diorama play` and from an exported folder.
const files = (p: string) => `files/${p}`;

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`cannot load ${src}`));
    img.src = src;
  });

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

class Game {
  data!: Data;
  place!: Place;
  private cache = new Map<string, Place>();
  private figures = new Map<string, Figure>();
  /** phase counts walk cycles; it only advances with distance walked, so feet keep pace with the floor. */
  hero = { x: 0, y: 0, path: [] as Point[], facing: 1, phase: 0, yaw: Math.PI / 2, figure: undefined as Figure | undefined };
  speech: { text: string; until: number } | null = null;
  state!: State;
  /** The inventory item the next click uses. */
  holding: string | undefined;
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
    await Promise.all(Object.entries(this.data.cast).map(async ([key, cast]) => {
      const img = await loadImage(files(cast.image)).catch(() => undefined);
      if (!img) return;
      const figure: Figure = { img };
      if (cast.rig && cast.parts) {
        const parts = new Map<PartName, HTMLImageElement>();
        await Promise.all(cast.rig.parts.map(async (p) => parts.set(p.name, await loadImage(files(`${cast.parts}/${p.file}`)))));
        const canvas = Object.assign(document.createElement('canvas'), { width: cast.rig.size[0], height: cast.rig.size[1] });
        figure.rig = { rig: cast.rig, parts, canvas };
      }
      // A 3D figure needs WebGL; without it (or if the model fails) the 2D rig or cut-out stays.
      if (cast.model && params.get('model') !== '0') {
        const dir = cast.model.dir;
        figure.model = await import('./hero3d.ts').then(({ Figure3D }) => Figure3D.load(cast.model!.info, (f) => files(`${dir}/${f}`)))
          .catch((e) => (console.warn(`no 3D figure for ${key}:`, e), undefined));
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
      drawRig(rig, pose(rig.rig, i / frames, i < frames));
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
      const sky = await loadImage(files(entry.layers.sky)).catch(() => undefined);
      const imgs = await Promise.all(entry.layers.flats.map((f) => loadImage(files(f.file)).catch(() => undefined)));
      const ds = flatDisparities(g, edge, imgs.length);
      if (sky && imgs.every(Boolean)) far = { sky, flats: entry.layers.flats.map((f, i) => ({ img: imgs[i]!, box: f.box, d: ds[i] })) };
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
    const place: Place = { key, spec, g, grid: new WalkGrid(g), bg, backdrop, pivot: pivot(g), edge, far, light: bg && lightMap(bg, g.frame.width, g.frame.height), hots, cuts: kept, byKey };
    this.cache.set(key, place);
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
    this.speech = null;
    this.darkTarget = 0;
    canvas.width = place.g.frame.width;
    canvas.height = place.g.frame.height;
    document.getElementById('where')!.textContent = `${this.data.world.title} · ${key}${place.g.preview ? ' (layout preview)' : ''}`;
    this.emit('enter', { place: key, from });
  }

  /** Walks to a point; resolves on arrival, or at once when there is no way there. */
  walkTo(x: number, y: number): Promise<boolean> {
    this.pending?.();
    const path = this.place.grid.route([this.hero.x, this.hero.y], [x, y]);
    this.hero.path = path;
    if (!path.length) return Promise.resolve(false);
    return new Promise((resolve) => {
      this.pending = () => {
        this.pending = null;
        resolve(this.hero.path.length === 0);
      };
    });
  }

  /** Walks to a thing, faces it and clicks it: through an exit, talk to someone, or the verb the story offers. */
  async use(key: string, verb?: Verb) {
    const hot = this.place.hots.find((h) => h.thing.key === key);
    if (!hot) throw new Error(`${this.place.key} has no thing "${key}"`);
    const placeKey = this.place.key;
    const [sx, sy] = this.approach(hot);
    if (!(await this.walkTo(sx, sy)) && Math.hypot(this.hero.x - sx, this.hero.y - sy) > this.place.g.cell * 2) return;
    if (this.place.key !== placeKey) return;
    const [x0, , x1] = hot.thing.box;
    this.hero.facing = (x0 + x1) / 2 >= this.hero.x ? 1 : -1;
    this.emit('use', { thing: key, verb });
    await this.act(this.actionFor(key, hot, verb));
  }

  /** Where to stand to use a thing; beside a person rather than inside them, on the side the hero comes from. */
  private approach(hot: Hot): Point {
    if ((hot.spec?.role ?? hot.thing.role) !== 'npc') return hot.thing.stand;
    const [x0, , x1, y1] = hot.thing.box;
    const x = (x0 + x1) / 2;
    const side = this.hero.x < x ? -1 : 1;
    const gap = personPx(this.place.g, y1) * 0.42;
    for (const s of [side, -side]) {
      const spot = this.place.grid.snap(x + s * gap, y1);
      if (spot && Math.abs(spot[0] - x) > gap * 0.6) return spot;
    }
    return hot.thing.stand;
  }

  /** What a click on a thing means: the exit, the talk, the held item, or the first verb the story answers. */
  private actionFor(key: string, hot: Hot, verb?: Verb): Action {
    if (verb === 'look') return { kind: 'do', thing: key, verb: 'look' };
    if (this.place.spec.exits.some((e) => e.via === key)) return { kind: 'go', via: key };
    const role = hot.spec?.role ?? hot.thing.role;
    if (role === 'npc' && !this.holding) return { kind: 'talk', npc: key };
    if (this.holding) return { kind: 'do', thing: key, verb: 'use', with: this.holding };
    if (verb) return { kind: 'do', thing: key, verb };
    const story = this.data.story;
    const offered = story ? (['take', 'use', 'talk'] as const).find((v) => pickInteraction(story, this.state, { thing: key, verb: v }) >= 0) : undefined;
    return { kind: 'do', thing: key, verb: offered ?? 'look' };
  }

  /** Runs one story action: says its lines, follows a change of place, shows an ending. */
  async act(action: Action) {
    const story = this.data.story;
    const from = this.state.place;
    let say: string[];
    if (story) {
      const step = apply(this.data.world, story, this.state, action);
      this.state = step.state;
      say = step.say;
    } else {
      // Without story.json the world alone answers: exits lead on, everything else is looked at.
      const exit = action.kind === 'go' ? this.place.spec.exits.find((e) => e.via === action.via) : undefined;
      if (exit) this.state = { ...this.state, place: exit.to };
      const key = action.kind === 'do' ? action.thing : action.kind === 'talk' ? action.npc : '';
      say = exit || !key ? [] : [this.place.spec.things.find((t) => t.key === key)?.looks ?? key];
    }
    if (action.kind === 'do' && action.with) this.holding = undefined;
    if (!say.length && action.kind === 'do') say = [this.lookLine(action.thing, action.verb)];
    this.ui();
    for (const line of say) await this.say(line);
    if (this.state.place !== from) {
      this.emit('exit', { from, to: this.state.place });
      await this.fadeOut();
      await this.enter(this.state.place, from);
    }
    if (this.state.ending) this.emit('ending', { ending: this.state.ending });
    this.ui();
  }

  private lookLine(thing: string, verb: string): string {
    const looks = this.place.spec.things.find((t) => t.key === thing)?.looks ?? thing.replace(/-/g, ' ');
    return verb === 'look' ? looks : `Nothing happens. ${looks[0].toUpperCase()}${looks.slice(1)}.`;
  }

  /** Inventory, conversation choices and the ending, as plain HTML over the canvas. */
  ui() {
    const story = this.data.story;
    const inv = document.getElementById('inventory')!;
    inv.replaceChildren(...this.state.items.map((item) => {
      const b = document.createElement('button');
      b.textContent = story?.items.find((i) => i.key === item)?.name ?? item;
      b.className = this.holding === item ? 'held' : '';
      b.onclick = () => {
        this.holding = this.holding === item ? undefined : item;
        this.ui();
      };
      return b;
    }));
    const talk = document.getElementById('talk')!;
    const options = story && this.state.talk ? actions(this.data.world, story, this.state) : [];
    talk.replaceChildren(...options.map((a) => {
      const b = document.createElement('button');
      b.textContent = a.kind === 'choose' ? lineChoice(story!, this.state, a.index) : 'Goodbye.';
      b.onclick = () => void this.act(a);
      return b;
    }));
    const ending = story?.endings.find((e) => e.key === this.state.ending);
    const end = document.getElementById('ending')!;
    end.hidden = !ending;
    if (ending) end.innerHTML = `<h1></h1><p></p>`, (end.querySelector('h1')!.textContent = ending.title), (end.querySelector('p')!.textContent = ending.text);
  }

  say(text: string): Promise<void> {
    // A voiced line stays up until it has been said.
    const voiced = this.data.sound?.lines?.[text]?.seconds ?? 0;
    const seconds = Math.max(2.2 + text.length * 0.045, voiced + 0.5);
    this.speech = { text, until: this.time + seconds };
    this.emit('say', { text });
    return new Promise((resolve) => {
      const done = this.speech;
      const check = () => (this.speech !== done ? resolve() : setTimeout(check, 50));
      check();
    });
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
    for (const hot of this.place.hots) {
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
    if (this.speech && this.time > this.speech.until) {
      this.speech = null;
      this.emit('silent', {});
    }
    this.swayCamera(dt);
    let budget = personPx(this.place.g, hero.y) * 0.85 * dt;
    while (budget > 0 && hero.path.length) {
      const [tx, ty] = hero.path[0];
      const d = Math.hypot(tx - hero.x, ty - hero.y);
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
      if (!hero.path.length) {
        this.emit('arrive', { x: hero.x, y: hero.y });
        this.pending?.();
      }
    }
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
    return cut ? cut.y : (this.place.hots.find((h) => h.thing.key === key)?.thing.box[3] ?? this.place.g.frame.height);
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
    const STRIP = 6;
    for (let x = xa; x < xb; x += STRIP) {
      const w = Math.min(STRIP, xb - x);
      const [sx, sy] = this.cardShift(cut, x + w / 2);
      // A hair wider than the strip, so neighbours that slid apart by a fraction of a px leave no seam.
      ctx.drawImage(cut.canvas, x - cut.x0, ya - cut.y0, Math.min(w + 1, cut.x0 + cut.canvas.width - x), yb - ya, x + sx, ya + sy, Math.min(w + 1, cut.x0 + cut.canvas.width - x), yb - ya);
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
      ctx.rect(x, -1e4, STRIP + 0.5, 2e4);
      ctx.clip();
      this.drawOutline(hot);
      ctx.restore();
    }
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
      // column it slides as one piece with the edge it stands on.
      const edge = this.place.edge;
      for (let c = 0; c < edge.length; c++) {
        const e = Math.round(edge[c]);
        if (e <= h + 1) continue;
        const x0 = c * g.cell;
        const w = Math.min(g.cell + 1, W - x0);
        if (w <= 0) break;
        const [sx, sy] = shiftAt(g, p, e);
        ctx.drawImage(backdrop, x0, h, w, e - h + 1, x0 + sx, h + sy, w, e - h + 1);
      }
      const carded = new Set(this.place.cuts.map((c) => c.occ.thing ?? c.occ.key));
      for (const hot of this.place.hots) {
        // A carried-off card is simply not drawn; a flat thing gets its clean plate, on the floor it lies on.
        if (!hot.plate || !gone.has(hot.thing.key) || carded.has(hot.thing.key)) continue;
        const [x0, y0, x1, y1] = hot.thing.box.map((v, i) => (i < 2 ? Math.max(0, v - 16) : v + 16));
        this.at(hot.thing.box[3], () => ctx.drawImage(hot.plate!, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0));
      }
      for (const cut of this.place.cuts) {
        if (cut.occ.thing && gone.has(cut.occ.thing)) continue;
        this.drawCard(cut);
      }
      // A change belongs to its thing's card, so it slides with it (and its glow with it).
      const story = this.data.story;
      for (const { img, i } of this.changed()) this.at(this.thingY(story!.changes[i].thing), () => ctx.drawImage(img, 0, 0, W, H));
    } else {
      if (bg) ctx.drawImage(bg, 0, 0, W, H);
      // What the story has changed here (a beacon lit): each change is the thing as it looks after, transparent elsewhere.
      for (const { img } of this.changed()) ctx.drawImage(img, 0, 0, W, H);
      for (const hot of this.place.hots) {
        if (!hot.plate || !gone.has(hot.thing.key)) continue;
        // The plate differs from the painting only near the thing, so its grown box is enough.
        const [x0, y0, x1, y1] = hot.thing.box.map((v, i) => (i < 2 ? Math.max(0, v - 16) : v + 16));
        ctx.drawImage(hot.plate, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
      }
    }
    // Everyone is drawn far to near, and each one gets the things in front of them put back.
    const npcs = this.place.hots.filter((h) => (h.spec?.role ?? h.thing.role) === 'npc' && !h.mask);
    const people = [...npcs.map((h) => ({ npc: h, y: h.thing.box[3] })), { npc: undefined, y: this.hero.y }].sort((a, b) => a.y - b.y);
    let rect: Rect = [0, 0, 0, 0];
    const lit = this.hover && !hideCursor ? this.hover : undefined;
    // Under the people, so someone standing in front of a highlighted thing stays in front of its outline.
    if (lit && !this.drawn.some((d) => d.hot === lit)) this.drawLit(lit);
    this.drawn = [];
    for (const who of people) {
      if (who.npc) {
        const [x0, , x1, y1] = who.npc.thing.box;
        const x = (x0 + x1) / 2;
        const drawn = this.drawPerson(x, y1, x < this.hero.x ? 1 : -1, 0, false, this.figures.get(who.npc.thing.key), '#4b3b2a', lit === who.npc, this.shift(y1));
        this.drawn.push({ hot: who.npc, rect: drawn });
        this.occlude(drawn, y1, gone);
      } else {
        rect = this.drawPerson(this.hero.x, this.hero.y, this.hero.facing, this.hero.phase, this.hero.path.length > 0, this.hero.figure, '#2b2733', false, this.shift(this.hero.y), this.hero.yaw);
        this.occlude(rect, this.hero.y, gone);
      }
    }
    if (this.grid) {
      ctx.save();
      if (p) ctx.transform(...(backdropTransforms(g, p).below as [number, number, number, number, number, number]));
      this.drawGrid();
      ctx.restore();
    }
    this.drawSpeech(rect);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.dark > 0) {
      ctx.fillStyle = `rgba(0,0,0,${this.dark})`;
      ctx.fillRect(0, 0, W, H);
    }
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

  /** Draws a person with feet at (x, y); returns the box they and their shadow cover. */
  private drawPerson(x: number, y: number, facing: number, phase: number, walking: boolean, figure: Figure | undefined, colour: string, lit = false, [sx, sy]: [number, number] = [0, 0], yaw = facing * Math.PI / 3): Rect {
    const h = personPx(this.place.g, y);
    const model = figure?.model;
    const rig = model ? undefined : figure?.rig;
    // A rig walks its legs; a plain cut-out (or the stand-in) only bobs and rocks as it slides.
    const bob = rig || model || !walking ? 0 : Math.abs(Math.sin(phase * Math.PI * 2)) * h * 0.025;
    const rock = rig || model || !walking ? 0 : Math.sin(phase * Math.PI * 2) * 0.035;
    let left: number;
    let right: number;
    ctx.save();
    // Parallax: the person slides with the floor under their feet; size and light still come from where they stand.
    ctx.translate(sx, sy);
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x, y, h * 0.16, Math.max(2, h * 0.035), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.filter = `brightness(${this.lightAt(x, y - h * 0.5).toFixed(2)})${lit ? ' drop-shadow(0 0 5px rgba(255,225,150,0.95))' : ''}`;
    ctx.translate(x, y - bob);
    ctx.rotate(rock);
    if (model) {
      // yaw turns the model itself, so no mirroring; feet sit at (width / 2, height * feetAt).
      const c = model.draw({ phase, walking, yaw, px: h });
      ctx.drawImage(c, -c.width / 2, -c.height * model.feetAt);
      [left, right] = [x - c.width / 2, x + c.width / 2];
    } else if (rig) {
      ctx.scale(facing, 1);
      const s = h / rig.rig.height;
      drawRig(rig, pose(rig.rig, phase, walking));
      const [ax, ay] = [rig.rig.hip[0], rig.rig.ground];
      ctx.drawImage(rig.canvas, -ax * s, -ay * s, rig.canvas.width * s, rig.canvas.height * s);
      const reach = Math.max(ax, rig.canvas.width - ax) * s;
      [left, right] = [x - reach, x + reach];
    } else {
      ctx.scale(facing, 1);
      const img = figure?.img;
      const w = img ? (h * img.width) / img.height : h * 0.36;
      if (img) ctx.drawImage(img, -w / 2, -h, w, h);
      else drawFigure(h, colour);
      [left, right] = [x - w / 2, x + w / 2];
    }
    ctx.restore();
    return [left - 2 + sx, y - h * 1.04 - bob - 2 + sy, right + 2 + sx, y + Math.max(3, h * 0.04) + sy];
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

  private drawSpeech([left, top, right]: [number, number, number, number]) {
    if (!this.speech) return;
    ctx.font = '22px Georgia, serif';
    const words = this.speech.text.split(/\s+/);
    const lines: string[] = [];
    for (const word of words) {
      const last = lines[lines.length - 1];
      if (last && ctx.measureText(`${last} ${word}`).width < 460) lines[lines.length - 1] = `${last} ${word}`;
      else lines.push(word);
    }
    const width = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 28;
    const height = lines.length * 28 + 16;
    const cx = Math.min(canvas.width - width / 2 - 8, Math.max(width / 2 + 8, (left + right) / 2));
    const y = Math.max(8, top - height - 14);
    ctx.fillStyle = 'rgba(16,14,12,0.82)';
    ctx.beginPath();
    ctx.roundRect(cx - width / 2, y, width, height, 10);
    ctx.fill();
    ctx.fillStyle = '#f4ecd8';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    lines.forEach((l, i) => ctx.fillText(l, cx, y + 10 + i * 28));
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
function drawRig(fig: NonNullable<Figure['rig']>, at: ReturnType<typeof pose>) {
  const c = fig.canvas.getContext('2d')!;
  c.clearRect(0, 0, fig.canvas.width, fig.canvas.height);
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
function drawFigure(h: number, colour: string) {
  ctx.fillStyle = colour;
  ctx.strokeStyle = '#f2e6c9';
  ctx.lineWidth = Math.max(1, h * 0.012);
  const body = new Path2D();
  body.ellipse(0, -h * 0.9, h * 0.075, h * 0.09, 0, 0, Math.PI * 2);
  body.roundRect(-h * 0.11, -h * 0.79, h * 0.22, h * 0.42, h * 0.05);
  body.roundRect(-h * 0.09, -h * 0.4, h * 0.075, h * 0.4, h * 0.02);
  body.roundRect(h * 0.015, -h * 0.4, h * 0.075, h * 0.4, h * 0.02);
  ctx.fill(body);
  ctx.stroke(body);
}

const game = new Game();
// ?sound=0 plays silent; m mutes.
const mixer = params.get('sound') === '0' ? undefined : new Mixer(game as unknown as Listened, files);
/** The scene point under the pointer: canvas pixels, then out of the parallax zoom. */
const toFrame = (e: MouseEvent): Point => {
  const r = canvas.getBoundingClientRect();
  return game.unzoom(((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height);
};

canvas.addEventListener('mousemove', (e) => {
  if (!game.place) return;
  const r = canvas.getBoundingClientRect();
  pointer = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  game.hover = game.thingAt(...toFrame(e));
  canvas.style.cursor = hideCursor ? 'none' : game.hover ? 'pointer' : 'default';
  document.getElementById('hover')!.textContent = game.hover ? game.hover.thing.key.replace(/-/g, ' ') : '';
});
canvas.addEventListener('click', (e) => {
  if (!game.place || game.dark > 0 || game.state.talk || game.state.ending) return;
  const [x, y] = toFrame(e);
  const hot = game.thingAt(x, y);
  if (hot) void game.use(hot.thing.key);
  else void game.walkTo(...game.floorAt(x, y));
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const hot = game.place && game.dark === 0 ? game.thingAt(...toFrame(e)) : undefined;
  if (hot) void game.use(hot.thing.key, 'look');
});
canvas.addEventListener('mouseleave', () => (pointer = null));
addEventListener('keydown', (e) => {
  if (e.key === 'g') game.grid = !game.grid;
  if (e.key === 'm') mixer?.toggleMute();
});
if (capture) document.getElementById('bar')!.style.display = 'none';

// For scripts and recorders: drive the hero and listen to what happens.
// diorama.sound.record() / stopRecording() give a recorder the page's audio.
Object.assign(window, { diorama: Object.assign(game, { sound: mixer }) });

let last = performance.now();
const frame = (now: number) => {
  requestAnimationFrame(frame);
  if (!game.place) return;
  // Capture mode steps a fixed 1/60 s per frame so a recorded run is the same every time.
  const dt = capture ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
  last = now;
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
