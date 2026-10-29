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
import { POSE_OK } from '../model/sprites.ts';
import { readBodies } from '../scene/cast.ts';
import { WorldFiles } from '../world/files.ts';
import { liveVoiceFailures } from '../sound/data.ts';
import { voiceRetryTarget } from '../sound/retry.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction, type ActionContext } from './registry.ts';

const stamp = (file: string) => (fs.existsSync(file) ? Math.round(fs.statSync(file).mtimeMs) : null);
const ModelAttempt = z.object({ state: z.enum(['ready', 'fallback', 'failed']), reason: z.string().nullable(), at: z.string() });
const RigAttempt = z.object({ ok: z.boolean(), reason: z.string().nullable(), at: z.string() });

defineAction({
  name: 'voice_retry',
  description: 'Retry one missing spoken line using its exact speaker key and text from cast_status voiceFailures. Keeps the selected voice and all other recordings. Rejected takes get fresh seeds; a transcription outage reuses saved audio. Costs ElevenLabs/verification calls when needed; wait with job_wait, then check cast_status and play_reload.',
  input: z.object({ slug: Slug, key: Slug, text: z.string().min(1).max(5000) }),
  job: true,
  async run({ slug, key, text }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    const blocked = agentBlocked(files.dir, ctx.by);
    if (blocked) throw new ActionError(423, blocked);
    voiceRetryTarget(files, key, text);
    return ctx.jobs.start(slug, ['voice-retry', slug, key, text], `retry line ${key}`, ctx.by);
  },
});

function pendingModel(ctx: ActionContext, slug: string, key: string) {
  return ctx.jobs.list(slug).find((j) => (j.state === 'queued' || j.state === 'running')
    && j.args.length >= 3 && j.args[0] === 'model' && j.args[1] === slug && j.args[2] === key);
}

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

function prepareFix(ctx: ActionContext, slug: string, key: string, change: (f: CastFixes[string]) => void) {
  const files = new WorldFiles(slug, ctx.root);
  if (key !== 'narrator' && !characters(files).some((c) => c.key === key)) throw new ActionError(404, `${slug} has no hero or NPC called ${key}`);
  const blocked = agentBlocked(files.dir, ctx.by);
  if (blocked) throw new ActionError(423, blocked);
  return () => {
    const fixes = readCastFixes(files);
    const fix = (fixes[key] ??= {});
    change(fix);
    fs.mkdirSync(path.dirname(castFixesFile(files)), { recursive: true });
    files.write(castFixesFile(files), CastFixes.parse(fixes));
  };
}

defineAction({
  name: 'cast_status',
  reads: true,
  description: 'Every character of a world (hero and NPCs): how they look (and the person\'s fixes), which parts exist (cut-out figure, rig, 3D model, sprite sheets; '
    + 'rigIssue says why there is no 2D walk, modelIssue why a model is not used, e.g. flat), how the game moves them (moves: sprites, 3D model, 2D rig or the cut-out sliding as one piece), '
    + 'their voice and how many lines they speak, with a sample, and voiceFailures for lines the story still has that have no recording.',
  input: z.object({ slug: Slug }),
  async run({ slug }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('world.json'))) throw new ActionError(404, `no world ${slug} yet`);
    const fixes = readCastFixes(files);
    const voices = fs.existsSync(files.path('voices.json')) ? Voices.safeParse(files.readJson(files.path('voices.json'))) : null;
    const pic = (f: string) => (fs.existsSync(files.path(f)) ? { file: f, v: stamp(files.path(f)) } : null);
    const bodies = readBodies(files, fs.existsSync);
    const failures = liveVoiceFailures(files);
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
        ...(() => {
          const file = files.path('cast', c.key, 'rig-attempt.json');
          const a = fs.existsSync(file) ? RigAttempt.safeParse(files.readJson(file)) : null;
          return { rigIssue: a?.success && !a.data.ok ? a.data.reason : null };
        })(),
        // Metres tall and whether upright on two legs; not upright (a creature) moves as one body, no 2D rig or sheets.
        body: bodies[c.key] ?? null,
        ...(() => {
          // A flat model (and the sheets painted over it) is not used by the game; say why instead.
          const has = fs.existsSync(files.path('cast', c.key, 'model', 'model.json'));
          const attemptFile = files.path('cast', c.key, 'model', 'attempt.json');
          const parsed = fs.existsSync(attemptFile) ? ModelAttempt.safeParse(files.readJson(attemptFile)) : null;
          const modelAttempt = parsed?.success ? parsed.data : null;
          const modelIssue = has ? modelProblem(files.path('cast', c.key, 'model')) : modelAttempt?.reason ?? null;
          const pending = pendingModel(ctx, slug, c.key);
          const sprites = !modelIssue && fs.existsSync(files.path('cast', c.key, 'sprites', 'sprites.json'));
          const rigged = fs.existsSync(files.path('cast', c.key, 'rig.json'));
          const creature = bodies[c.key]?.upright === false;
          // What the game does with them, in the order it prefers: the person sees the fallback, not a silent gap.
          const moves = !fs.existsSync(files.path('cast', `${c.key}.png`)) ? 'not painted: a stand-in'
            : sprites ? 'walks with painted sprite sheets' : has && !modelIssue ? (creature ? 'moves as its 3D model (hops, breathes, blinks)' : 'walks as its 3D model')
              : rigged ? 'walks with its 2D rig (the painting bent by its bones)' : 'the cut-out slides as one piece (no rig, no model)';
          // Walk sheets whose frames left the pose (Muse turned some frames to another facing): the walk stutters there.
          const sheet = sprites ? z.object({ facings: z.record(z.string(), z.object({ iou: z.array(z.number()).optional() })).optional() }).safeParse(files.readJson(files.path('cast', c.key, 'sprites', 'sprites.json'))) : null;
          const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
          const spriteIssues = sheet?.success ? Object.entries(sheet.data.facings ?? {}).filter(([, f]) => f.iou?.length && mean(f.iou) < POSE_OK).map(([f, x]) => `walk ${f}: frames left the pose (pose IoU ${mean(x.iou!).toFixed(2)}); sprites_redo paints new takes`) : [];
          return {
            model: has && !modelIssue, sprites, modelIssue, modelAttempt, moves, spriteIssues,
            modelJob: pending ? { id: pending.id, state: pending.state } : null,
            // When each was last written, so Studio's preview reloads them after a rebuild.
            stamps: { rig: stamp(files.path('cast', c.key, 'rig.json')), model: has && !modelIssue ? stamp(files.path('cast', c.key, 'model', 'model.json')) : null, sprites: sprites ? stamp(files.path('cast', c.key, 'sprites', 'sprites.json')) : null },
          };
        })(),
        voice: voices?.success ? voices.data.cast[c.key] ?? null : null,
        lines: lines.length,
        flagged: lines.filter((l) => l.flags.some((f) => f.startsWith('heard'))).length,
        voiceFailures: failures.filter((l) => l.speaker === c.key),
        voiceWarnings: voices?.success ? voices.data.cast[c.key]?.warnings ?? [] : [],
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
    const prepare = prepareFix(ctx, slug, key, (f) => {
      if (looks) f.looks = looks;
      if (anotherTake) f.take = (f.take ?? 0) + 1;
    });
    return ctx.jobs.start(slug, ['cast', slug, key], `cast ${key}`, ctx.by, prepare);
  },
});

