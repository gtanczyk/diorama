// diorama export <slug> [dir]: the world as a static folder (index.html, main.js, world-data.json, files/) any web host can serve.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { bundle, WEB, worldData } from './play.ts';

/** Writes the playable copy of world `slug` to `out`, replacing whatever was there. */
export async function exportWorld(slug: string, out: string): Promise<void> {
  const files = new WorldFiles(slug);
  const data = worldData(files);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const copy = async (rel: string, asJpeg = false): Promise<string> => {
    const target = asJpeg ? rel.replace(/\.png$/, '.jpg') : rel;
    const dest = path.join(out, 'files', target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Paintings and plates are opaque, so JPEG keeps them a fraction of the size; masks and figures stay PNG.
    if (asJpeg) await sharp(files.path(rel)).jpeg({ quality: 88, mozjpeg: true }).toFile(dest);
    else fs.copyFileSync(files.path(rel), dest);
    return target;
  };
  for (const [key, entry] of Object.entries(data.places)) {
    if (entry.painting) entry.painting = await copy(entry.painting, true);
    if (entry.backdrop) entry.backdrop = await copy(entry.backdrop, true);
    for (const thing of entry.geometry?.things ?? []) {
      if (thing.mask) await copy(`places/${key}/${thing.mask}`);
      if (thing.plate) thing.plate = path.posix.relative(`places/${key}`, await copy(`places/${key}/${thing.plate}`, true));
    }
    for (const occ of entry.geometry?.occluders ?? []) if (occ.mask) await copy(`places/${key}/${occ.mask}`);
  }
  for (const [i, rel] of Object.entries(data.changes)) data.changes[i] = await copy(rel); // transparent around the thing, so PNG
  for (const figure of Object.values(data.cast)) {
    await copy(figure.image);
    for (const part of figure.rig?.parts ?? []) await copy(`${figure.parts}/${part.file}`);
  }
  fs.writeFileSync(path.join(out, 'world-data.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(out, 'main.js'), await bundle(true));
  fs.copyFileSync(path.join(WEB, 'index.html'), path.join(out, 'index.html'));
}

defineCommand({
  name: 'export',
  usage: 'export <slug> [dir] [--zip]   write a static, playable copy of the world (default exports/<slug>); --zip also packs it for itch.io or e-mail',
  async run(args) {
    const zip = args.includes('--zip');
    const [slug, dir = path.join('exports', slug ?? '')] = args.filter((a) => a !== '--zip');
    if (!slug) throw new Error('usage: diorama export <slug> [dir] [--zip]');
    const out = path.resolve(dir);
    await exportWorld(slug, out);
    console.log(`export ${slug}: ${out}`);
    if (zip) {
      // index.html at the zip's root, which is what itch.io wants for an HTML5 upload.
      fs.rmSync(`${out}.zip`, { force: true });
      execFileSync('zip', ['-qr', `${out}.zip`, '.'], { cwd: out });
      console.log(`zip: ${out}.zip`);
    }
  },
});
