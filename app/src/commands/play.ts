// diorama play <slug>: serves the world to a browser page where you walk through its places.
import fs from 'node:fs';
import { registeredFace } from '../scene/faces-data.ts';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Geometry } from '../play/geometry.ts';
import { previewGeometry } from '../play/preview.ts';
import type { Layers } from '../play/parallax.ts';
import { Rig } from '../play/rig.ts';
import { Reactions } from '../play/reactions.ts';
import { reactionInput } from './reactions.ts';
import { reactionSource } from '../scene/reactions.ts';
import { Weather } from '../play/weather.ts';
import { glowsOf, type Glow } from '../play/glow.ts';
import { readBodies } from '../scene/cast.ts';
import type { ModelInfo } from '../../web/hero3d.ts';
import { modelProblem } from '../model/glb.ts';
import type { SpriteInfo } from '../../web/main.ts';
import { soundData } from '../sound/data.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { ItemsInfo } from '../scene/icons.ts';
import { Layout } from '../scene/layout.ts';
import { Story } from '../story/schema.ts';
import { players } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';

type Flats = { sky: string | null; flats: Array<{ file: string; box: [number, number, number, number] }>; water?: { tex: string; mask: string; box: [number, number, number, number]; flow?: [number, number] }; mist?: { tex: string; mask: string; box: [number, number, number, number]; drift?: -1 | 0 | 1 | null; speed?: number } };

export const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.mp3': 'audio/mpeg' };

