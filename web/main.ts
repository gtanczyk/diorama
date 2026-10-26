// The browser runtime: a painted place, a hero who walks on its grid, hides behind things and uses them.
import { hiddenRuns, personPx, type GeoThing, type Geometry, type Occluder } from '../src/play/geometry.ts';
import { WalkGrid, type Point } from '../src/play/path.ts';
import { actions, apply, hiddenThings, pickInteraction, startState, type Action, type State } from '../src/story/engine.ts';
import type { Story } from '../src/story/schema.ts';
import type { Place as PlaceSpec, World } from '../src/world/schema.ts';

type Data = {
  slug: string;
  world: World;
  places: Record<string, { geometry: Geometry | null; painting: string | null; issue?: string }>;
  /** Figure image per hero or NPC key. */
  cast: Record<string, string>;
  story: Story | null;
};

type Bits = { bits: Uint8Array; area: number };
type Hot = { thing: GeoThing; spec?: PlaceSpec['things'][number]; mask?: Bits; area: number; plate?: HTMLImageElement };
type Cut = { occ: Occluder; canvas: HTMLCanvasElement; x0: number; y0: number };

type Place = {
  key: string;
  spec: PlaceSpec;
  g: Geometry;
  grid: WalkGrid;
  bg?: HTMLImageElement;
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
const files = (p: string) => `/files/${p}`;

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
  private figures = new Map<string, HTMLImageElement>();
  hero = { x: 0, y: 0, path: [] as Point[], facing: 1, phase: 0, img: undefined as HTMLImageElement | undefined };
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
  private pending: (() => void) | null = null;
  private listeners: Array<(event: Events, detail: object) => void> = [];
  frame = 0;

  async start() {
    this.data = await (await fetch('/api/world')).json();
    await Promise.all(Object.entries(this.data.cast).map(async ([key, src]) => {
      const img = await loadImage(files(src)).catch(() => undefined);
      if (img) this.figures.set(key, img);
    }));
    this.hero.img = this.figures.get(this.data.world.hero.key);
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
    const cuts = await Promise.all(g.occluders.map(async (occ) => this.cut(occ, bg, await shared(occ.mask), g)));
    const place: Place = { key, spec, g, grid: new WalkGrid(g), bg, light: bg && lightMap(bg, g.frame.width, g.frame.height), hots, cuts: cuts.filter((c): c is Cut => !!c), byKey: new Map(g.occluders.map((o) => [o.key, o])) };
    this.cache.set(key, place);
    return place;
  }

  /** The painting's own pixels of an occluder, to put back over the hero where he stands behind it. */
  private cut(occ: Occluder, bg: HTMLImageElement | undefined, mask: Bits | undefined, g: Geometry): Cut | undefined {
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
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!mask.bits[(y0 + y) * g.frame.width + x0 + x]) img.data[(y * w + x) * 4 + 3] = 0;
      cx.putImageData(img, 0, 0);
    }
    return { occ, canvas: c, x0, y0 };
  }

  /** Enters a place, at the thing that leads back to where the hero came from, or at its start. */
  async enter(key: string, from?: string) {
    const place = await this.load(key);
    this.place = place;
    const back = from ? place.spec.exits.find((e) => e.to === from) : undefined;
    const arrive = back ? place.g.things.find((t) => t.key === back.via)?.stand : undefined;
    [this.hero.x, this.hero.y] = arrive ?? place.g.start;
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
    const seconds = 2.2 + text.length * 0.045;
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

  /** Things of this place the story has carried off: drawn from their clean plate, not clickable, hiding no one. */
  gone(): Set<string> {
    const story = this.data.story;
    if (!story) return new Set();
    return new Set(hiddenThings(story, this.state).filter((h) => h.place === this.place.key).map((h) => h.thing));
  }

  thingAt(x: number, y: number): Hot | undefined {
    const g = this.place.g;
    const gone = this.gone();
    for (const hot of this.place.hots) {
      if (gone.has(hot.thing.key)) continue;
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
    let budget = personPx(this.place.g, hero.y) * 0.85 * dt;
    while (budget > 0 && hero.path.length) {
      const [tx, ty] = hero.path[0];
      const d = Math.hypot(tx - hero.x, ty - hero.y);
      if (Math.abs(tx - hero.x) > 1) hero.facing = tx > hero.x ? 1 : -1;
      if (d <= budget) {
        [hero.x, hero.y] = [tx, ty];
        hero.path.shift();
        budget -= d;
      } else {
        hero.x += ((tx - hero.x) / d) * budget;
        hero.y += ((ty - hero.y) / d) * budget;
        budget = 0;
      }
      hero.phase += dt * 9;
      if (!hero.path.length) {
        hero.phase = 0;
        this.emit('arrive', { x: hero.x, y: hero.y });
        this.pending?.();
      }
    }
  }

  render() {
    const { g, bg } = this.place;
    const W = g.frame.width;
    const H = g.frame.height;
    if (bg) ctx.drawImage(bg, 0, 0, W, H);
    else {
      ctx.fillStyle = '#20232a';
      ctx.fillRect(0, 0, W, H);
    }
    const gone = this.gone();
    for (const hot of this.place.hots) {
      if (!hot.plate || !gone.has(hot.thing.key)) continue;
      // The plate differs from the painting only near the thing, so its grown box is enough.
      const [x0, y0, x1, y1] = hot.thing.box.map((v, i) => (i < 2 ? Math.max(0, v - 16) : v + 16));
      ctx.drawImage(hot.plate, x0, y0, x1 - x0, y1 - y0, x0, y0, x1 - x0, y1 - y0);
    }
    // Everyone is drawn far to near, and each one gets the things in front of them put back.
    const npcs = this.place.hots.filter((h) => (h.spec?.role ?? h.thing.role) === 'npc' && !h.mask);
    const people = [...npcs.map((h) => ({ npc: h, y: h.thing.box[3] })), { npc: undefined, y: this.hero.y }].sort((a, b) => a.y - b.y);
    let rect: [number, number, number, number] = [0, 0, 0, 0];
    for (const who of people) {
      if (who.npc) {
        const [x0, , x1, y1] = who.npc.thing.box;
        const x = (x0 + x1) / 2;
        const img = this.figures.get(who.npc.thing.key);
        this.occlude(this.drawPerson(x, y1, x < this.hero.x ? 1 : -1, 0, img, '#4b3b2a'), y1, gone);
      } else {
        rect = this.drawPerson(this.hero.x, this.hero.y, this.hero.facing, this.hero.phase, this.hero.img, '#2b2733');
        this.occlude(rect, this.hero.y, gone);
      }
    }
    if (this.grid) this.drawGrid();
    this.drawSpeech(rect);
    if (this.hover && !capture) {
      ctx.strokeStyle = '#ffe9a8aa';
      ctx.lineWidth = 2;
      const [x0, y0, x1, y1] = this.hover.thing.box;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
    }
    if (this.dark > 0) {
      ctx.fillStyle = `rgba(0,0,0,${this.dark})`;
      ctx.fillRect(0, 0, W, H);
    }
  }

  /** Draws a person with feet at (x, y); returns the box they and their shadow cover. */
  private drawPerson(x: number, y: number, facing: number, phase: number, img: HTMLImageElement | undefined, colour: string): [number, number, number, number] {
    const h = personPx(this.place.g, y);
    const w = img ? (h * img.width) / img.height : h * 0.36;
    const bob = Math.abs(Math.sin(phase)) * h * 0.025;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.42, Math.max(2, h * 0.035), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.filter = `brightness(${this.lightAt(x, y - h * 0.5).toFixed(2)})`;
    ctx.translate(x, y - bob);
    ctx.rotate(Math.sin(phase) * 0.035);
    ctx.scale(facing, 1);
    if (img) ctx.drawImage(img, -w / 2, -h, w, h);
    else drawFigure(h, colour);
    ctx.restore();
    return [x - w / 2 - 2, y - h - bob - 2, x + w / 2 + 2, y + Math.max(3, h * 0.04)];
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
  private occlude([left, top, right, bottom]: [number, number, number, number], feetY: number, gone: Set<string>) {
    const support = (k: string) => this.place.byKey.get(k);
    for (const cut of this.place.cuts) {
      if (cut.occ.thing && gone.has(cut.occ.thing)) continue;
      const [bx0, by0, bx1, by1] = cut.occ.box;
      if (bx1 < left || bx0 > right || by1 < top || by0 > bottom) continue;
      const y0 = Math.max(top, cut.y0);
      const y1 = Math.min(bottom, cut.y0 + cut.canvas.height);
      if (y1 <= y0) continue;
      for (const [a, b] of hiddenRuns(cut.occ, left, right, feetY, support)) {
        const xa = Math.max(a, cut.x0);
        const xb = Math.min(b, cut.x0 + cut.canvas.width);
        if (xb > xa) ctx.drawImage(cut.canvas, xa - cut.x0, y0 - cut.y0, xb - xa, y1 - y0, xa, y0, xb - xa, y1 - y0);
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
const toFrame = (e: MouseEvent): Point => {
  const r = canvas.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * canvas.width, ((e.clientY - r.top) / r.height) * canvas.height];
};

canvas.addEventListener('mousemove', (e) => {
  if (!game.place) return;
  game.hover = game.thingAt(...toFrame(e));
  canvas.style.cursor = hideCursor ? 'none' : game.hover ? 'pointer' : 'default';
  document.getElementById('hover')!.textContent = game.hover ? game.hover.thing.key.replace(/-/g, ' ') : '';
});
canvas.addEventListener('click', (e) => {
  if (!game.place || game.dark > 0 || game.state.talk || game.state.ending) return;
  const [x, y] = toFrame(e);
  const hot = game.thingAt(x, y);
  if (hot) void game.use(hot.thing.key);
  else void game.walkTo(x, y);
});
canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const hot = game.place && game.dark === 0 ? game.thingAt(...toFrame(e)) : undefined;
  if (hot) void game.use(hot.thing.key, 'look');
});
addEventListener('keydown', (e) => {
  if (e.key === 'g') game.grid = !game.grid;
});
if (capture) document.getElementById('bar')!.style.display = 'none';

// For scripts and recorders: drive the hero and listen to what happens.
Object.assign(window, { diorama: game });

let last = performance.now();
const frame = (now: number) => {
  requestAnimationFrame(frame);
  if (!game.place) return;
  // Capture mode steps a fixed 1/60 s per frame so a recorded run is the same every time.
  const dt = capture ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  game.render();
};
requestAnimationFrame(frame);
await game.start();
