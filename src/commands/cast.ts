// diorama cast <slug>: the hero and every NPC of world.json as cut-out figures the runtime walks around.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { castBodies, paintFigure, readBodies, type Who } from '../scene/cast.ts';
import { rigFigure } from '../scene/rig.ts';
import { fixedLooks, readCastFixes } from '../scene/cast-fixes.ts';
import { drawingFor, players, readDrawn } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'cast',
  usage: 'cast <slug> [key...]     paint the hero, NPCs and players (heroes for more gamepads, drawings marked player) with Muse, cut them out with SAM 3.1 (cast/<key>.png) [--take N] [--photo me.jpg: paint the hero from a full-body photo] (a character a child drew, drawings.json, is painted from the drawing)',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const photoPath = takeOption(args, 'photo', '');
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama cast <slug> [key...] [--take N]');
    const files = new WorldFiles(slug);
    const world = files.world();
    // world --hero-photo keeps the photo next to the cast, so a plain `cast` uses it too.
    const kept = files.path('cast', `${world.hero.key}-photo.png`);
    const photo = photoPath ? fs.readFileSync(photoPath) : fs.existsSync(kept) ? fs.readFileSync(kept) : undefined;
    // A character a child drew is painted from what was read off the drawing, as its preview was, so the preview is the figure.
    const drawn = readDrawn(files);
    const drawnLooks = (w: Who): Who => ({ ...w, looks: drawn.find((d) => d.key === w.key && (d.kind === 'hero' || d.kind === 'npc' || d.kind === 'player'))?.looks ?? w.looks });
    const npcs = world.places.flatMap((p) => p.things.filter((t) => t.role === 'npc'));
    const fixes = readCastFixes(files);
    const cast: Who[] = [world.hero, ...new Map(npcs.map((n) => [n.key, n])).values(), ...players(files)].filter((w) => !only.length || only.includes(w.key)).map((w) => fixedLooks(files, drawnLooks(w)));
    const missing: string[] = [];
    // cast/figures.json: how tall each one stands and whether upright, so a cat or a child is drawn at its own
    // size and only those walking like a person get a rig (and later a model and sprites).
    const bodies = { ...readBodies(files, fs.existsSync), ...(await castBodies(files.memo, world, cast)) };
    files.write(files.path('cast', 'figures.json'), bodies);
    const odd = Object.entries(bodies).filter(([, b]) => Math.abs(b.height - 1.62) > 0.25 || !b.upright);
    if (odd.length) console.log(`bodies: ${odd.map(([k, b]) => `${k} ${b.height} m${b.upright ? '' : ', not upright'}`).join(', ')}`);
    await Promise.all(cast.map(async (who) => {
      // The person's description and chosen take (cast/fixes.json) win over the world's.
      // An NPC that cannot be cut out is set aside (the game draws a stand-in) so the rest of the cast is made.
      const made = await paintFigure(files.memo, world, who, fixes[who.key]?.take ?? take, { photo: who.key === world.hero.key ? photo : undefined, drawing: drawingFor(files, who.key) }).catch((error: Error) => {
        if (who.key === world.hero.key) throw error;
        missing.push(`${who.key}: ${error.message}`);
        return null;
      });
      if (!made) return;
      const { painting, figure } = made;
      files.write(files.path('cast', `${who.key}-painting.png`), painting);
      files.write(files.path('cast', `${who.key}.png`), figure);
      // The same painting cut into parts, so the runtime can walk the figure.
      if (bodies[who.key]?.upright === false) return console.log(`${who.key}: ${files.path('cast', `${who.key}.png`)} · not upright: drawn as painted`);
      try {
        const { rig, parts, issues } = await rigFigure(files.memo, who.key, painting);
        for (const [file, png] of Object.entries(parts)) files.write(files.path('cast', who.key, file), png);
        files.write(files.path('cast', who.key, 'rig.json'), rig);
        console.log(`${who.key}: ${files.path('cast', `${who.key}.png`)} · rig ${rig.parts.length} parts${issues.map((i) => ` · ${i}`).join('')}`);
      } catch (error) {
        console.log(`${who.key}: ${files.path('cast', `${who.key}.png`)} · no rig: ${error instanceof Error ? error.message : error}`);
      }
    }));
    for (const m of missing) console.log(`set aside, shown as a stand-in: ${m}`);
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});
