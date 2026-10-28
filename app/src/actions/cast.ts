// The cast: the hero and every NPC, how each looks, which parts the runtime has for them (cut-out, rig,
// 3D model, sprite sheets) and which voice speaks their lines. Fixes go to cast/fixes.json.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { CastFixes, castFixesFile, readCastFixes } from '../scene/cast-fixes.ts';
import { DESIGNED, designDescriptions, needsDesign, stockVoices, voiceCandidates, Voices } from '../sound/voices.ts';
import { agentBlocked } from '../studio/locks.ts';
import { players } from '../world/drawings.ts';
import { modelProblem } from '../model/glb.ts';
import { readBodies } from '../scene/cast.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction, type ActionContext } from './registry.ts';

const stamp = (file: string) => (fs.existsSync(file) ? Math.round(fs.statSync(file).mtimeMs) : null);

function characters(files: WorldFiles) {
  const world = files.world();
  const npcs = new Map(world.places.flatMap((p) => p.things.filter((t) => t.role === 'npc').map((t) => [t.key, { ...t, place: p.key }] as const)));
  return [
    { key: world.hero.key, looks: world.hero.looks, role: 'hero' as 'hero' | 'npc' | 'player', place: null as string | null },
    ...[...npcs.values()].map((n) => ({ key: n.key, looks: n.looks, role: 'npc' as const, place: n.place })),
    // Heroes for more gamepads (drawings marked player): painted and rigged like the hero, in no place.
    ...players(files).map((p) => ({ key: p.key, looks: p.looks, role: 'player' as const, place: null })),
  ];
}

function writeFix(ctx: ActionContext, slug: string, key: string, change: (f: CastFixes[string]) => void) {
  const files = new WorldFiles(slug, ctx.root);
  if (key !== 'narrator' && !characters(files).some((c) => c.key === key)) throw new ActionError(404, `${slug} has no hero or NPC called ${key}`);
  const blocked = agentBlocked(files.dir, ctx.by);
  if (blocked) throw new ActionError(423, blocked);
  const fixes = readCastFixes(files);
  const fix = (fixes[key] ??= {});
  change(fix);
  fs.mkdirSync(path.dirname(castFixesFile(files)), { recursive: true });
  files.write(castFixesFile(files), CastFixes.parse(fixes));
  return files;
}

defineAction({
  name: 'cast_status',
  reads: true,
  description: 'Every character of a world (hero and NPCs): how they look (and the person\'s fixes), which parts exist (cut-out figure, rig, 3D model, sprite sheets; modelIssue says why a model is not used, e.g. flat), their voice and how many lines they speak, with a sample.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('world.json'))) throw new ActionError(404, `no world ${slug} yet`);
    const fixes = readCastFixes(files);
    const voices = fs.existsSync(files.path('voices.json')) ? Voices.safeParse(files.readJson(files.path('voices.json'))) : null;
    const pic = (f: string) => (fs.existsSync(files.path(f)) ? { file: f, v: stamp(files.path(f)) } : null);
    const bodies = readBodies(files, fs.existsSync);
    const narrator = voices?.success && voices.data.cast.narrator ? [{ key: 'narrator', looks: 'reads the intro and the endings', role: 'narrator' as const, place: null }] : [];
    return [...characters(files), ...narrator].map((c) => {
      const lines = voices?.success ? voices.data.lines.filter((l) => l.speaker === c.key) : [];
      return {
        ...c,
        looksNow: fixes[c.key]?.looks ?? c.looks,
        fix: fixes[c.key] ?? null,
        figure: pic(`cast/${c.key}.png`),
        painting: pic(`cast/${c.key}-painting.png`),
        rig: fs.existsSync(files.path('cast', c.key, 'rig.json')),
        // Metres tall and whether upright on two legs; not upright (a creature) moves as one body, no 2D rig or sheets.
        body: bodies[c.key] ?? null,
        ...(() => {
          // A flat model (and the sheets painted over it) is not used by the game; say why instead.
          const has = fs.existsSync(files.path('cast', c.key, 'model', 'model.json'));
          const modelIssue = has ? modelProblem(files.path('cast', c.key, 'model')) : null;
          const sprites = !modelIssue && fs.existsSync(files.path('cast', c.key, 'sprites', 'sprites.json'));
          return {
            model: has && !modelIssue, sprites, modelIssue,
            // When each was last written, so Studio's preview reloads them after a rebuild.
            stamps: { rig: stamp(files.path('cast', c.key, 'rig.json')), model: has && !modelIssue ? stamp(files.path('cast', c.key, 'model', 'model.json')) : null, sprites: sprites ? stamp(files.path('cast', c.key, 'sprites', 'sprites.json')) : null },
          };
        })(),
        voice: voices?.success ? voices.data.cast[c.key] ?? null : null,
        lines: lines.length,
        flagged: lines.filter((l) => l.flags.some((f) => f.startsWith('heard'))).length,
        sample: lines[0] ? { text: lines[0].text, file: lines[0].file } : null,
      };
    });
  },
});

