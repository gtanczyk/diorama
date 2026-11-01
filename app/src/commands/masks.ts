// diorama masks <slug> [place...]: masks/<thing>.png, masks/floors/<floor>.png and masks.json per place.
import fs from 'node:fs';
import { maskFromPng, maskToPng, type Mask } from '../image/mask.ts';
import { PALETTE, svgLabel, tintOver } from '../image/overlay.ts';
import { defineCommand } from '../registry.ts';
import { Brief } from '../scene/brief.ts';
import { carryFrom, ran, remakes, tilesLine } from '../scene/carry.ts';
import { brushed, correctCells, correctSpots, readCorrections } from '../scene/corrections.ts';
import { Layout } from '../scene/layout.ts';
import { locateThings, markFloors } from '../scene/locate.ts';
import { checkMasks, type MaskCheck } from '../scene/maskcheck.ts';
import { maskFloors, maskThings } from '../scene/masks.ts';
import { paintingLayoutHash } from '../scene/paint-layout.ts';
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
      fs.rmSync(at('verify.json'), { force: true });
      const layout = Layout.parse(files.readJson(at('layout.json')));
      const brief = Brief.parse(files.readJson(at('brief.json')));
      const painting = fs.readFileSync(at('painting.png'));
      // A rejected/stale checked painting must not be rescued by masks and invented floor strokes.
      // Legacy worlds without a report remain editable; rebuilding from paint checks them too.
      if (!fs.existsSync(at('photo.png')) && fs.existsSync(at('painting-layout.json'))) {
        const report = files.readJson(at('painting-layout.json')) as { ok?: boolean; inputs?: string };
        if (!report.ok || report.inputs !== paintingLayoutHash(place, layout, fs.readFileSync(at('blockin.png')), painting)) {
          throw new Error(`PAINT_LAYOUT_MISMATCH ${place.key}: painting/layout changed or its composition check failed; rebuild this place from paint to inspect and repair it before masks`);
        }
      }
      const flagged: string[] = [];
      const log = (line: string) => {
        flagged.push(line);
        console.log(`  ${place.key}: ${line}`);
      };

      // After a small repaint, what it did not reach is found again on the old painting: the memo has those answers.
      const carry = await carryFrom(at(), 'masks', painting);
      if (carry) console.log(`  ${place.key}: ${tilesLine(carry)}; only what it reaches is asked again`);
      const seen = carry?.old ?? painting;
      const [found, marked] = await Promise.all([
        locateThings(files.memo, place, brief, seen),
        markFloors(files.memo, place, layout, brief, seen),
      ]);
      files.write(at('locate.json'), { things: found, floors: marked });
      // The person's fixes go in before SAM is asked and their brush strokes after, every time.
      const fixes = readCorrections(at());
      const spots = correctSpots(found, fixes);
      const cells = correctCells(marked, fixes);
      const before = async (file: string): Promise<Mask | undefined> => (carry && fs.existsSync(at('masks', file)) ? maskFromPng(fs.readFileSync(at('masks', file))) : undefined);
      // A thing or floor keeps its mask when the change does not reach it, or only grazes a big one.
      const keptThing = new Set<string>();
      const keptFloor = new Set<string>();
      for (const t of place.things) {
        const last = await before(`${t.key}.png`);
        if (carry && last && !remakes(carry, last)) keptThing.add(t.key);
      }
      for (const f of layout.floors) {
        const last = await before(`floors/${f.key}.png`);
        if (carry && last && !remakes(carry, last)) keptFloor.add(f.key);
      }
      const split = <T>(all: T[], kept: (x: T) => boolean) => [all.filter(kept), all.filter((x) => !kept(x))];
      const [oldThings, newThings] = split(place.things, (t) => keptThing.has(t.key));
      const [oldFloors, newFloors] = split(layout.floors, (f) => keptFloor.has(f.key));
      const [thingsOld, thingsNew, floorsOld, floorsNew] = await Promise.all([
        oldThings.some((t) => t.role !== 'npc') ? maskThings(files.memo, { ...place, things: oldThings }, layout, spots, carry!.old, log) : [],
        newThings.some((t) => t.role !== 'npc') ? maskThings(files.memo, { ...place, things: newThings }, layout, spots, painting, log) : [],
        oldFloors.length ? maskFloors(files.memo, place, { ...layout, floors: oldFloors }, cells, carry!.old, log) : [],
        newFloors.length ? maskFloors(files.memo, place, { ...layout, floors: newFloors }, cells, painting, log) : [],
      ]);
      const inOrder = <T extends { key: string }>(keys: string[], got: T[]) => keys.flatMap((k) => got.filter((g) => g.key === k));
      const things = inOrder(place.things.map((t) => t.key), [...thingsOld, ...thingsNew]).map((t) => brushed(t, fixes.things[t.key]?.strokes));
      const floors = inOrder(layout.floors.map((f) => f.key), [...floorsOld, ...floorsNew]).map((f) => brushed(f, fixes.floors[f.key]?.strokes));
      if (carry) console.log(`  ${place.key}: kept ${thingsOld.length}/${things.length} things and ${floorsOld.length}/${floors.length} floors as they were; masked again: ${[...thingsNew, ...floorsNew].map((m) => m.key).join(', ') || 'nothing'}`);
      const lastChecks = carry && fs.existsSync(at('masks.json')) ? ((files.readJson(at('masks.json')) as { things?: Record<string, { box?: Rect; check?: MaskCheck }> }).things ?? {}) : {};

      fs.rmSync(at('masks'), { recursive: true, force: true });
      for (const t of things) files.write(at('masks', `${t.key}.png`), await maskToPng(t.mask));
      for (const f of floors) files.write(at('masks', 'floors', `${f.key}.png`), await maskToPng(f.mask));
      const layers = [...floors.map((f) => ({ key: f.key, mask: f.mask, alpha: 0.25 })), ...things.map((t) => ({ key: t.key, mask: t.mask, alpha: 0.45 }))];
      const tints = layers.map((l, i) => ({ mask: l.mask, alpha: l.alpha, rgb: PALETTE[i % PALETTE.length] }));
      const labels = [...floors.map((f) => ({ key: f.key, box: maskBox(f.mask) })), ...things.map((t) => ({ key: t.key, box: t.box as Rect | undefined }))]
        .map((l, i) => (l.box ? svgLabel(l.box[0] + 4, l.box[1] + 18, l.key, PALETTE[i % PALETTE.length]) : ''));
      files.write(at('masks', 'overlay.png'), await tintOver(painting, tints, labels.join('')));
      // A corrected box guides SAM; it does not prove what SAM cut out. Kept masks retain their check.
      let checks: Record<string, MaskCheck> = Object.fromEntries(things.flatMap((t) => (keptThing.has(t.key) && lastChecks[t.key]?.check && JSON.stringify(t.box) === JSON.stringify(lastChecks[t.key].box) ? [[t.key, lastChecks[t.key].check!]] : [])));
      try {
        const look = things.filter((t) => !checks[t.key]);
        // Asked by what the thing is (the world's words), not by how the brief dressed it: a brief that described
        // "the empty stall the cow uses" let a mask on an empty stall pass.
        if (look.length) checks = { ...checks, ...await checkMasks(files.memo, place.key, painting, look.map((t) => ({ key: t.key, looks: place.things.find((x) => x.key === t.key)?.looks ?? brief.looks[t.key] ?? t.key, box: t.box as Rect | undefined }))) };
        for (const [key, c] of Object.entries(checks)) if (!c.ok) log(`${key}: Spark sees ${c.seen ?? 'something else'} in its mask`);
      } catch (error) {
        throw new Error(`mask check failed: ${error instanceof Error ? error.message : error}`);
      }
      const round = (v: number) => Math.round(v * 100) / 100;
      files.write(at('masks.json'), {
        things: Object.fromEntries(things.map(({ key, mask: _, ...t }) => [key, { ...t, ...(checks[key] && { check: checks[key] }) }])),
        floors: Object.fromEntries(floors.map(({ key, mask: _, iouCells, iouLayout, ...f }) => [key, { ...f, iouCells: round(iouCells), iouLayout: round(iouLayout) }])),
        flagged,
      });
      // After a carry the old painting stays the one the answers belong to, so a rerun on this painting asks nothing new.
      ran(at(), 'masks', carry?.old ?? painting);
      const coarse = [...things, ...floors].filter((m) => m.coarse).map((m) => m.key);
      console.log(`${place.key}: ${things.length} things, ${floors.length} floors${coarse.length ? `, coarse: ${coarse.join(', ')}` : ''}`);
    }));
    console.log(`calls sent: spark ${files.memo.sent.spark}, sam ${files.memo.sent.sam}`);
  },
});
