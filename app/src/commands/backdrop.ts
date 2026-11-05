import sharp from 'sharp';
// diorama backdrop <slug> [place...]: backdrop.png per place, the painting without its cards, so the runtime can
// slide the cards against it (parallax). Cards are the sharp occluders of geometry.json, so run it after derive.
import fs from 'node:fs';
import { maskFromPng } from '../image/mask.ts';
import { dilate, subtract, unionAll } from '../image/raster.ts';
import { FRAME } from '../scene/layout.ts';
import { Geometry } from '../play/geometry.ts';
import { defineCommand } from '../registry.ts';
import { BACKDROP_GROW, backdropFor, smearedBackdrop, type Card } from '../scene/backdrop.ts';
import { carryBetween, carryFrom, paintingFor, ran, remakes, tilesLine, withChange } from '../scene/carry.ts';
import { cloudSheet, CRITTER, critterSheet, Depth, FALLING, fallSheet, STREAM, streamSheet, farFlats, floatSheet, cloneFill, mistSheet, smokeSheet, waterSheet } from '../scene/layers.ts';
import { maskFromPng as waterMaskOf } from '../image/mask.ts';
import { WorldFiles } from '../world/files.ts';
import { CAR, clearUnderCar, driveLayers } from '../scene/drive.ts';
import { depthMap } from '../scene/depthmap.ts';

