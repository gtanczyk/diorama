// diorama export <slug> [dir]: the world as a static folder (index.html, main.js, world-data.json, files/) any web host can serve.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { bundle, WEB, worldData } from './play.ts';

/** Writes the playable copy of world `slug` to `out`, replacing whatever was there; `home` adds a link back to the page it is shared from. */
export async function exportWorld(slug: string, out: string, home?: string): Promise<void> {
  const files = new WorldFiles(slug);
  const data = worldData(files);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const copy = async (rel: string, asJpeg = false): Promise<string> => {
    const target = asJpeg ? rel.replace(/\.png$/, '.jpg') : rel;
    const dest = path.join(out, 'files', target);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    // Paintings are opaque, so JPEG keeps them a fraction of the size; masks and figures stay PNG.
    if (asJpeg) await sharp(files.path(rel)).jpeg({ quality: 88, mozjpeg: true }).toFile(dest);
    else fs.copyFileSync(files.path(rel), dest);
    return target;
  };
  // Cut-outs, sprite sheets and icons only need their look and an exact edge: WebP with lossless alpha is a
  // fraction of the PNG, and those files are most of what a player waits for. A file is changed only when it gets smaller.
  const done = new Map<string, string>();
  const art = async (rel: string): Promise<string> => {
    if (done.has(rel)) return done.get(rel)!;
    let target = rel;
    const webp = /\.png$/i.test(rel) ? await sharp(files.path(rel)).webp({ quality: 90, alphaQuality: 100, effort: 5 }).toBuffer() : undefined;
    if (webp && webp.length < fs.statSync(files.path(rel)).size * 0.9) {
      target = rel.replace(/\.png$/i, '.webp');
      const dest = path.join(out, 'files', target);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, webp);
    } else await copy(rel);
    done.set(rel, target);
    return target;
  };
  /** `file` inside `dir`, as art; its new name, still inside `dir`. */
  const artIn = async (dir: string, file: string) => path.posix.relative(dir, await art(`${dir}/${file}`));
  for (const [key, entry] of Object.entries(data.places)) {
    if (entry.painting) entry.painting = await copy(entry.painting, true);
    if (entry.backdrop) entry.backdrop = await copy(entry.backdrop, true);
    if (entry.layers) {
      if (entry.layers.sky) entry.layers.sky = await copy(entry.layers.sky, true);
      if (entry.layers.water) {
        entry.layers.water.tex = await copy(entry.layers.water.tex);
        entry.layers.water.mask = await copy(entry.layers.water.mask);
      }
      if (entry.layers.mist) {
        entry.layers.mist.tex = await copy(entry.layers.mist.tex);
        entry.layers.mist.mask = await copy(entry.layers.mist.mask);
      }
      for (const f of entry.layers.flats) f.file = await art(f.file); // transparent around the flat
      for (const f of [...(entry.layers.smoke ?? []), ...(entry.layers.floats ?? []), ...(entry.layers.falls ?? []), ...(entry.layers.critters ?? []), ...(entry.layers.clouds?.bands ?? [])]) f.file = await art(f.file);
      if (entry.layers.clouds) {
        entry.layers.clouds.clip = await copy(entry.layers.clouds.clip);
        if (entry.layers.clouds.keep) entry.layers.clouds.keep = await copy(entry.layers.clouds.keep);
      }
    }
    for (const thing of entry.geometry?.things ?? []) {
      if (thing.mask) await copy(`places/${key}/${thing.mask}`);
      // A plate is the patch where the thing was, transparent elsewhere.
      if (thing.plate) thing.plate = await artIn(`places/${key}`, thing.plate);
    }
    for (const occ of entry.geometry?.occluders ?? []) if (occ.mask) await copy(`places/${key}/${occ.mask}`);
    if (entry.geometry?.shadows) await copy(`places/${key}/${entry.geometry.shadows}`);
    if (entry.geometry?.depth) await copy(`places/${key}/${entry.geometry.depth}`);
    if (entry.weather?.ripples) entry.weather.ripples = await copy(entry.weather.ripples);
  }
  for (const [i, rel] of Object.entries(data.changes)) data.changes[i] = await art(rel); // transparent around the thing
  for (const [i, rel] of Object.entries(data.changeShapes)) data.changeShapes[i] = await copy(rel);
  for (const figure of Object.values(data.cast)) {
    figure.image = await art(figure.image);
    if (figure.face) await copy(`${figure.face.dir}/${figure.face.info.image}`); // the face atlas is read cell by cell, so as is
    for (const part of figure.rig?.parts ?? []) part.file = await artIn(figure.parts!, part.file);
    if (figure.rig?.sheet) figure.rig.sheet.file = await artIn(figure.parts!, figure.rig.sheet.file);
    if (figure.sprites) for (const f of [...Object.values(figure.sprites.info.facings), ...Object.values(figure.sprites.info.talk ?? {})]) f.sheet = await artIn(figure.sprites.dir, f.sheet);
    // The page draws sprites when it has them; the 3D model behind them (a glb and four big views) is only for ?model=1.
    if (figure.sprites) delete figure.model;
    if (figure.model) for (const file of [figure.model.info.glb, ...Object.values(figure.model.info.views).map((v) => v.image)]) await copy(`${figure.model.dir}/${file}`);
  }
  for (const item of Object.values(data.items ?? {})) item.icon = await art(item.icon); // transparent
  const recordings = Object.values(data.sound?.bySpeaker ?? {}).flatMap(lines => Object.values(lines));
  const audioFiles = new Set([...Object.values(data.sound?.files ?? {}), ...Object.values(data.sound?.lines ?? {}), ...recordings].map(sound => sound.file));
  for (const file of audioFiles) await copy(file);
  fs.writeFileSync(path.join(out, 'world-data.json'), JSON.stringify(data));
  fs.writeFileSync(path.join(out, 'main.js'), await bundle(true));
  let page = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
  if (home) {
    const href = home.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    page = page.replace('<div id="soundless"', `<a id="home" href="${href}">← Diorama</a>\n<div id="soundless"`);
  }
  fs.writeFileSync(path.join(out, 'index.html'), page);
}

defineCommand({
  name: 'export',
  usage: 'export <slug> [dir] [--zip] [--home <url>]   write a static, playable copy of the world (default exports/<slug>); --zip also packs it for itch.io or e-mail; --home puts a "← Diorama" link to <url> in the corner',
  async run(args) {
    const zip = args.includes('--zip');
    const h = args.indexOf('--home');
    const home = h >= 0 ? args[h + 1] : undefined;
    if (h >= 0 && !home) throw new Error('--home needs a url');
    const [slug, dir = path.join('exports', slug ?? '')] = args.filter((a, i) => a !== '--zip' && (h < 0 || (i !== h && i !== h + 1)));
    if (!slug) throw new Error('usage: diorama export <slug> [dir] [--zip] [--home <url>]');
    const out = path.resolve(dir);
    await exportWorld(slug, out, home);
    console.log(`export ${slug}: ${out}`);
    if (zip) {
      // index.html at the zip's root, which is what itch.io wants for an HTML5 upload.
      fs.rmSync(`${out}.zip`, { force: true });
      execFileSync('zip', ['-qr', `${out}.zip`, '.'], { cwd: out });
      console.log(`zip: ${out}.zip`);
    }
  },
});
