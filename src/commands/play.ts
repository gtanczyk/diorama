// diorama play <slug>: serves the world to a browser page where you walk through its places.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Geometry } from '../play/geometry.ts';
import { previewGeometry } from '../play/preview.ts';
import type { Layers } from '../play/parallax.ts';
import { Rig } from '../play/rig.ts';
import { soundData } from '../sound/data.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { Layout } from '../scene/layout.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

type Flats = { sky: string; flats: Array<{ file: string; box: [number, number, number, number] }> };

export const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.mp3': 'audio/mpeg' };

/** What the page loads: the world, and per place its geometry (measured, or a preview from the layout). */
export function worldData(files: WorldFiles) {
  const world = files.world();
  const places: Record<string, { geometry: Geometry | null; painting: string | null; backdrop?: string; layers?: Layers; issue?: string }> = {};
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
    const layers = flats && { sky: `places/${place.key}/${flats.sky}`, flats: flats.flats.map((f) => ({ file: `places/${place.key}/${f.file}`, box: f.box })) };
    places[place.key] = { geometry, painting: painted ? `places/${place.key}/${painted}` : null, ...(backdrop && { backdrop }), ...(layers && { layers }), issue };
  }
  const castDir = files.path('cast');
  const cast = Object.fromEntries((fs.existsSync(castDir) ? fs.readdirSync(castDir) : [])
    .filter((f) => f.endsWith('.png') && !f.endsWith('-painting.png'))
    .map((f) => {
      const key = f.slice(0, -4);
      const rig = fs.existsSync(files.path('cast', key, 'rig.json')) ? Rig.parse(files.readJson(files.path('cast', key, 'rig.json'))) : undefined;
      return [key, { image: `cast/${f}`, ...(rig ? { rig, parts: `cast/${key}` } : {}) }];
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
  return { slug: files.slug, world, places, cast, story, changes, ...(sound && { sound }) };
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
