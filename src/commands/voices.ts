// diorama voices <slug>: every line of the story spoken. Spark casts the voices (kept in voices.json, edit to recast),
// ElevenLabs reads, Muse Voice Transcribe checks each take says its line.
import fs from 'node:fs';
import { defineCommand } from '../registry.ts';
import { elevenKey } from '../sound/sources.ts';
import { castVoices, stockVoices, storyLines, voiceLine, Voices, type Cast } from '../sound/voices.ts';
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
    if (old && !recast && lines.every((l) => old.cast[l.speaker])) cast = old.cast;
    else cast = await castVoices(files.memo, world, story, lines, await stockVoices());
    for (const [who, v] of Object.entries(cast)) console.log(`  ${who.padEnd(16)} ${v.voice}  ${v.why}`);

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
          console.log(`  ${l.match >= 0.9 ? 'ok  ' : 'FLAG'} ${l.speaker.padEnd(14)} ${l.seconds.toFixed(1).padStart(5)} s  ${l.text.slice(0, 60)}${l.flags.length ? `  (${l.flags.join('; ')}; heard "${l.heard.slice(0, 60)}")` : ''}`);
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