defineAction({
  name: 'cast_animate',
  description: 'Give a character a 3D model now, also one the build skips (an NPC with no lines, a creature or an animated object): '
    + 'Muse paints it from 4 sides, TRELLIS builds the model (HF, only where the HF token works). A creature (not upright, cast_status body) gets no skeleton: '
    + 'in the game it hops, squashes as it lands, leans, breathes and blinks as one body. Kept across rebuilds (the model step builds it every time). For a walking or speaking person, the same job also builds sprites and chooses 16-frame UV automatically when supported. Runs as a job.',
  input: z.object({ slug: Slug, key: z.string().min(1) }),
  job: true,
  async run({ slug, key }, ctx) {
    const prepare = prepareFix(ctx, slug, key, (f) => void (f.animate = true));
    const pending = pendingModel(ctx, slug, key);
    if (pending) return pending;
    return ctx.jobs.start(slug, ['model', slug, key, '--sprites'], `animate ${key}`, ctx.by, prepare);
  },
});

defineAction({
  name: 'cast_rewalk',
  description: 'Make a character\'s 2D walk again from its painting (no Muse calls): the painting bent by its bones as one piece, so an apron, a coat '
    + 'or a skirt stretches with the legs and never tears, and what they hold (a lantern, a net) stays on. Use it when the person says a walk tears, '
    + 'a leg or arm comes off, or the figure has holes; then play_reload. Without key, every character. Runs as a job.',
  input: z.object({ slug: Slug, key: z.string().min(1).optional() }),
  job: true,
  async run({ slug, key }, ctx) {
    return ctx.jobs.start(slug, ['rig', slug, ...(key ? [key] : [])], key ? `walk ${key}` : 'walk the cast', ctx.by);
  },
});

defineAction({
  name: 'sprites_redo',
  description: 'Paint a character\'s walk and talk sprite sheets again over their 3D model (new Muse takes, the picture of the character stays): '
    + 'for cast_status spriteIssues (walk frames that left the pose) or when the person says the walk looks wrong in one direction. '
    + 'Up to 5 takes per facing, the one that keeps the pose wins; kept across rebuilds. About 2-10 Muse Image calls per facing. Runs as a job; then play_reload.',
  input: z.object({ slug: Slug, key: z.string().min(1) }),
  job: true,
  async run({ slug, key }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('cast', key, 'model', 'model.json')) || modelProblem(files.path('cast', key, 'model'))) {
      throw new ActionError(409, `${key} has no usable 3D model, so no sheets to paint: cast_animate makes one first`);
    }
    const prepare = prepareFix(ctx, slug, key, (f) => void (f.spriteTake = (f.spriteTake ?? 0) + 1));
    return ctx.jobs.start(slug, ['sprites', slug, key, '--tries', '3'], `sheets ${key}`, ctx.by, prepare);
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
    const prepare = prepareFix(ctx, slug, key, (f) => void (f.voice = { voice, why: 'chosen by the person', ...(design && { design }), ...(stability !== undefined && { stability }), ...(style !== undefined && { style }) }));
    return ctx.jobs.start(slug, ['voices', slug], `voice ${key}`, ctx.by, prepare);
  },
});