/** What the page loads: the world, and per place its geometry (measured, or a preview from the layout). */
export function worldData(files: WorldFiles) {
  const world = files.world();
  const places: Record<string, { geometry: Geometry | null; painting: string | null; backdrop?: string; layers?: Layers; weather?: Weather; reactions?: Reactions; glows?: Glow[]; issue?: string }> = {};
  for (const place of world.places) {
    const painted = ['painting.png', 'blockin.png'].find((f) => fs.existsSync(files.place(place.key, f)));
    let geometry: Geometry | null = null;
    let issue: string | undefined;
    try {
      if (fs.existsSync(files.place(place.key, 'geometry.json'))) geometry = Geometry.parse(files.readJson(files.place(place.key, 'geometry.json')));
      else if (fs.existsSync(files.place(place.key, 'layout.json'))) geometry = previewGeometry(Layout.parse(files.readJson(files.place(place.key, 'layout.json'))), place);
      else issue = 'no layout.json or geometry.json yet';
    } catch (error) {
      issue = `geometry.json: ${error instanceof Error ? error.message.slice(0, 300) : error}`;
    }
    // backdrop.png: the painting without its standing things; with it the page draws the place as a parallax diorama.
    // Not for a place painted from a photo: the film dissolves the photo into that exact frame, so it stays still.
    const fromPhoto = fs.existsSync(files.place(place.key, 'photo.png'));
    const backdrop = painted === 'painting.png' && !fromPhoto && fs.existsSync(files.place(place.key, 'backdrop.png')) ? `places/${place.key}/backdrop.png` : undefined;
    // layers.json: the far view as flats (sky, then farthest to nearest), from the same backdrop step.
    const layersFile = files.place(place.key, 'layers.json');
    const flats = backdrop && fs.existsSync(layersFile) ? (files.readJson(layersFile) as Flats) : undefined;
    const rel = (f: string) => `places/${place.key}/${f}`;
    const layers: Layers | undefined = flats && {
      sky: flats.sky ? rel(flats.sky) : null,
      flats: flats.flats.map((f) => ({ file: rel(f.file), box: f.box })),
      ...(flats.water && { water: { tex: rel(flats.water.tex), mask: rel(flats.water.mask), box: flats.water.box, flow: flats.water.flow } }),
      ...(flats.mist && { mist: { ...flats.mist, tex: rel(flats.mist.tex), mask: rel(flats.mist.mask) } }),
    };
    // weather.json (diorama weather): what falls here and where water drips, for the page to animate.
    const weatherFile = files.place(place.key, 'weather.json');
    const read = painted === 'painting.png' && fs.existsSync(weatherFile) ? Weather.safeParse(files.readJson(weatherFile)) : undefined;
    const weather = read?.success ? { ...read.data, ...(read.data.ripples && { ripples: rel(read.data.ripples) }) } : undefined;
    // layout.lights: the painted lights, to breathe, flicker, twinkle or turn their beam (src/play/glow.ts).
    const layoutFile = files.place(place.key, 'layout.json');
    const lights = painted === 'painting.png' && fs.existsSync(layoutFile) ? Layout.safeParse(files.readJson(layoutFile)) : undefined;
    // On the lights as painted when derive found them (geometry.glows); an older derive has only the planned points.
    const paintedAt = geometry?.glows;
    const sources = lights?.success ? (paintedAt ? lights.data.lights.flatMap((l) => { const p = paintedAt.find((g) => g.key === l.key); return p ? [{ ...l, x: p.x, y: p.y }] : []; }) : lights.data.lights) : [];
    const glows = sources.length ? glowsOf(sources) : undefined;
    let reactions: Reactions | undefined;
    const reactionsFile = files.place(place.key, 'reactions.json');
    if (fs.existsSync(reactionsFile)) {
      try {
        const rules = Reactions.parse(files.readJson(reactionsFile));
        if (rules.source === reactionSource(reactionInput(files, place.key))) reactions = rules;
        else console.warn(`${place.key}: reactions stale; rerun reactions`);
      } catch (e) { console.warn(`${place.key}: reactions unavailable: ${e instanceof Error ? e.message : String(e)}`); }
    }
    places[place.key] = { geometry, painting: painted ? `places/${place.key}/${painted}` : null, ...(backdrop && { backdrop }), ...(layers && { layers }), ...(weather && { weather }), ...(reactions && { reactions }), ...(glows && { glows }), issue };
  }
  const castDir = files.path('cast');
  // cast/figures.json (diorama cast): metres each one stands (a grown-up 1.62) and whether upright; one that
  // isn't (a cat) is drawn as painted, whatever rig, model or sheets an older build left.
  const bodies = readBodies(files, fs.existsSync);
  const cast = Object.fromEntries((fs.existsSync(castDir) ? fs.readdirSync(castDir) : [])
    .filter((f) => f.endsWith('.png') && !f.endsWith('-painting.png'))
    .map((f) => {
      const key = f.slice(0, -4);
      // A walk that measured torn when it was made (rig.json check) is left out: the painted figure slides as one piece.
      const rig = fs.existsSync(files.path('cast', key, 'rig.json')) ? Rig.parse(files.readJson(files.path('cast', key, 'rig.json'))) : undefined;
      // cast/<key>/model/model.json (diorama model): a rigged 3D figure the page draws instead of the 2D rig.
      // A flat one (a card TRELLIS made of a flat drawing, kept before the model step checked) is left out, and so
      // are the sheets painted over its guides: the character walks with its 2D rig.
      const modelOk = fs.existsSync(files.path('cast', key, 'model', 'model.json')) && !modelProblem(files.path('cast', key, 'model'));
      const model = modelOk ? { dir: `cast/${key}/model`, info: files.readJson(files.path('cast', key, 'model', 'model.json')) as ModelInfo } : undefined;
      // cast/<key>/sprites/sprites.json (diorama sprites): painted walk sheets, preferred over the 3D figure.
      const sprites = modelOk && fs.existsSync(files.path('cast', key, 'sprites', 'sprites.json')) ? { dir: `cast/${key}/sprites`, info: files.readJson(files.path('cast', key, 'sprites', 'sprites.json')) as SpriteInfo } : undefined;
      const face = registeredFace(files, key);
      const body = bodies[key];
      // Sheets rendered straight from the model's UV texture (model-*.png, no Muse paint) are a blurry stand-in
      // with the rig's A-pose arms: a 2D walk bent from the character's own painting, when it passed its check,
      // looks like the place it walks in and wins over them. Sheets Muse painted still win over the 2D walk.
      const rendered = sprites && Object.values(sprites.info.facings ?? {}).every((f) => f.sheet.startsWith('model-'));
      const ownWalk = rig?.sheet && rig.check?.ok !== false;
      const sheets = rendered && ownWalk && process.env.DIORAMA_UV_SPRITES !== '1' ? undefined : sprites;
      const walks = body?.upright !== false;
      // A creature has no legs for a 2D rig, but its own 3D model (no skeleton, model.json creature) hops and squashes.
      const creatureModel = model?.info.creature ? model : undefined;
      return [key, { image: `cast/${f}`, ...(face && { face }), ...(body && { height: body.height }), ...(!walks && { upright: false }), ...(walks && rig && rig.check?.ok !== false ? { rig, parts: `cast/${key}` } : {}), ...(walks ? model && { model } : creatureModel && { model: creatureModel }), ...(walks && sheets && { sprites: sheets }) }];
    }));
  const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : null;
  // changes/<i>.png per place: how story.changes[i] looks once it holds.
  const changes: Record<string, string> = {};
  (story?.changes ?? []).forEach((c, i) => {
    const file = `places/${c.place}/changes/${i}.png`;
    if (fs.existsSync(files.path(file))) changes[i] = file;
  });
  // sound.json + sound/: what the world sounds like (diorama sound); absent, the page plays silent.
  const sound = soundData(files);
  // items/items.json (diorama icons): a painted icon per story item; without it the bag shows names.
  const itemsFile = files.path('items', 'items.json');
  const items = fs.existsSync(itemsFile)
    ? Object.fromEntries(Object.entries(ItemsInfo.parse(files.readJson(itemsFile))).filter(([, i]) => fs.existsSync(files.path(i.icon))).map(([k, i]) => [k, { icon: i.icon }]))
    : undefined;
  // The heroes of more gamepads (drawings marked player), in drawing order: pad 2 plays the first.
  const others = players(files).map((p) => p.key).filter((k) => cast[k]);
  return { slug: files.slug, world, places, cast, story, changes, ...(sound && { sound }), ...(items && { items }), ...(others.length && { players: others }) };
}

