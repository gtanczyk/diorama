// diorama voices <slug>: every line of the story spoken. Spark casts the voices (kept in voices.json; voice_set in the Studio recasts one),
// ElevenLabs reads, Muse Voice Transcribe checks each take says its line.
import fs from 'node:fs';
import { inputHash } from '../meta/memo.ts';
import { defineCommand } from '../registry.ts';
import { creditGuard, soundQuality } from '../sound/cost.ts';
import { elevenKey } from '../sound/sources.ts';
import { castVoices, DESIGNED, freeVoiceSlot, voiceCandidates, DesignedVoices, designDescriptions, designVoice, needsDesign, stockVoices, storyLines, voiceLine, Voices, VOICE_PIPELINE, type Cast } from '../sound/voices.ts';
import { fixedLooks, readCastFixes } from '../scene/cast-fixes.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'voices',
  usage: 'voices <slug>            cast a voice per character (stock, or designed by ElevenLabs Voice Design for children, teens and the old) and speak every story line, checked by Muse Voice Transcribe; conversations, intro and endings [--all: every line; always for a world for kids, whose players cannot read] [--recast] [--draft: Flash and 2 takes; default final uses Multilingual v2 and up to 3 takes]',
  async run(args) {
    soundQuality(args);
    const recast = args.includes('--recast');
    const [slug] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama voices <slug>');
    const files = new WorldFiles(slug);
    const world = files.world();
    if (!fs.existsSync(files.path('story.json'))) return void console.log('no story.json: nothing to say');
    if (!elevenKey()) return void console.log('no ELEVENLABS_API_KEY: lines stay unspoken');
    const story = Story.parse(files.readJson(files.path('story.json')));
    const guard = await creditGuard(elevenKey(), 'voices');
    const lines = storyLines(world, story, args.includes('--all') || world.audience === 'kids');
    const outFile = files.path('voices.json');
    const old = fs.existsSync(outFile) ? Voices.parse(files.readJson(outFile)) : undefined;
    let cast: Cast;
    // A cast is kept only when it was made from profiles (who Spark saw in each figure) and every child, teen and old
    // speaker has a designed voice; older casts are redone.
    const fixes = readCastFixes(files);
    const figure = (key: string) => (fs.existsSync(files.path('cast', `${key}.png`)) ? fs.readFileSync(files.path('cast', `${key}.png`)) : undefined);
    const people = [world.hero, ...world.places.flatMap((p) => p.things).filter((t) => t.role === 'npc')];
    const speakers = people.map((p) => ({ ...fixedLooks(files, { key: p.key, looks: p.looks }), figure: figure(p.key) }));
    const castingFrom = inputHash(JSON.stringify(world), JSON.stringify(lines), ...speakers.flatMap((p) => [p.key, p.looks ?? '', p.figure ?? Buffer.alloc(0)]));
    const current = (k: string) => { const c = old?.cast[k]; return old?.pipeline === VOICE_PIPELINE && old.castingFrom === castingFrom && c?.profile?.language === (world.language ?? 'English') && (!needsDesign(c.profile) || !!c.design || !!fixes[k]?.voice); };
    if (old && !recast && lines.every((l) => current(l.speaker))) cast = old.cast;
    else {
      cast = await castVoices(files.memo, world, lines, await stockVoices(), speakers);
    }
    // The voices the person picked (cast/fixes.json) replace Spark's casting.
    for (const [key, fix] of Object.entries(fixes)) {
      if (!fix.voice || !cast[key]) continue;
      const { design: wish, ...voice } = fix.voice;
      const entry = { ...cast[key], ...voice };
      if (voice.voice === DESIGNED) {
        // A designed voice: from the person's description, or from the profile; designed again only when that changes.
        const description = wish ?? (cast[key].profile ? designDescriptions(cast[key].profile!)[0] : 'A clear warm voice.');
        const says = lines.filter((l) => l.speaker === key).map((l) => l.text);
        entry.design = cast[key].design?.request === description ? cast[key].design : await designVoice(files.memo, cast[key].profile ?? { gender: 'any', age: 'middle_aged', sound: '', language: world.language ?? 'English' }, says, description);
        entry.pitch = 0;
      } else delete entry.design;
      cast = { ...cast, [key]: entry };
    }
    for (const [who, v] of Object.entries(cast)) console.log(`  ${who.padEnd(16)} ${v.profile ? `${v.profile.age} ${v.profile.gender}`.padEnd(18) : ''} ${v.design ? 'designed' : v.voice}${v.pitch ? ` +${v.pitch} st` : ''}  ${v.why}`);

    // Lines no longer in the story go; the rest are rewritten (from the cache when nothing about them changed).
    // Keep existing files until replacements pass validation; a failed run must not delete paid recordings.
    // No free voice slot on the account: a designed voice cannot be created, so the nearest stock voice stands in.
    if (Object.values(cast).some((c) => c.design) && !(await freeVoiceSlot())) {
      const stock = await stockVoices();
      for (const [k, c] of Object.entries(cast)) {
        if (!c.design || !c.profile) continue;
        const v = voiceCandidates(stock, c.profile)[0] ?? stock[0];
        if (!v) throw new Error(`no stock voice available for ${k}`);
        console.log(`  ${k}: no free voice slot on the ElevenLabs account for a designed voice; ${v.name} stands in`);
        cast = { ...cast, [k]: { ...c, voice: v.voice_id, design: undefined, pitch: 0, warnings: ['No free Voice Design slot; a stock actor stands in. Audition this voice.'] } };
      }
    }
    const done: Voices['lines'] = new Array(lines.length);
    const failures: Voices['failures'] = [];
    // Designed voices live on the account only while their character's lines are read, one character at a time,
    // so a world needs a single free voice slot.
    const designed = new DesignedVoices(`diorama ${slug}`);
    const index = lines.map((_, i) => i);
    const groups = [index.filter((i) => !cast[lines[i].speaker].design), ...Object.keys(cast).filter((k) => cast[k].design).map((k) => index.filter((i) => lines[i].speaker === k))];
    try {
      for (const group of groups) {
        let next = 0;
        await Promise.all(Array.from({ length: 4 }, async () => {
          while (next < group.length) await read(group[next++]);
        }));
        await designed.close();
      }
    } finally {
      await designed.close();
    }
    async function read(i: number) {
      try {
        done[i] = await voiceLine(files.memo, lines[i], cast[lines[i].speaker], (id, mp3) => {
          files.write(files.path('sound', 'voice', `${id}.mp3`), mp3);
          return `sound/voice/${id}.mp3`;
        }, designed);
        const l = done[i];
        console.log(`  ${!l.flags.some((f) => f.startsWith('heard')) ? 'ok  ' : 'FLAG'} ${l.speaker.padEnd(14)} ${l.seconds.toFixed(1).padStart(5)} s  ${l.text.slice(0, 60)}${l.flags.length ? `  (${l.flags.join('; ')}; heard "${l.heard.slice(0, 60)}")` : ''}`);
      } catch (error) {
        failures.push({ speaker: lines[i].speaker, text: lines[i].text, reason: error instanceof Error ? error.message : String(error) });
        console.log(`  FAIL ${lines[i].speaker}: ${lines[i].text.slice(0, 50)}: ${error instanceof Error ? error.message : error}`);
      }
    }
    const spoken = done.filter(Boolean);
    files.write(outFile, { pipeline: VOICE_PIPELINE, castingFrom, cast, lines: spoken, failures });
    const s = files.memo.sent;
    console.log(`voices ${slug}: ${spoken.length}/${lines.length} lines, ${spoken.filter((l) => l.flags.some((f) => f.startsWith('heard'))).length} flagged · sent: spark ${s.spark}, voice ${s.voice} · ${await guard.report()} · ${outFile}`);
    if (failures.length) throw new Error(`${failures.length} spoken lines failed; see voices.json failures (rejected audio is not used)`);
  },
});
