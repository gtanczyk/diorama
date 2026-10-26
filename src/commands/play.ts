// diorama play <slug>: serves the world to a browser page where you walk through its places.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Geometry } from '../play/geometry.ts';
import { previewGeometry } from '../play/preview.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { Layout } from '../scene/layout.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

const WEB = fileURLToPath(new URL('../../web/', import.meta.url));
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json' };

/** What the page loads: the world, and per place its geometry (measured, or a preview from the layout). */
export function worldData(files: WorldFiles) {
  const world = files.world();
  const places: Record<string, { geometry: Geometry | null; painting: string | null; issue?: string }> = {};
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
    places[place.key] = { geometry, painting: painted ? `places/${place.key}/${painted}` : null, issue };
  }
  const hero = fs.existsSync(files.path('hero', 'hero.png')) ? 'hero/hero.png' : null;
  const story = fs.existsSync(files.path('story.json')) ? Story.parse(files.readJson(files.path('story.json'))) : null;
  return { slug: files.slug, world, places, hero, story };
}

async function bundle(): Promise<string> {
  const out = await build({ entryPoints: [path.join(WEB, 'main.ts')], bundle: true, format: 'esm', write: false, sourcemap: 'inline', target: 'es2022' });
  return out.outputFiles[0].text;
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

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const send = (status: number, type: string, body: string | Buffer) => {
        res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
        res.end(body);
      };
      try {
        if (url.pathname === '/') return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(WEB, 'index.html')));
        if (url.pathname === '/main.js') return send(200, 'text/javascript; charset=utf-8', await bundle());
        if (url.pathname === '/api/world') return send(200, 'application/json', JSON.stringify(worldData(files)));
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
    console.log(`play ${slug}: http://localhost:${port}  (g: grid and occluders, Ctrl+C to stop)`);
    await new Promise(() => {});
  },
});
