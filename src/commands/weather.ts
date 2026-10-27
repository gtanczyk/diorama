// diorama weather <slug> [place...]: weather.json per place, what falls there and where water drips, for the
// page to animate (rain or snow over the frame, rings on water and puddles, splashes, drips off the eaves).
import fs from 'node:fs';
import sharp from 'sharp';
import { maskFromPng, maskToPng } from '../image/mask.ts';
import { Geometry } from '../play/geometry.ts';
import { decodeDepth } from '../play/shadow.ts';
import { WeatherWish, type Weather } from '../play/weather.ts';
import { defineCommand } from '../registry.ts';
import { dryOf, readWeather } from '../scene/weather.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'weather',
  usage: 'weather <slug> [place...]  read what falls on each place (rain, snow) and which edges drip, for the page to animate',
  async run(args) {
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama weather <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      const at = (...parts: string[]) => files.place(place.key, ...parts);
      fs.rmSync(at('weather.json'), { force: true });
      fs.rmSync(at('weather'), { recursive: true, force: true });
      if (!fs.existsSync(at('geometry.json')) || !fs.existsSync(at('painting.png'))) {
        console.log(`  ${place.key}: no geometry.json or painting.png, no weather`);
        return;
      }
      const g = Geometry.parse(files.readJson(at('geometry.json')));
      const painting = fs.readFileSync(at('painting.png'));
      let depth;
      if (g.depth && fs.existsSync(at(g.depth))) {
        const { data, info } = await sharp(fs.readFileSync(at(g.depth))).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        depth = decodeDepth(data, info.width, info.height);
      }
      const maskFiles = [
        ...(fs.existsSync(at('masks', 'floors')) ? fs.readdirSync(at('masks', 'floors')).filter((f) => f.endsWith('.png')).map((f) => at('masks', 'floors', f)) : []),
        ...[...new Set(g.occluders.map((o) => o.mask).filter((m): m is string => !!m))].map((m) => at(m)),
      ].filter((f) => fs.existsSync(f));
      const dry = dryOf(g.frame.width, g.frame.height, await Promise.all(maskFiles.map(async (f) => maskFromPng(fs.readFileSync(f)))));
      const wish = WeatherWish.parse(fs.existsSync(at('weather-wish.json')) ? files.readJson(at('weather-wish.json')) : {});
      const { weather, ripples } = await readWeather(files.memo, place, painting, g, depth, dry, wish);
      if (ripples) files.write(at('weather', 'ripples.png'), await maskToPng(ripples));
      const out: Weather = { ...weather, ...(ripples && { ripples: 'weather/ripples.png' }) };
      files.write(at('weather.json'), out);
      const drips = weather.drips.map((d) => `${d.phrase} (${d.from.length})`).join(', ');
      console.log(`${place.key}: ${weather.fall === 'none' ? 'nothing falls' : `${weather.fall} ${weather.strength}, wind ${weather.wind}`}${weather.fog ? `, fog ${weather.fog}` : ''}${ripples ? ', rings on water and puddles' : ''}${drips ? `, drips from ${drips}` : ''}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, sam ${files.memo.sent.sam}`);
  },
});
