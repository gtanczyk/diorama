// The browser runtime: a painted place, a hero who walks on its grid, hides behind things and uses them.
import { hiddenRuns, personPx, type GeoThing, type Geometry, type Occluder } from '../src/play/geometry.ts';
import { WalkGrid, type Point } from '../src/play/path.ts';
import type { Place as PlaceSpec, World } from '../src/world/schema.ts';

type Data = {
  slug: string;
  world: World;
  places: Record<string, { geometry: Geometry | null; painting: string | null; issue?: string }>;
  hero: string | null;
};

type Bits = { bits: Uint8Array; area: number };
type Hot = { thing: GeoThing; spec?: PlaceSpec['things'][number]; mask?: Bits; area: number };
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
};

type Events = 'enter' | 'arrive' | 'say' | 'silent' | 'use' | 'exit';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const params = new URLSearchParams(location.search);
const capture = params.has('capture');
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
  hero = { x: 0, y: 0, path: [] as Point[], facing: 1, phase: 0, img: undefined as HTMLImageElement | undefined };
  speech: { text: string; until: number } | null = null;
  hover: Hot | undefined;
  grid = params.has('grid');
  /** 0 clear, 1 black; eases toward darkTarget. */
  dark = 0;
  private darkTarget = 0;
  time = 0;
  private pending: (() => void) | null = null;
  private listeners: Array<(event: Events, detail: unknown) => void> = [];

  async start() {
    this.data = await (await fetch('/api/world')).json();
    if (this.data.hero) this.hero.img = await loadImage(files(this.data.hero)).catch(() => undefined);
    await this.enter(params.get('place') ?? this.data.world.start);
  }

  on(fn: (event: Events, detail: unknown) => void) {
    this.listeners.push(fn);
  }

  private emit(event: Events, detail: unknown) {
    for (const fn of this.listeners) fn(event, detail);
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
        return { thing, spec: spec.things.find((t) => t.key === thing.key), mask, area: mask?.area ?? (x1 - x0) * (y1 - y0) };
      }),
    );
    hots.sort((a, b) => a.area - b.area);
    const cuts = await Promise.all(g.occluders.map(async (occ) => this.cut(occ, bg, await shared(occ.mask), g)));
    const place: Place = { key, spec, g, grid: new WalkGrid(g), bg, hots, cuts: cuts.filter((c): c is Cut => !!c), byKey: new Map(g.occluders.map((o) => [o.key, o])) };
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

  /** Walks to a thing, faces it and uses it: look at it, or go through it when it is an exit. */
  async use(key: string) {
    const hot = this.place.hots.find((h) => h.thing.key === key);
    if (!hot) throw new Error(`${this.place.key} has no thing "${key}"`);
    const placeKey = this.place.key;
    if (!(await this.walkTo(...hot.thing.stand)) && Math.hypot(this.hero.x - hot.thing.stand[0], this.hero.y - hot.thing.stand[1]) > this.place.g.cell * 2) return;
    if (this.place.key !== placeKey) return;
    const [x0, , x1] = hot.thing.box;
    this.hero.facing = (x0 + x1) / 2 >= this.hero.x ? 1 : -1;
    this.emit('use', { thing: key });
    const exit = this.place.spec.exits.find((e) => e.via === key);
    if (exit) {
      this.emit('exit', { from: placeKey, to: exit.to });
      await this.fadeOut();
      await this.enter(exit.to, placeKey);
      return;
    }
    await this.say(hot.spec?.looks ?? key);
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

  thingAt(x: number, y: number): Hot | undefined {
    const g = this.place.g;
    for (const hot of this.place.hots) {
      const [x0, y0, x1, y1] = hot.thing.box;
      if (x < x0 || x > x1 || y < y0 || y > y1) continue;
      if (!hot.mask || hot.mask.bits[Math.floor(y) * g.frame.width + Math.floor(x)]) return hot;
    }
    return undefined;
  }

  update(dt: number) {
    this.time += dt;
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
    const rect = this.drawHero();
    this.occlude(rect);
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

  /** Draws the hero with feet at his position; returns the box he and his shadow cover. */
  private drawHero(): [number, number, number, number] {
    const { x, y, facing, phase, img } = this.hero;
    const h = personPx(this.place.g, y);
    const w = img ? (h * img.width) / img.height : h * 0.36;
    const bob = Math.abs(Math.sin(phase)) * h * 0.025;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.42, Math.max(2, h * 0.035), 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.translate(x, y - bob);
    ctx.rotate(Math.sin(phase) * 0.035);
    ctx.scale(facing, 1);
    if (img) ctx.drawImage(img, -w / 2, -h, w, h);
    else drawFigure(h);
    ctx.restore();
    return [x - w / 2 - 2, y - h - bob - 2, x + w / 2 + 2, y + Math.max(3, h * 0.04)];
  }

  /** Puts the painting back over the hero, column by column, wherever an occluder stands in front of him. */
  private occlude([left, top, right, bottom]: [number, number, number, number]) {
    const support = (k: string) => this.place.byKey.get(k);
    for (const cut of this.place.cuts) {
      const [bx0, by0, bx1, by1] = cut.occ.box;
      if (bx1 < left || bx0 > right || by1 < top || by0 > bottom) continue;
      const y0 = Math.max(top, cut.y0);
      const y1 = Math.min(bottom, cut.y0 + cut.canvas.height);
      if (y1 <= y0) continue;
      for (const [a, b] of hiddenRuns(cut.occ, left, right, this.hero.y, support)) {
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

/** A plain stand-in hero, drawn facing right with feet at the origin. */
function drawFigure(h: number) {
  ctx.fillStyle = '#2b2733';
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
  canvas.style.cursor = capture ? 'none' : game.hover ? 'pointer' : 'default';
  document.getElementById('hover')!.textContent = game.hover ? game.hover.thing.key.replace(/-/g, ' ') : '';
});
canvas.addEventListener('click', (e) => {
  if (!game.place || game.dark > 0) return;
  const [x, y] = toFrame(e);
  const hot = game.thingAt(x, y);
  if (hot) void game.use(hot.thing.key);
  else void game.walkTo(x, y);
});
addEventListener('keydown', (e) => {
  if (e.key === 'g') game.grid = !game.grid;
});
if (capture) document.getElementById('bar')!.style.display = 'none';

// For scripts and recorders: drive the hero and listen to what happens.
Object.assign(window, { diorama: game });

await game.start();
let last = performance.now();
const frame = (now: number) => {
  // Capture mode steps a fixed 1/60 s per frame so a recorded run is the same every time.
  const dt = capture ? 1 / 60 : Math.min(0.05, (now - last) / 1000);
  last = now;
  game.update(dt);
  game.render();
  requestAnimationFrame(frame);
};
requestAnimationFrame(frame);
