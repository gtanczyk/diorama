// diorama export <slug> [dir]: the world as a static folder (index.html, main.js, world-data.json, files/) any web host can serve.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { bundle, WEB, worldData } from './play.ts';

/** A language name ("Polish", "polski") or code ("pl", "pt-BR") as a BCP 47 code, when Intl knows it. */
function langCode(language?: string): string | undefined {
  if (!language) return undefined;
  const t = language.trim();
  if (/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/i.test(t)) return t;
  const names = new Intl.DisplayNames(['en'], { type: 'language' });
  for (const code of ['en', 'pl', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'cs', 'sk', 'uk', 'ru', 'sv', 'no', 'da', 'fi', 'hu', 'ro', 'el', 'tr', 'ja', 'ko', 'zh', 'ar', 'he', 'hi']) {
    const own = new Intl.DisplayNames([code], { type: 'language' }).of(code);
    if ([names.of(code), own].some((n) => n?.toLowerCase() === t.toLowerCase())) return code;
  }
  return undefined;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The link preview (X, Facebook, chats): the world's title and pitch, and a 1200x630 picture: the world's own og.jpg when it has one, else its first painted place. */
async function sharePreview(files: WorldFiles, out: string, url?: string): Promise<string> {
  const world = files.world();
  const title = `${world.title} · Diorama`;
  const pitch = world.pitch.length > 200 ? `${world.pitch.slice(0, 197).replace(/\s+\S*$/, '')}…` : world.pitch;
  const own = files.path('og.jpg');
  const painted = [world.start, ...world.places.map((p) => p.key)].map((key) => files.place(key, 'painting.png')).find((f) => fs.existsSync(f));
  const source = fs.existsSync(own) ? own : painted;
  const base = url ? (url.endsWith('/') ? url : `${url}/`) : '';
  const tags = [`<title>${esc(title)}</title>`, `<meta name="description" content="${esc(pitch)}">`, `<meta property="og:type" content="website">`, `<meta property="og:title" content="${esc(title)}">`, `<meta property="og:description" content="${esc(pitch)}">`];
  if (base) tags.push(`<meta property="og:url" content="${esc(base)}">`);
  if (source) {
    await sharp(source).resize(1200, 630, { fit: 'cover', position: 'attention' }).jpeg({ quality: 85, mozjpeg: true }).toFile(path.join(out, 'og.jpg'));
    // Crawlers want an absolute address; the stamp makes X fetch a new picture after a re-export.
    const image = `${base}og.jpg?v=${Date.now().toString(36)}`;
    tags.push(`<meta property="og:image" content="${esc(image)}">`, '<meta property="og:image:width" content="1200">', '<meta property="og:image:height" content="630">', `<meta property="og:image:alt" content="${esc(world.title)}, a playable paper diorama world">`, '<meta name="twitter:card" content="summary_large_image">', `<meta name="twitter:image" content="${esc(image)}">`);
  } else tags.push('<meta name="twitter:card" content="summary">');
  tags.push(`<meta name="twitter:title" content="${esc(title)}">`, `<meta name="twitter:description" content="${esc(pitch)}">`);
  return tags.join('\n');
}

/** Writes the playable copy of world `slug` to `out`, replacing whatever was there; `home` adds a link back to the page it is shared from; `url` is where the copy will be served, so its link preview has absolute addresses. */
export async function exportWorld(slug: string, out: string, home?: string, url?: string): Promise<void> {
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
      for (const b of entry.layers.drive?.bands ?? []) b.file = await copy(b.file); // repeats edge to edge: kept as is
      if (entry.layers.drive) entry.layers.drive.base = await copy(entry.layers.drive.base);
      for (const f of entry.layers.streams ?? []) [f.file, f.region] = [await art(f.file), await copy(f.region)];
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
  page = page.replace('<body>', '<body data-shipped>');
  if (home) page = page.replace('<div id="soundless"', `<a id="home" href="${esc(home)}">← Diorama</a>\n<div id="soundless"`);
  page = page.replace('<title>Diorama</title>', await sharePreview(files, out, url));
  // The page's language follows the world's, so browsers and screen readers read a Polish world as Polish.
  const lang = langCode(files.world().language);
  if (lang) page = page.replace('<html lang="en">', `<html lang="${lang}">`);
  fs.writeFileSync(path.join(out, 'index.html'), page);
}

defineCommand({
  name: 'export',
  usage: 'export <slug> [dir] [--zip] [--home <url>] [--url <url>]   write a static, playable copy of the world (default exports/<slug>); --zip also packs it for itch.io or e-mail; --home puts a "← Diorama" link to <url> in the corner; --url is where it will be served, for the X/Facebook link preview (title, pitch, og.jpg: worlds/<slug>/og.jpg if you made one, else the first place)',
  async run(args) {
    const zip = args.includes('--zip');
    const flag = (name: string) => { const i = args.indexOf(name); if (i >= 0 && !args[i + 1]) throw new Error(`${name} needs a url`); return i; };
    const h = flag('--home'), u = flag('--url');
    const home = h >= 0 ? args[h + 1] : undefined;
    const url = u >= 0 ? args[u + 1] : undefined;
    const [slug, dir = path.join('exports', slug ?? '')] = args.filter((a, i) => a !== '--zip' && ![h, u].some((f) => f >= 0 && (i === f || i === f + 1)));
    if (!slug) throw new Error('usage: diorama export <slug> [dir] [--zip] [--home <url>] [--url <url>]');
    const out = path.resolve(dir);
    await exportWorld(slug, out, home, url);
    console.log(`export ${slug}: ${out}`);
    if (zip) {
      // index.html at the zip's root, which is what itch.io wants for an HTML5 upload.
      fs.rmSync(`${out}.zip`, { force: true });
      execFileSync('zip', ['-qr', `${out}.zip`, '.'], { cwd: out });
      console.log(`zip: ${out}.zip`);
    }
  },
});