export async function bundle(forShip = false): Promise<string> {
  const out = await build({ entryPoints: [path.join(WEB, 'main.ts')], bundle: true, format: 'esm', write: false, target: 'es2022', ...(forShip ? { minify: true } : { sourcemap: 'inline' }) });
  return out.outputFiles[0].text;
}

/** Serves the page and the world's files on localhost; resolves once listening. */
export async function serveWorld(files: WorldFiles, port: number): Promise<http.Server> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (status: number, type: string, body: string | Buffer) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(body);
    };
    try {
      if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(WEB, 'index.html')));
      if (url.pathname === '/prototype/conductor-lipsync') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(WEB, '../demo/conductor-lipsync/index.html')));
      if (url.pathname === '/main.js') return send(200, 'text/javascript; charset=utf-8', await bundle());
      if (url.pathname === '/world-data.json') return send(200, 'application/json', JSON.stringify(worldData(files)));
      if (url.pathname.startsWith('/files/')) {
        const file = path.resolve(files.dir, decodeURIComponent(url.pathname.slice('/files/'.length)));
        if (!file.startsWith(files.dir + path.sep) || !fs.existsSync(file)) return send(404, 'text/plain', 'not found');
        return send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
      }
      send(404, 'text/plain', 'not found');
    } catch (error) {
      send(500, 'text/plain', String(error instanceof Error ? error.stack : error));
    }
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  return server;
}

defineCommand({
  name: 'play',
  usage: 'play <slug> serve the world at http://localhost:4173 to walk through it [--port N]',
  async run(args) {
    const port = Number(takeOption(args, 'port', '4173'));
    const [slug] = args;
    if (!slug) throw new Error('usage: diorama play <slug>');
    const files = new WorldFiles(slug);
    files.world();

    await serveWorld(files, port);
    console.log(`play ${slug}: http://localhost:${port}  (g: grid and occluders, Ctrl+C to stop)`);
    await new Promise(() => {});
  },
});