/** A thing that is water itself: its mask is where the swell is, not dry land. */
const WET_THING = /\b(water|river|sea|lake|pond|pool|stream|canal|creek|brook|waves?|fountain|puddle)s?\b/i;

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
      if (place.kind === 'drive') {
        // A drive: the road and the roadside stream toward the camera, the far view stays; no flats, water or fog.
        fs.rmSync(at('layers'), { recursive: true, force: true });
        const car = place.things.find((t) => CAR.test(`${t.key} ${t.looks}`)) ?? place.things.find((t) => t.role === 'prop');
        const carBox = car && g.things.find((t) => t.key === car.key)?.box;
        if (carBox) png = await clearUnderCar(png, carBox);
        // Depth read again from the backdrop: the painting's has the cards in it. Local model, no call.
        const own = await depthMap(png, g).catch(() => undefined);
        const depth = own && 'png' in own ? own.png : g.depth && fs.existsSync(at(g.depth)) ? fs.readFileSync(at(g.depth)) : undefined;
        // The vanishing point: the middle of the road's farthest walk row.
        const top = g.walk.findIndex((row) => row.includes('#'));
        const cols = top < 0 ? [] : [...g.walk[top]].flatMap((ch, c) => (ch === '#' ? [(c + 0.5) * g.cell] : []));
        const roadX = cols.length ? cols.reduce((a, b) => a + b, 0) / cols.length : FRAME.width / 2;
        const made = await driveLayers(png, depth, g.scale.horizonY, roadX);
        files.write(at('layers', 'drive-near.png'), made.near);
        files.write(at('layers', 'drive-far.jpg'), made.far);
        files.write(at('layers.json'), { sky: null, flats: [], drive: { near: 'layers/drive-near.png', far: 'layers/drive-far.jpg', vp: made.vp } });
        console.log(`  ${place.key}: drive, streaming from [${made.vp.join(', ')}]${depth ? '' : ' (no depth map: below the horizon only)'}`);
        ran(at(), 'backdrop', carry?.old ?? painting);
        ran(at(), 'backdrop-made', png);
        return;
      }
      // Painted animals (fish, gulls) swim and fly as small cards of their own: painted out of the backdrop here.
      const alive = (fs.existsSync(at('brief.json')) ? (files.readJson(at('brief.json')) as { alive?: Array<{ key: string; as: string }> }).alive : undefined) ?? [];
      const critterKeys = Object.keys(notes).filter((k) => !keys.includes(k) && fs.existsSync(at('masks', `${k}.png`)) && (CRITTER.test(`${k} ${notes[k].phrase}`) || alive.some((a) => a.key === k && a.as === 'animal')));
      const critterMask = unionAll(FRAME.width, FRAME.height, await Promise.all(critterKeys.map(async (k) => maskFromPng(fs.readFileSync(at('masks', `${k}.png`))))));
      const withCritters = png;
      if (critterKeys.length) {
        const raw = new Uint8Array(await sharp(png).resize(FRAME.width, FRAME.height, { fit: 'fill' }).removeAlpha().raw().toBuffer());
        png = await sharp(cloneFill(raw, FRAME.width, FRAME.height, dilate(critterMask, 3)), { raw: { width: FRAME.width, height: FRAME.height, channels: 3 } }).png().toBuffer();
        files.write(at('backdrop.png'), png);
      }
      // Small things painted falling in a stream (code rain, snow, petals) fall on the page (layers/stream-<i>.png):
      // cut out of the backdrop here, each column falling at its own pace. Other things' masks stay put (a doorway
      // inside the rain keeps what is seen through it).
      const looks = (k: string) => place.things.find((t) => t.key === k)?.looks ?? '';
      const streamKeys = Object.keys(notes).filter((k) => !keys.includes(k) && !critterKeys.includes(k) && STREAM.test(`${k} ${notes[k].phrase} ${looks(k)}`) && fs.existsSync(at('masks', `${k}.png`)));
      const streams: Array<{ png: Buffer; region: Buffer; box: [number, number, number, number] }> = [];
      for (const k of streamKeys) {
        const others = await Promise.all(Object.keys(notes).filter((o) => o !== k && fs.existsSync(at('masks', `${o}.png`))).map(async (o) => maskFromPng(fs.readFileSync(at('masks', `${o}.png`)))));
        const made = await streamSheet(png, await maskFromPng(fs.readFileSync(at('masks', `${k}.png`))), dilate(unionAll(FRAME.width, FRAME.height, others), 2));
        if (!made) continue;
        png = made.backdrop;
        streams.push(made);
      }
      if (streams.length) files.write(at('backdrop.png'), png);
      // Painted waterfalls pour (layers/fall-<i>.png); they stay out of the flat water below them.
      const fallKeys = Object.keys(notes).filter((k) => !keys.includes(k) && !streamKeys.includes(k) && FALLING.test(`${k} ${notes[k].phrase}`) && fs.existsSync(at('masks', `${k}.png`)));
      const fallMasks = await Promise.all(fallKeys.map(async (k) => maskFromPng(fs.readFileSync(at('masks', `${k}.png`)))));
      // The far view as flats one behind another (layers/), so it has depth of its own.
      fs.rmSync(at('layers'), { recursive: true, force: true });
      fs.rmSync(at('layers.json'), { force: true });
      // The far flats and the water are cut from the backdrop: asked about the last backdrop where its change does not reach them.
      const moved = lastBackdrop && (await carryBetween(lastBackdrop, png));
      // Where the far view ends: Spark's horizon, unless it lies far above the planned one (a scale fitted to a
      // tilted view put it at y 20 and no flat was left above it): then the plan's horizon.
      const planned = fs.existsSync(at('layout.json')) ? Number((files.readJson(at('layout.json')) as { horizon?: number }).horizon) : NaN;
      const farLine = Number.isFinite(planned) && g.scale.horizonY < planned - 120 ? planned : g.scale.horizonY;
      if (farLine !== g.scale.horizonY) console.log(`  ${place.key}: far flats down to the planned horizon ${planned} (the scale's horizon ${Math.round(g.scale.horizonY)} lies far above it)`);
      const farOff: [number, number, number, number][] = [[0, 0, FRAME.width, Math.max(0, farLine)], ...(lastLayers.flats ?? []).flatMap((f) => (f.box ? [f.box] : []))];
      const farAsked = farFlats(files.memo, place, paintingFor(moved || undefined, png, farOff), farLine).catch((error) => {
        console.log(`  ${place.key}: no far flats (${error instanceof Error ? error.message.slice(0, 120) : error})`);
        return undefined;
      });
      // Water to set flowing (layers/water.jpg and its mask), found by SAM on the backdrop.
      const floorDir = at('masks', 'floors');
      const floors = fs.existsSync(floorDir) ? await Promise.all(fs.readdirSync(floorDir).filter((f) => f.endsWith('.png')).map(async (f) => ({ key: f.replace(/\.png$/, ''), mask: await maskFromPng(fs.readFileSync(`${floorDir}/${f}`)) }))) : [];
      const depth = Depth.parse(fs.existsSync(at('depth.json')) ? files.readJson(at('depth.json')) : {});
      // Every painted thing stays dry, not only the cards: a mooring post or a jetty that is no card would
      // otherwise get the swell drawn over it. Only a thing that is the water itself (a pond, the river) flows.
      const dryThings = await Promise.all(Object.keys(notes).filter((k) => !WET_THING.test(`${k} ${notes[k].phrase}`) && !keys.includes(k) && !critterKeys.includes(k) && fs.existsSync(at('masks', `${k}.png`)))
        .map(async (k) => maskFromPng(fs.readFileSync(at('masks', `${k}.png`)))));
      // Painted fog to set drifting (layers/mist.jpg and its mask), found by SAM on the backdrop too.
      const things = dilate(unionAll(FRAME.width, FRAME.height, cards.map((c) => c.mask)), 4);
      const [far, water, mist, smoke] = await Promise.all([
        farAsked,
        waterSheet(files.memo, place, paintingFor(moved || undefined, png, lastWater ?? []), unionAll(FRAME.width, FRAME.height, [...cards.map((c) => c.mask), ...dryThings]), floors, depth, critterKeys.length ? critterMask : undefined).catch((error) => {
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
      // Boats painted on the water (not cards) to rock on the swell: layers/float-<i>.png, inside the water found above.
      const wetMask = water && await waterMaskOf(await sharp({ create: { width: FRAME.width, height: FRAME.height, channels: 3, background: '#000' } }).composite([{ input: water.mask, left: water.box[0], top: water.box[1] }]).png().toBuffer());
      const floats = wetMask ? await floatSheet(files.memo, place, png, things, wetMask).catch((error) => {
        console.log(`  ${place.key}: no rocking boats (${error instanceof Error ? error.message.slice(0, 120) : error})`);
        return [];
      }) : [];
      const falls = (await Promise.all(fallMasks.map((m) => fallSheet(png, m)))).filter((f) => !!f);
      falls.forEach((f, i) => files.write(at('layers', `fall-${i}.png`), f.png));
      if (falls.length) console.log(`  ${place.key}: ${falls.length} waterfall(s) pouring`);
      streams.forEach((f, i) => {
        files.write(at('layers', `stream-${i}.png`), f.png);
        files.write(at('layers', `stream-${i}-region.png`), f.region);
      });
      if (streams.length) console.log(`  ${place.key}: ${streams.length} stream(s) of small things falling (${streamKeys.join(', ')})`);
      const critters = critterKeys.length ? await critterSheet(withCritters, critterMask, wetMask) : [];
      critters.forEach((c, i) => files.write(at('layers', `critter-${i}.png`), c.png));
      if (critters.length) console.log(`  ${place.key}: ${critters.length} painted animal(s) ${critters.some((c) => c.medium === 'air') ? 'flying and ' : ''}swimming (${critterKeys.join(', ')})`);
      // The painted clouds drift as bands (layers/cloud-<i>.png); painted things in the sky and its light stay put.
      const keepInSky = unionAll(FRAME.width, FRAME.height, dryThings);
      const clouds = await cloudSheet(files.memo, place, png, unionAll(FRAME.width, FRAME.height, [...(wetMask ? [wetMask] : []), ...floors.map((f) => f.mask), ...fallMasks]), subtract(keepInSky, unionAll(FRAME.width, FRAME.height, fallMasks))).catch((error) => {
        console.log(`  ${place.key}: no drifting clouds (${error instanceof Error ? error.message.slice(0, 120) : error})`);
        return undefined;
      });
      clouds?.bands.forEach((b, i) => files.write(at('layers', `cloud-${i}.png`), b.png));
      if (clouds) {
        files.write(at('layers', 'cloud-clip.png'), clouds.clip);
        if (clouds.keep) files.write(at('layers', 'cloud-keep.png'), clouds.keep);
        console.log(`  ${place.key}: ${clouds.bands.length} cloud band(s) drifting`);
      }
      floats.forEach((s, i) => files.write(at('layers', `float-${i}.png`), s.png));
      if (floats.length) console.log(`  ${place.key}: ${floats.length} painted boat(s) rocking on the water`);
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
      if (far || water || mist || smoke.length || falls.length || streams.length || critters.length || clouds) {
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
          ...(floats.length && { floats: floats.map((s, i) => ({ file: `layers/float-${i}.png`, box: s.box })) }),
          ...(falls.length && { falls: falls.map((f, i) => ({ file: `layers/fall-${i}.png`, box: f.box })) }),
          ...(streams.length && { streams: streams.map((f, i) => ({ file: `layers/stream-${i}.png`, region: `layers/stream-${i}-region.png`, box: f.box })) }),
          ...(critters.length && { critters: critters.map((c, i) => ({ file: `layers/critter-${i}.png`, box: c.box, medium: c.medium, facing: c.facing })) }),
          ...(clouds && { clouds: { box: clouds.box, clip: 'layers/cloud-clip.png', ...(clouds.keep && { keep: 'layers/cloud-keep.png' }), bands: clouds.bands.map((b, i) => ({ file: `layers/cloud-${i}.png`, box: b.box, speed: b.speed })) } }),
        });
      }
      ran(at(), 'backdrop', carry?.old ?? painting);
      ran(at(), 'backdrop-made', moved ? moved.old : png);
    }));
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
