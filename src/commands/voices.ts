// diorama voices <slug>: every line of the story spoken. Spark casts the voices (kept in voices.json; voice_set in the Studio recasts one),
// ElevenLabs reads, Muse Voice Transcribe checks each take says its line.
import fs from 'node:fs';
import { defineCommand } from '../registry.ts';
import { elevenKey } from '../sound/sources.ts';
import { castVoices, stockVoices, storyLines, voiceLine, Voices, type Cast } from '../sound/voices.ts';
import { fixedLooks, readCastFixes } from '../scene/cast-fixes.ts';
import { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';

defineCommand({
  name: 'voices',
  usage: 'voices <slug>            cast a voice per character and speak every story line, checked by Muse Voice Transcribe; conversations, intro and endings [--all: every line] [--recast]',
  async run(args) {
    const recast = args.includes('--recast');
    const [slug] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama voices <slug>');
    const files = new WorldFiles(slug);
    const world = files.world();
    if (!fs.existsSync(files.path('story.json'))) return void console.log('no story.json: nothing to say');
    if (!elevenKey()) return void console.log('no ELEVENLABS_API_KEY: lines stay unspoken');
    const story = Story.parse(files.readJson(files.path('story.json')));
    const lines = storyLines(world, story, args.includes('--all'));
    const outFile = files.path('voices.json');
    const old = fs.existsSync(outFile) ? Voices.parse(files.readJson(outFile)) : undefined;
    let cast: Cast;
    // A cast is kept only when it was made from profiles (who Spark saw in each figure); older casts are redone.
    if (old && !recast && lines.every((l) => old.cast[l.speaker]?.profile)) cast = old.cast;
    else {
      const figure = (key: string) => (fs.existsSync(files.path('cast', `${key}.png`)) ? fs.readFileSync(files.path('cast', `${key}.png`)) : undefined);
      const people = [world.hero, ...world.places.flatMap((p) => p.things).filter((t) => t.role === 'npc')];
      const speakers = people.map((p) => ({ ...fixedLooks(files, { key: p.key, looks: p.looks }), figure: figure(p.key) }));
      cast = await castVoices(files.memo, world, lines, await stockVoices(), speakers);
    }
    // The voices the person picked (cast/fixes.json) replace Spark's casting.
    for (const [key, fix] of Object.entries(readCastFixes(files))) if (fix.voice && cast[key]) cast = { ...cast, [key]: { ...cast[key], ...fix.voice } };
    for (const [who, v] of Object.entries(cast)) console.log(`  ${who.padEnd(16)} ${v.profile ? `${v.profile.age} ${v.profile.gender}`.padEnd(18) : ''} ${v.voice}${v.pitch ? ` +${v.pitch} st` : ''}  ${v.why}`);

    fs.rmSync(files.path('sound', 'voice'), { recursive: true, force: true });
    const done: Voices['lines'] = new Array(lines.length);
    let next = 0;
    await Promise.all(Array.from({ length: 4 }, async () => {
      while (next < lines.length) {
        const i = next++;
        try {
          done[i] = await voiceLine(files.memo, lines[i], cast[lines[i].speaker], (id, mp3) => {
            files.write(files.path('sound', 'voice', `${id}.mp3`), mp3);
            return `sound/voice/${id}.mp3`;
          });
          const l = done[i];
          console.log(`  ${!l.flags.some((f) => f.startsWith('heard')) ? 'ok  ' : 'FLAG'} ${l.speaker.padEnd(14)} ${l.seconds.toFixed(1).padStart(5)} s  ${l.text.slice(0, 60)}${l.flags.length ? `  (${l.flags.join('; ')}; heard "${l.heard.slice(0, 60)}")` : ''}`);
        } catch (error) {
          console.log(`  FAIL ${lines[i].speaker}: ${lines[i].text.slice(0, 50)}: ${error instanceof Error ? error.message : error}`);
        }
      }
    }));
    const spoken = done.filter(Boolean);
    files.write(outFile, { cast, lines: spoken });
    const s = files.memo.sent;
    console.log(`voices ${slug}: ${spoken.length}/${lines.length} lines, ${spoken.filter((l) => l.flags.some((f) => f.startsWith('heard'))).length} flagged · sent: spark ${s.spark}, voice ${s.voice} · ${outFile}`);
  },
});
