// diorama masks <slug> [place...]: masks/<thing>.png, masks/floors/<floor>.png and masks.json per place.
import fs from 'node:fs';
import { maskToPng } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import { defineCommand } from '../registry.ts';
import { Brief } from '../scene/brief.ts';
import { brushed, correctCells, correctSpots, readCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { locateThings, markFloors } from '../scene/locate.ts';
import { checkMasks, type MaskCheck } from '../scene/maskcheck.ts';
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

      const [found, marked] = await Promise.all([
        locateThings(files.memo, place, brief, painting),
        markFloors(files.memo, place, layout, brief, painting),
      ]);
      files.write(at('locate.json'), { things: found, floors: marked });
      // The person's fixes go in before SAM is asked and their brush strokes after, every time.
      const fixes = readCorrections(at());
      const spots = correctSpots(found, fixes);
      const cells = correctCells(marked, fixes);
      const [rawThings, rawFloors] = await Promise.all([
        maskThings(files.memo, place, layout, spots, painting, log),
        maskFloors(files.memo, place, layout, cells, painting, log),
      ]);
      const things = rawThings.map((t) => brushed(t, fixes.things[t.key]?.strokes));
      const floors = rawFloors.map((f) => brushed(f, fixes.floors[f.key]?.strokes));

      fs.rmSync(at('masks'), { recursive: true, force: true });
      for (const t of things) files.write(at('masks', `${t.key}.png`), await maskToPng(t.mask));
      for (const f of floors) files.write(at('masks', 'floors', `${f.key}.png`), await maskToPng(f.mask));
      const layers = [...floors.map((f) => ({ key: f.key, mask: f.mask, alpha: 0.25 })), ...things.map((t) => ({ key: t.key, mask: t.mask, alpha: 0.45 }))];
      const tints = layers.map((l, i) => ({ mask: l.mask, alpha: l.alpha, rgb: PALETTE[i % PALETTE.length] }));
      const labels = [...floors.map((f) => ({ key: f.key, box: maskBox(f.mask) })), ...things.map((t) => ({ key: t.key, box: t.box as Rect | undefined }))]
        .map((l, i) => (l.box ? svgLabel(l.box[0] + 4, l.box[1] + 18, l.key, PALETTE[i % PALETTE.length]) : ''));
      files.write(at('masks', 'overlay.png'), await tintOver(painting, tints, labels.join('')));
      // Is each thing really in its mask? A box someone fixed by hand is taken as given.
      let checks: Record<string, MaskCheck> = {};
      try {
        checks = await checkMasks(files.memo, place.key, painting, things.filter((t) => !fixes.things[t.key]?.box).map((t) => ({ key: t.key, looks: brief.looks[t.key] ?? place.things.find((x) => x.key === t.key)?.looks ?? t.key, box: t.box as Rect | undefined })));
        for (const [key, c] of Object.entries(checks)) if (!c.ok) log(`${key}: Spark sees ${c.seen ?? 'something else'} in its mask`);
      } catch (error) {
        log(`mask check skipped: ${error instanceof Error ? error.message : error}`);
      }
      const round = (v: number) => Math.round(v * 100) / 100;
      files.write(at('masks.json'), {
        things: Object.fromEntries(things.map(({ key, mask: _, ...t }) => [key, { ...t, ...(checks[key] && { check: checks[key] }) }])),
        floors: Object.fromEntries(floors.map(({ key, mask: _, iouCells, iouLayout, ...f }) => [key, { ...f, iouCells: round(iouCells), iouLayout: round(iouLayout) }])),
        flagged,
      });
      const coarse = [...things, ...floors].filter((m) => m.coarse).map((m) => m.key);
      console.log(`${place.key}: ${things.length} things, ${floors.length} floors${coarse.length ? `, coarse: ${coarse.join(', ')}` : ''}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, sam ${files.memo.sent.sam}`);
  },
});
