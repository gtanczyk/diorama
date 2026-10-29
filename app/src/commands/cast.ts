// diorama cast <slug>: the hero and every NPC of world.json as cut-out figures the runtime walks around.
import fs from 'node:fs';
import { defineCommand, takeOption } from '../registry.ts';
import { castBodies, cutHero, paintFigure, readBodies, type Who } from '../scene/cast.ts';
import { samFind } from '../meta/sam.ts';
import { photoStanding } from '../scene/photo.ts';
import { rigFigure } from '../scene/rig.ts';
import { checkSheet } from '../scene/rig-check.ts';
import { PART_NAMES } from '../play/rig.ts';
import { fixedLooks, readCastFixes } from '../scene/cast-fixes.ts';
import { drawingFor, players, readDrawn } from '../world/drawings.ts';
import { WorldFiles } from '../world/files.ts';
import { castStyle, markStyled, readStyled } from '../world/styled.ts';

defineCommand({
  name: 'cast',
  usage: 'cast <slug> [key...]     paint the hero, NPCs and players (heroes for more gamepads, drawings marked player) with Muse, cut them out with SAM 3.1 (cast/<key>.png) [--take N] [--photo me.jpg: paint the hero from a photo, standing even if they sit in it] (a character a child drew, drawings.json, is painted from the drawing)',
  async run(args) {
    const take = Number(takeOption(args, 'take', '0'));
    const photoPath = takeOption(args, 'photo', '');
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama cast <slug> [key...] [--take N]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const styled = readStyled(files);
    // world --hero-photo keeps the photo next to the cast, so a plain `cast` uses it too.
    const kept = files.path('cast', `${world.hero.key}-photo.png`);
    const photo = photoPath ? fs.readFileSync(photoPath) : fs.existsSync(kept) ? fs.readFileSync(kept) : undefined;
    // Only a person standing whole in the photo keeps the photo's pose; anyone sitting, lying or cut off is painted standing.
    const standing = photo ? await photoStanding(files.memo, photo) : false;
    if (photo && !standing) console.log(`${world.hero.key}: the photo does not show them standing whole; painted standing`);
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
      // A character painted before in another style (style_set) is repainted from that painting, so they stay who
      // they were; the hero from a photo is painted from the photo again, in the new style.
      const style = castStyle(files, world, who.key);
      const was = styled.cast[who.key];
      const before = files.path('cast', `${who.key}-painting.png`);
      const heroPhoto = who.key === world.hero.key ? photo : undefined;
      const restyle = was && was !== style && !heroPhoto && fs.existsSync(before) ? { painting: fs.readFileSync(before), was } : undefined;
      const made = await paintFigure(files.memo, { ...world, style }, who, fixes[who.key]?.take ?? take, { photo: heroPhoto, standing, drawing: drawingFor(files, who.key), restyle }, bodies[who.key]?.upright !== false).catch((error: Error) => {
        if (who.key === world.hero.key) throw error;
        missing.push(`${who.key}: ${error.message}`);
        return null;
      });
      if (!made) return;
      const { painting, figure } = made;
      files.write(files.path('cast', `${who.key}-painting.png`), painting);
      files.write(files.path('cast', `${who.key}.png`), figure);
      markStyled(files, 'cast', who.key, style);
      // The same painting cut into parts, so the runtime can walk the figure.
      if (bodies[who.key]?.upright === false) return console.log(`${who.key}: ${files.path('cast', `${who.key}.png`)} · not upright: drawn as painted`);
      await rigCast(files, who.key, painting);
    }));
    for (const m of missing) console.log(`set aside, shown as a stand-in: ${m}`);
    console.log(`calls sent: muse ${files.memo.sent.muse}, sam ${files.memo.sent.sam}`);
  },
});

/**
 * The painting made walkable: the whole figure warped by its bones into a walk sheet (cast/<key>/walk.png) and
 * rig.json with the joints and how the walk measured. A walk that tears is kept but marked, and the game slides
 * the painted figure as one piece instead. Parts of an older cut-out rig are removed.
 */
export async function rigCast(files: WorldFiles, key: string, painting: Buffer) {
  try {
    const { rig, parts, issues } = await rigFigure(files.memo, key, painting);
    for (const name of PART_NAMES) fs.rmSync(files.path('cast', key, `${name}.png`), { force: true });
    for (const [file, png] of Object.entries(parts)) files.write(files.path('cast', key, file), png);
    rig.check = rig.sheet ? await checkSheet(rig, parts[rig.sheet.file]) : undefined;
    files.write(files.path('cast', key, 'rig.json'), rig);
    const verdict = rig.check && !rig.check.ok ? ` · walk torn (${rig.check.why}): slides as one piece` : '';
    console.log(`${key}: ${files.path('cast', `${key}.png`)} · walk sheet ${rig.sheet?.frames ?? 0} frames${verdict}${issues.map((i) => ` · ${i}`).join('')}`);
  } catch (error) {
    console.log(`${key}: ${files.path('cast', `${key}.png`)} · no rig: ${error instanceof Error ? error.message : error}`);
  }
}

defineCommand({
  name: 'rig',
  usage: 'rig <slug> [key...]     make the walk again from the cast paintings already painted (no Muse; SAM answers are kept), and cut the figure out again so what it holds stays on',
  async run(args) {
    const [slug, ...only] = args;
    if (!slug) throw new Error('usage: diorama rig <slug> [key...]');
    const files = new WorldFiles(slug);
    const bodies = readBodies(files, fs.existsSync);
    const keys = fs.readdirSync(files.path('cast')).filter((f) => f.endsWith('-painting.png')).map((f) => f.slice(0, -'-painting.png'.length)).filter((k) => !only.length || only.includes(k));
    for (const key of keys) {
      if (bodies[key]?.upright === false) continue;
      const painting = fs.readFileSync(files.path('cast', `${key}-painting.png`));
      const person = (await samFind(files.memo, { label: `figure:${key}`, image: painting, prompt: 'person' })).sort((a, b) => b.mask.bits.reduce((s, x) => s + x, 0) - a.mask.bits.reduce((s, x) => s + x, 0))[0];
      if (person) files.write(files.path('cast', `${key}.png`), await cutHero(painting, person.mask));
      await rigCast(files, key, painting);
    }
    console.log(`calls sent: sam ${files.memo.sent.sam}`);
  },
});