defineAction({
  name: 'cast_redo',
  description: 'Paint a character again: with a new description of how they look (kept across rebuilds), or simply another take. '
    + 'Repaints and cuts out the figure (Muse + SAM); run_step model and sprites afterwards if the character walks with sprites. Runs as a job.',
  input: z.object({ slug: Slug, key: z.string().min(1), looks: z.string().min(10).optional(), anotherTake: z.boolean().optional() }),
  job: true,
  async run({ slug, key, looks, anotherTake }, ctx) {
    if (!looks && !anotherTake) throw new ActionError(400, 'give new looks, or anotherTake: true');
    writeFix(ctx, slug, key, (f) => {
      if (looks) f.looks = looks;
      if (anotherTake) f.take = (f.take ?? 0) + 1;
    });
    return ctx.jobs.start(slug, ['cast', slug, key], `cast ${key}`, ctx.by);
  },
});

defineAction({
  name: 'cast_animate',
  description: 'Give a character a 3D model now, also one the build skips (an NPC with no lines, a creature or an animated object): '
    + 'Muse paints it from 4 sides, TRELLIS builds the model (HF, only where the HF token works). A creature (not upright, cast_status body) gets no skeleton: '
    + 'in the game it hops, squashes as it lands, leans, breathes and blinks as one body. Kept across rebuilds (the model step builds it every time). 4 Muse Image calls + TRELLIS. Runs as a job.',
  input: z.object({ slug: Slug, key: z.string().min(1) }),
  job: true,
  async run({ slug, key }, ctx) {
    writeFix(ctx, slug, key, (f) => void (f.animate = true));
    return ctx.jobs.start(slug, ['model', slug, key], `animate ${key}`, ctx.by);
  },
});

defineAction({
  name: 'voice_list',
  reads: true,
  description: 'The stock ElevenLabs voices a character can be given: id, name and what they sound like. With slug and key, '
    + 'the voices that fit that character (gender and age Spark saw in their figure) come first, marked fits. The first entry, id "design", is a voice ElevenLabs Voice Design makes from a description: '
    + 'children, teens and the old always get one, since no stock voice is a child or truly old.',
  input: z.object({ slug: Slug.optional(), key: z.string().min(1).optional() }),
  async run({ slug, key }, ctx) {
    let stock;
    try {
      stock = await stockVoices();
    } catch (error) {
      throw new ActionError(503, `no voices: ${error instanceof Error ? error.message : error}`);
    }
    const files = slug ? new WorldFiles(slug, ctx.root) : undefined;
    const voices = files && fs.existsSync(files.path('voices.json')) ? Voices.safeParse(files.readJson(files.path('voices.json'))) : null;
    const profile = key && voices?.success ? voices.data.cast[key]?.profile : undefined;
    const fit = new Set(profile ? voiceCandidates(stock, profile).map((v) => v.voice_id) : []);
    const list = stock.map((v) => ({ id: v.voice_id, name: v.name, sounds: [...Object.values(v.labels ?? {}), v.description].filter(Boolean).join(', '), ...(profile && { fits: fit.has(v.voice_id) && !needsDesign(profile) }) }));
    const now = key && voices?.success ? voices.data.cast[key]?.design?.description : undefined;
    list.unshift({ id: DESIGNED, name: 'Designed for this character', sounds: now ?? (profile ? designDescriptions(profile)[0] : 'made from a description'), ...(profile && { fits: true }) });
    return profile ? { character: { key, ...profile }, voices: [...list.filter((v) => v.fits), ...list.filter((v) => !v.fits)] } : list;
  },
});

defineAction({
  name: 'voice_set',
  description: 'Give a character another voice (an id from voice_list), optionally steadier (stability up) or more expressive (style up). '
    + 'voice "design" with design (English, how they sound: "a very old man, gravelly, slow") makes a new voice with ElevenLabs Voice Design; never name a child or an age in years there, ElevenLabs refuses it nor "girl" or "boy" ("youthful high-pitched male character voice for an animated game" works). '
    + 'Kept across rebuilds; speaks the lines again (only that character\'s lines cost anything). Runs as a job.',
  input: z.object({ slug: Slug, key: z.string().min(1), voice: z.string().min(1), design: z.string().min(10).optional(), stability: z.number().min(0).max(1).optional(), style: z.number().min(0).max(1).optional() }),
  job: true,
  async run({ slug, key, voice, design, stability, style }, ctx) {
    if (design && voice !== DESIGNED) throw new ActionError(400, `design goes with voice "${DESIGNED}"`);
    writeFix(ctx, slug, key, (f) => void (f.voice = { voice, why: 'chosen by the person', ...(design && { design }), ...(stability !== undefined && { stability }), ...(style !== undefined && { style }) }));
    return ctx.jobs.start(slug, ['voices', slug], `voice ${key}`, ctx.by);
  },
});
