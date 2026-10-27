// The story as children told it: recordings (told/), each heard by Muse Voice Transcribe (told/<clip>.txt),
// and Spark turning everything they said, and drew, into the idea a world is designed from.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { transcribe } from '../meta/voice.ts';
import { decode } from '../sound/pcm.ts';
import { elevenSpeech } from '../sound/sources.ts';
import { pcm24k, stockVoices } from '../sound/voices.ts';
import { keptName, type Drawn } from './drawings.ts';
import type { WorldFiles } from './files.ts';

export const SOUND = /\.(webm|m4a|mp3|wav|ogg|opus|aac|mp4|mov|caf|flac)$/i;
/** The realtime socket hears a piece at a time; long recordings are cut at the quietest moment near this length. */
const PIECE_S = 40;
const RATE = 24000;

/** The recordings kept with a world, in name order. */
export function toldFiles(files: WorldFiles): string[] {
  const dir = files.path('told');
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => SOUND.test(f)).sort() : [];
}

/** Copies recordings from a folder (or one file) into the world, numbered after the ones already there. */
export function keepTold(files: WorldFiles, from: string): string[] {
  const sources = fs.statSync(from).isDirectory()
    ? fs.readdirSync(from).filter((f) => SOUND.test(f)).sort().map((f) => path.join(from, f))
    : [from];
  return sources.flatMap((source) => {
    const ext = path.extname(source).toLowerCase();
    const stem = keptName(source);
    if (toldFiles(files).some((f) => f.slice(3) === `${stem}${ext}`)) return [];
    const name = `${String(toldFiles(files).length + 1).padStart(2, '0')}-${stem}${ext}`;
    files.write(files.path('told', name), fs.readFileSync(source));
    return [name];
  });
}

/** Cuts 16-bit PCM into pieces of about PIECE_S seconds, each ending at the quietest 100 ms near its end. */
export function pieces(pcm: Buffer): Buffer[] {
  const frame = (RATE / 10) * 2;
  const out: Buffer[] = [];
  let at = 0;
  while (pcm.length - at > (PIECE_S + 10) * RATE * 2) {
    let best = at + PIECE_S * RATE * 2, quiet = Infinity;
    for (let f = at + (PIECE_S - 10) * RATE * 2; f < at + (PIECE_S + 10) * RATE * 2; f += frame) {
      let loud = 0;
      for (let i = f; i < f + frame; i += 2) loud += Math.abs(pcm.readInt16LE(i));
      if (loud < quiet) (quiet = loud, best = f);
    }
    out.push(pcm.subarray(at, best + frame / 2));
    at = best + frame / 2;
  }
  out.push(pcm.subarray(at));
  return out;
}

/** What one recording says, written next to it as <clip>.txt (any format ffmpeg reads). */
export async function hear(files: WorldFiles, clip: string): Promise<string> {
  const text = files.path('told', clip.replace(/\.[^.]+$/, '.txt'));
  if (fs.existsSync(text)) return fs.readFileSync(text, 'utf8').trim();
  const audio = decode(fs.readFileSync(files.path('told', clip)));
  const said: string[] = [];
  for (const [i, piece] of pieces(pcm24k(audio)).entries()) said.push(await transcribe(files.memo, `told:${clip}:${i}`, piece, 8));
  const heard = said.join(' ').replace(/\s+/g, ' ').trim();
  files.write(text, `${heard}\n`);
  return heard;
}

/** Everything the children said, clip by clip, heard where not heard yet. */
export async function hearAll(files: WorldFiles): Promise<Array<{ clip: string; text: string }>> {
  const clips = toldFiles(files);
  return Promise.all(clips.map(async (clip) => ({ clip, text: await hear(files, clip) })));
}

export const Idea = z.object({ language: z.string().min(2), title: z.string().min(1), idea: z.string().min(10), hero: z.string().optional() });
export type Idea = z.infer<typeof Idea>;

/** Spark turns what the children said (messy, several voices, half sentences) and drew into one short idea. */
export async function ideaFromTold(memo: Memo, said: string[], drawn: Drawn[], note = ''): Promise<Idea> {
  const prompt = `Children of 5 and 6 are making a 2D point-and-click adventure game together. ${said.length ? `They told their story into a microphone; this is what the speech recogniser heard, recording by recording (it mishears children, so read through the mistakes):
${said.map((s, i) => `${i + 1}. """${s}"""`).join('\n')}` : 'They did not tell it aloud: their drawings are the story.'}
${drawn.length ? `\nThey also drew:\n${drawn.map((d) => `- ${d.kind} "${d.key}": ${d.looks}`).join('\n')}\n` : ''}${note ? `\nThe grown-up running the workshop adds: ${note}\n` : ''}
Write the idea of their game: who the hero is, where it happens, what goes wrong and how it gets put right, in 4 to 6 short sentences. Keep every idea of theirs that fits one story, and every drawing; join them kindly, add only what the story needs to hang together. Nothing scary or sad; a happy ending. Write it in the language the children spoke (with no recordings, the language of the grown-up's note, else English).

${drawn.some((d) => d.kind === 'hero' || d.kind === 'npc') ? `The hero is one of the drawn characters (${[...new Set(drawn.filter((d) => d.kind === 'hero' || d.kind === 'npc').map((d) => d.key))].join(', ')}): the one their story is most about.\n` : ''}
Reply with JSON only: {"language": "the language they spoke, in English, like Polish", "title": "a short title in that language", "idea": "...", "hero": "<key of the drawn character who is the hero, if any>"}`;
  return Idea.parse(await askSparkJson(memo, { label: 'told-idea', prompt }));
}

/** The story read aloud to the children by a warm storyteller voice (idea.mp3; not in told/, which holds only what the children said), as soon as it is written. */
export async function narrate(files: WorldFiles, idea: Idea): Promise<string> {
  const voices = await stockVoices();
  const voice = voices.find((v) => /narrat|story/i.test(`${v.labels?.use_case ?? ''} ${v.labels?.description ?? ''} ${v.description ?? ''}`) && v.labels?.gender === 'female')
    ?? voices.find((v) => v.labels?.gender === 'female') ?? voices[0];
  if (!voice) throw new Error('no ElevenLabs voice to read the story');
  files.write(files.path('idea.mp3'), await elevenSpeech(files.memo, 'told-idea', `${idea.title}. ${idea.idea}`, voice.voice_id));
  return 'idea.mp3';
}
