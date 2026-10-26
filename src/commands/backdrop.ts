// diorama backdrop <slug> [place...]: backdrop.png per place, the painting without its cards, so the runtime can
// slide the cards against it (parallax). Cards are the sharp occluders of geometry.json, so run it after derive.
import fs from 'node:fs';
import { maskFromPng } from '../image/mask.ts';
import { Geometry } from '../play/geometry.ts';
import { defineCommand } from '../registry.ts';
import { backdropFor, smearedBackdrop, type Card } from '../scene/backdrop.ts';
import { farFlats, waterSheet } from '../scene/layers.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'backdrop',
  usage: 'backdrop <slug> [place...]  paint each place without its standing things, for parallax [--smear: no Muse, smear the gaps]',
  async run(args) {
    const smearOnly = args.includes('--smear');
    const [slug, ...only] = args.filter((a) => a !== '--smear');
    if (!slug) throw new Error('usage: diorama backdrop <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      const at = (...parts: string[]) => files.place(place.key, ...parts);
      if (!fs.existsSync(at('geometry.json')) || !fs.existsSync(at('painting.png'))) {
        console.log(`  ${place.key}: no geometry.json or painting.png, no backdrop`);
        return;
      }
      const g = Geometry.parse(files.readJson(at('geometry.json')));
      const notes = (files.readJson(at('masks.json')) as { things: Record<string, { phrase: string }> }).things;
      const keys = [...new Set(g.occluders.map((o) => o.thing ?? o.key))].filter((k) => notes[k] && fs.existsSync(at('masks', `${k}.png`)));
      fs.rmSync(at('backdrop.png'), { force: true });
      if (!keys.length) {
        console.log(`${place.key}: no standing things, the painting is the backdrop`);
        return;
      }
      const cards: Card[] = await Promise.all(keys.map(async (key) => ({ key, phrase: notes[key].phrase, mask: await maskFromPng(fs.readFileSync(at('masks', `${key}.png`))) })));
      const painting = fs.readFileSync(at('painting.png'));
      if (smearOnly) {
        files.write(at('backdrop.png'), await smearedBackdrop(cards, painting));
        console.log(`${place.key}: smeared backdrop behind ${keys.join(', ')}`);
        return;
      }
      const { png, report } = await backdropFor(files.memo, place, cards, painting);
      files.write(at('backdrop.png'), png);
      files.write(at('backdrop.json'), report);
      const stuck = Object.entries(report).filter(([, r]) => r.stillThere).map(([k]) => k);
      console.log(`${place.key}: backdrop behind ${keys.join(', ')}${stuck.length ? ` (Muse left ${stuck.join(', ')}: smeared there)` : ''}`);
      // The far view as flats one behind another (layers/), so it has depth of its own.
      fs.rmSync(at('layers'), { recursive: true, force: true });
      fs.rmSync(at('layers.json'), { force: true });
      const far = await farFlats(files.memo, place, png, g.scale.horizonY).catch((error) => {
        console.log(`  ${place.key}: no far flats (${error instanceof Error ? error.message.slice(0, 120) : error})`);
        return undefined;
      });
      // Water to set flowing (layers/water.jpg and its mask), found by SAM on the backdrop.
      const water = await waterSheet(files.memo, place, png).catch(() => undefined);
      if (water) {
        files.write(at('layers', 'water.jpg'), water.tex);
        files.write(at('layers', 'water-mask.png'), water.mask);
        console.log(`  ${place.key}: flowing ${water.phrase}`);
      }
      if (far || water) {
        if (far) {
          files.write(at('layers', 'sky.png'), far.sky);
          far.flats.forEach((f, i) => files.write(at('layers', `${i}.png`), f.png));
          console.log(`  ${place.key}: far flats, farthest first: ${far.flats.map((f) => f.phrase).join(' · ')}`);
        }
        files.write(at('layers.json'), {
          sky: far ? 'layers/sky.png' : null,
          flats: (far?.flats ?? []).map((f, i) => ({ phrase: f.phrase, file: `layers/${i}.png`, box: f.box, px: f.px })),
          ...(water && { water: { tex: 'layers/water.jpg', mask: 'layers/water-mask.png', box: water.box } }),
        });
      }
    }));
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
