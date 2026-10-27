// diorama plates <slug> [place...]: plates/<thing>.png for every thing the story lets the hero carry off.
import fs from 'node:fs';
import { maskFromPng, maskArea } from '../image/mask.ts';
import { dilate, intersect } from '../image/raster.ts';
import { defineCommand } from '../registry.ts';
import { Brief } from '../scene/brief.ts';
import { Layout } from '../scene/layout.ts';
import { changePlate, plateFor } from '../scene/plates.ts';
import { removableThings } from '../story/engine.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'plates',
  usage: 'plates <slug> [place...]  paint each place without the things the hero can take, and with the things the story changes (needs story.json)',
  async run([slug, ...only]) {
    if (!slug) throw new Error('usage: diorama plates <slug> [place...]');
    const files = new WorldFiles(slug);
    const world = files.world();
    if (!fs.existsSync(files.path('story.json'))) {
      console.log('no story.json: nothing is carried off, no plates needed');
      return;
    }
    const story = Story.parse(files.readJson(files.path('story.json')));
    const removable = removableThings(story);
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));
    await Promise.all(places.map(async (place) => {
      const at = (...parts: string[]) => files.place(place.key, ...parts);
      fs.rmSync(at('plates'), { recursive: true, force: true });
      fs.rmSync(at('changes'), { recursive: true, force: true });
      const keys = removable.filter((r) => r.place === place.key).map((r) => r.thing);
      const changes = story.changes.map((c, i) => ({ ...c, i })).filter((c) => c.place === place.key);
      if (!keys.length && !changes.length) return;
      const notes = (files.readJson(at('masks.json')) as { things: Record<string, { phrase: string }> }).things;
      const painted = fs.readFileSync(at('painting.png'));
      // changes/<i>.png: the place once story.changes[i] holds, drawn by the runtime over the painting.
      for (const c of changes) {
        if (!notes[c.thing]) {
          console.log(`  ${place.key}: ${c.thing} has no mask, no change plate`);
          continue;
        }
        const mask = await maskFromPng(fs.readFileSync(at('masks', `${c.thing}.png`)));
        files.write(at('changes', `${c.i}.png`), await changePlate(files.memo, place, { key: c.thing, phrase: notes[c.thing].phrase, mask }, painted, c.looks));
        console.log(`${place.key}: ${c.thing} once ${c.when.join(', ')}: ${c.looks}`);
      }
      if (!keys.length) return;
      const layout = Layout.parse(files.readJson(at('layout.json')));
      const brief = Brief.parse(files.readJson(at('brief.json')));
      const painting = fs.readFileSync(at('painting.png'));
      const floors = await Promise.all(layout.floors.map(async (f) => ({ f, mask: await maskFromPng(fs.readFileSync(at('masks', 'floors', `${f.key}.png`))) })));
      const report: Record<string, { stillThere: boolean; iou: number; ringError: number; stain: number }> = {};
      for (const key of keys) {
        if (!notes[key]) {
          console.log(`  ${place.key}: ${key} has no mask, no plate`);
          continue;
        }
        const mask = await maskFromPng(fs.readFileSync(at('masks', `${key}.png`)));
        // The floor around it says what to paint where it stood.
        const ring = dilate(mask, 16);
        const under = floors.map(({ f, mask: m }) => ({ f, px: maskArea(intersect(m, ring)) })).sort((a, b) => b.px - a.px)[0];
        const ground = under?.px ? (brief.looks[under.f.key] ?? under.f.is) : 'the ground around it';
        const plate = await plateFor(files.memo, place, { key, phrase: notes[key].phrase, mask }, painting, ground);
        files.write(at('plates', `${key}.png`), plate.png);
        report[key] = { stillThere: plate.stillThere, iou: Math.round(plate.iou * 100) / 100, ringError: Math.round(plate.ringError * 10) / 10, stain: Math.round(plate.stain * 100) / 100 };
        console.log(`${place.key}: plate for ${key} (seam ${plate.ringError.toFixed(1)}, stain ${Math.round(plate.stain * 100)}%)${plate.stillThere ? ' (SAM still finds it: check the plate)' : ''}`);
      }
      files.write(at('plates.json'), report);
    }));
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
