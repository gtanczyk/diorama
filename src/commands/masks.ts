// diorama masks <slug> [place...]: masks/<thing>.png, masks/floors/<floor>.png and masks.json per place.
import fs from 'node:fs';
import { maskToPng } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import { defineCommand } from '../registry.ts';
import { Brief } from '../scene/brief.ts';
import { Layout } from '../scene/layout.ts';
import { locateThings, markFloors } from '../scene/locate.ts';
import { maskFloors, maskThings } from '../scene/masks.ts';
import { maskBox, type Rect } from '../image/raster.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'masks',
  usage: 'masks <slug> [place...]  find each thing and floor in the painting with Spark and SAM 3.1',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: diorama masks <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      const at = (...parts: string[]) => files.place(place.key, ...parts);
      const layout = Layout.parse(files.readJson(at('layout.json')));
      const brief = Brief.parse(files.readJson(at('brief.json')));
      const painting = fs.readFileSync(at('painting.png'));
      const flagged: string[] = [];
      const log = (line: string) => {
        flagged.push(line);
        console.log(`  ${place.key}: ${line}`);
      };

      const [spots, cells] = await Promise.all([
        locateThings(files.memo, place, brief, painting),
        markFloors(files.memo, place, layout, brief, painting),
      ]);
      files.write(at('locate.json'), { things: spots, floors: cells });
      const [things, floors] = await Promise.all([
        maskThings(files.memo, place, layout, spots, painting, log),
        maskFloors(files.memo, place, layout, cells, painting, log),
      ]);

      fs.rmSync(at('masks'), { recursive: true, force: true });
      for (const t of things) files.write(at('masks', `${t.key}.png`), await maskToPng(t.mask));
      for (const f of floors) files.write(at('masks', 'floors', `${f.key}.png`), await maskToPng(f.mask));
      const layers = [...floors.map((f) => ({ key: f.key, mask: f.mask, alpha: 0.25 })), ...things.map((t) => ({ key: t.key, mask: t.mask, alpha: 0.45 }))];
      const tints = layers.map((l, i) => ({ mask: l.mask, alpha: l.alpha, rgb: PALETTE[i % PALETTE.length] }));
      const labels = [...floors.map((f) => ({ key: f.key, box: maskBox(f.mask) })), ...things.map((t) => ({ key: t.key, box: t.box as Rect | undefined }))]
        .map((l, i) => (l.box ? svgLabel(l.box[0] + 4, l.box[1] + 18, l.key, PALETTE[i % PALETTE.length]) : ''));
      files.write(at('masks', 'overlay.png'), await tintOver(painting, tints, labels.join('')));
      const round = (v: number) => Math.round(v * 100) / 100;
      files.write(at('masks.json'), {
        things: Object.fromEntries(things.map(({ key, mask: _, ...t }) => [key, t])),
        floors: Object.fromEntries(floors.map(({ key, mask: _, iouCells, iouLayout, ...f }) => [key, { ...f, iouCells: round(iouCells), iouLayout: round(iouLayout) }])),
        flagged,
      });
      const coarse = [...things, ...floors].filter((m) => m.coarse).map((m) => m.key);
      console.log(`${place.key}: ${things.length} things, ${floors.length} floors${coarse.length ? `, coarse: ${coarse.join(', ')}` : ''}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, sam ${files.memo.sent.sam}`);
  },
});
