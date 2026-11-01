// diorama backdrop <slug> [place...]: backdrop.png per place, the painting without its cards, so the runtime can
// slide the cards against it (parallax). Cards are the sharp occluders of geometry.json, so run it after derive.
import fs from 'node:fs';
import { maskFromPng } from '../image/mask.ts';
import { dilate, unionAll } from '../image/raster.ts';
import { FRAME } from '../scene/layout.ts';
import { Geometry } from '../play/geometry.ts';
import { defineCommand } from '../registry.ts';
import { BACKDROP_GROW, backdropFor, smearedBackdrop, type Card } from '../scene/backdrop.ts';
import { carryBetween, carryFrom, paintingFor, ran, remakes, tilesLine, withChange } from '../scene/carry.ts';
import { Depth, farFlats, mistSheet, smokeSheet, waterSheet } from '../scene/layers.ts';
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
      const painting = fs.readFileSync(at('painting.png'));
      // What the last run made, to carry over what a small repaint did not reach.
      const lastBackdrop = fs.existsSync(at('.ran', 'backdrop-made.png')) ? fs.readFileSync(at('.ran', 'backdrop-made.png')) : undefined;
      const lastLayers = (fs.existsSync(at('layers.json')) ? files.readJson(at('layers.json')) : {}) as { flats?: Array<{ box?: [number, number, number, number] }>; water?: { mask: string } };
      const lastWater = lastLayers.water && fs.existsSync(at(lastLayers.water.mask)) ? await maskFromPng(fs.readFileSync(at(lastLayers.water.mask))) : undefined;
      fs.rmSync(at('backdrop.png'), { force: true });
      const cards: Card[] = await Promise.all(keys.map(async (key) => ({ key, phrase: notes[key].phrase, mask: await maskFromPng(fs.readFileSync(at('masks', `${key}.png`))) })));
      if (smearOnly && cards.length) {
        files.write(at('backdrop.png'), await smearedBackdrop(cards, painting));
        console.log(`${place.key}: smeared backdrop behind ${keys.join(', ')}`);
        return;
      }
      // A repaint that reaches no card keeps the backdrop made last time; the repainted tiles come from the new painting.
      const carry = cards.length ? await carryFrom(at(), 'backdrop', painting) : undefined;
      let png: Buffer = painting;
      if (!cards.length) {
        // Nothing stands in front: the painting is the backdrop, and its far view, water and fog still move
        // (a river with nothing standing by it used to stay still).
        files.write(at('backdrop.png'), painting);
        console.log(`${place.key}: no standing things, the painting is the backdrop`);
      } else {
        // A repaint that leaves every card's outline as it was keeps the backdrop made last time: behind the cards it is
        // still what is there, and the repainted tiles around them come from the new painting.
        const kept = carry && !cards.some((c) => remakes(carry, c.mask));
        const made = await backdropFor(files.memo, place, cards, kept ? carry.old : painting);
        const { report } = made;
        png = kept ? await withChange(made.png, painting, carry, dilate(unionAll(FRAME.width, FRAME.height, cards.map((c) => c.mask)), BACKDROP_GROW)) : made.png;
        if (carry) console.log(`  ${place.key}: ${tilesLine(carry)}; ${kept ? 'no card changes, the backdrop is kept' : 'a card changes, the backdrop is made again'}`);
        files.write(at('backdrop.png'), png);
        files.write(at('backdrop.json'), report);
        const stuck = Object.entries(report).filter(([, r]) => r.stillThere).map(([k]) => k);
        const ghosts = Object.entries(report).filter(([, r]) => r.ghost).map(([k]) => k);
        for (const [k, r] of Object.entries(report)) if (r.cut) console.log(`  ${place.key}: ${k}: its card cuts through a painted part of it at [${r.cut.box?.join(', ')}] (its mask leaves that part out, so it stays on the backdrop and slides apart)`);
        console.log(`${place.key}: backdrop behind ${keys.join(', ')}${stuck.length ? ` (Muse left ${stuck.join(', ')}: smeared there)` : ''}${ghosts.length ? ` (a silhouette of ${ghosts.join(', ')} was left: painted over again)` : ''}`);
      }
      // The far view as flats one behind another (layers/), so it has depth of its own.
      fs.rmSync(at('layers'), { recursive: true, force: true });
      fs.rmSync(at('layers.json'), { force: true });
      // The far flats and the water are cut from the backdrop: asked about the last backdrop where its change does not reach them.
      const moved = lastBackdrop && (await carryBetween(lastBackdrop, png));
      const farOff: [number, number, number, number][] = [[0, 0, FRAME.width, Math.max(0, g.scale.horizonY)], ...(lastLayers.flats ?? []).flatMap((f) => (f.box ? [f.box] : []))];
      const farAsked = farFlats(files.memo, place, paintingFor(moved || undefined, png, farOff), g.scale.horizonY).catch((error) => {
        console.log(`  ${place.key}: no far flats (${error instanceof Error ? error.message.slice(0, 120) : error})`);
        return undefined;
      });
      // Water to set flowing (layers/water.jpg and its mask), found by SAM on the backdrop.
      const floorDir = at('masks', 'floors');
      const floors = fs.existsSync(floorDir) ? await Promise.all(fs.readdirSync(floorDir).filter((f) => f.endsWith('.png')).map(async (f) => ({ key: f.replace(/\.png$/, ''), mask: await maskFromPng(fs.readFileSync(`${floorDir}/${f}`)) }))) : [];
      const depth = Depth.parse(fs.existsSync(at('depth.json')) ? files.readJson(at('depth.json')) : {});
      // Painted fog to set drifting (layers/mist.jpg and its mask), found by SAM on the backdrop too.
      const things = dilate(unionAll(FRAME.width, FRAME.height, cards.map((c) => c.mask)), 4);
      const [far, water, mist, smoke] = await Promise.all([
        farAsked,
        waterSheet(files.memo, place, paintingFor(moved || undefined, png, lastWater ?? []), unionAll(FRAME.width, FRAME.height, cards.map((c) => c.mask)), floors, depth).catch((error) => {
          console.log(`  ${place.key}: no flowing water (${error instanceof Error ? error.message.slice(0, 120) : error})`);
          return undefined;
        }),
        mistSheet(files.memo, place, png, things, unionAll(FRAME.width, FRAME.height, floors.map((f) => f.mask)), depth).catch((error) => {
          console.log(`  ${place.key}: no drifting fog (${error instanceof Error ? error.message.slice(0, 120) : error})`);
          return undefined;
        }),
        // Painted smoke to set curling (layers/smoke-<i>.png), found by SAM on the backdrop.
        smokeSheet(files.memo, place, png, things).catch((error) => {
          console.log(`  ${place.key}: no curling smoke (${error instanceof Error ? error.message.slice(0, 120) : error})`);
          return [];
        }),
      ]);
      smoke.forEach((s, i) => files.write(at('layers', `smoke-${i}.png`), s.png));
      if (smoke.length) console.log(`  ${place.key}: ${smoke.length} plume(s) of smoke curling`);
      if (water) {
        files.write(at('layers', 'water.jpg'), water.tex);
        files.write(at('layers', 'water-mask.png'), water.mask);
        console.log(`  ${place.key}: ${water.phrase} ${water.flow[0] || water.flow[1] ? `flowing [${water.flow}]` : 'still'}`);
      }
      if (mist) {
        files.write(at('layers', 'mist.png'), mist.tex);
        files.write(at('layers', 'mist-mask.png'), mist.mask);
        console.log(`  ${place.key}: painted ${mist.phrase} drifting ${mist.drift === null ? 'with the wind' : mist.drift < 0 ? 'left' : 'right'}${mist.speed !== 1 ? ` x${mist.speed}` : ''}`);
      }
      if (far || water || mist || smoke.length) {
        if (far) {
          files.write(at('layers', 'sky.png'), far.sky);
          far.flats.forEach((f, i) => files.write(at('layers', `${i}.png`), f.png));
          console.log(`  ${place.key}: far flats, farthest first: ${far.flats.map((f) => f.phrase).join(' · ')}`);
        }
        files.write(at('layers.json'), {
          sky: far ? 'layers/sky.png' : null,
          flats: (far?.flats ?? []).map((f, i) => ({ phrase: f.phrase, file: `layers/${i}.png`, box: f.box, px: f.px })),
          ...(water && { water: { tex: 'layers/water.jpg', mask: 'layers/water-mask.png', box: water.box, flow: water.flow } }),
          ...(mist && { mist: { tex: 'layers/mist.png', mask: 'layers/mist-mask.png', box: mist.box, drift: mist.drift, speed: mist.speed } }),
          ...(smoke.length && { smoke: smoke.map((s, i) => ({ file: `layers/smoke-${i}.png`, box: s.box })) }),
        });
      }
      ran(at(), 'backdrop', carry?.old ?? painting);
      ran(at(), 'backdrop-made', moved ? moved.old : png);
    }));
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
