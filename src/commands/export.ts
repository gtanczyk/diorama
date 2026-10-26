// diorama export <slug> [dir]: the world as a static folder (index.html, main.js, world-data.json, files/) any web host can serve.
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { bundle, WEB, worldData } from './play.ts';

defineCommand({
  name: 'export',
  usage: 'export <slug> [dir]      write a static, playable copy of the world (default exports/<slug>)',
  async run(args) {
    const [slug, dir = path.join('exports', slug ?? '')] = args;
    if (!slug) throw new Error('usage: diorama export <slug> [dir]');
    const files = new WorldFiles(slug);
    const data = worldData(files);
    const out = path.resolve(dir);
    fs.rmSync(out, { recursive: true, force: true });
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
      for (const thing of entry.geometry?.things ?? []) {
        if (thing.mask) await copy(`places/${key}/${thing.mask}`);
        if (thing.plate) thing.plate = path.posix.relative(`places/${key}`, await copy(`places/${key}/${thing.plate}`, true));
      }
      for (const occ of entry.geometry?.occluders ?? []) if (occ.mask) await copy(`places/${key}/${occ.mask}`);
    }
    for (const rel of Object.values(data.cast)) await copy(rel);
    fs.writeFileSync(path.join(out, 'world-data.json'), JSON.stringify(data));
    fs.writeFileSync(path.join(out, 'main.js'), await bundle(true));
    fs.copyFileSync(path.join(WEB, 'index.html'), path.join(out, 'index.html'));
    console.log(`export ${slug}: ${out}`);
  },
});
