// Spoken lines: Spark casts a voice for the narrator, the hero and every NPC from how they look and talk,
// ElevenLabs reads each line, and Muse Voice Transcribe listens back: a take that does not say its line is read again.
import { z } from 'zod';
import { inputHash, type Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { transcribe } from '../meta/voice.ts';
import type { Story } from '../story/schema.ts';
import type { World } from '../world/schema.ts';
import { decode, encodeMp3, normalise, RATE, seconds, trim, type Pcm } from './pcm.ts';
import { elevenKey } from './sources.ts';

export const NARRATOR = 'narrator';
const TTS_MODEL = 'eleven_multilingual_v2';

export type Line = { speaker: string; text: string };

/**
 * The lines to speak and who says them: conversations (the NPC's lines, the hero's answers) and the narrator's
 * intro and endings. The hero's remarks on things stay text only unless `all`: a game that talks at every click tires.
 */
export function storyLines(world: World, story: Story, all = false): Line[] {
  const lines: Line[] = [{ speaker: NARRATOR, text: story.intro }];
  if (all) {
    for (const i of story.interactions) lines.push({ speaker: world.hero.key, text: i.say });
    for (const l of story.locks) lines.push({ speaker: world.hero.key, text: l.say });
  }
  for (const d of story.dialogues) {
    for (const l of d.lines) {
      lines.push({ speaker: d.npc, text: l.says });
      for (const c of l.choices) lines.push({ speaker: world.hero.key, text: c.text });
    }
  }
  for (const e of story.endings) lines.push({ speaker: NARRATOR, text: e.text });
  const seen = new Set<string>();
  return lines.filter((l) => !seen.has(l.text) && seen.add(l.text));
}

export const Cast = z.record(z.string(), z.object({
  voice: z.string(),
  why: z.string().default(''),
  /** ElevenLabs voice settings: lower stability is more expressive, style exaggerates the delivery. */
  stability: z.number().min(0).max(1).default(0.45),
  style: z.number().min(0).max(1).default(0.2),
}));
export type Cast = z.infer<typeof Cast>;

export const VoiceLine = z.object({
  speaker: z.string(),
  text: z.string(),
  file: z.string(),
  seconds: z.number(),
  /** What Muse Voice Transcribe heard, and how close that is to the line (heardMatch). */
  heard: z.string(),
  match: z.number(),
  flags: z.array(z.string()).default([]),
});
export const Voices = z.object({ cast: Cast, lines: z.array(VoiceLine) });
export type Voices = z.infer<typeof Voices>;

type Voice = { voice_id: string; name: string; category?: string; labels?: Record<string, string>; description?: string };

async function eleven(route: string, init?: RequestInit): Promise<Response> {
  for (let n = 1; ; n++) {
    const res = await fetch(`https://api.elevenlabs.io/v1${route}`, { ...init, headers: { 'xi-api-key': elevenKey() ?? '', 'Content-Type': 'application/json' } });
    if (res.ok) return res;
    const text = (await res.text()).slice(0, 300);
    if (![429, 500, 502, 503].includes(res.status) || n === 4) throw new Error(`ElevenLabs ${route}: ${res.status} ${text}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
  }
}

/** The stock voices every ElevenLabs account has, so a world casts the same for anyone who builds it. */
export async function stockVoices(): Promise<Voice[]> {
  const body = (await (await eleven('/voices')).json()) as { voices: Voice[] };
  return body.voices.filter((v) => v.category === 'premade' && (v.labels?.language ?? 'en') === 'en');
}

export async function castVoices(memo: Memo, world: World, story: Story, lines: Line[], voices: Voice[]): Promise<Cast> {
  const speakers = [...new Set(lines.map((l) => l.speaker))];
  const who = (key: string) => {
    if (key === NARRATOR) return 'the narrator who reads the intro and the endings';
    if (key === world.hero.key) return `the hero, ${world.hero.looks}`;
    const npc = world.places.flatMap((p) => p.things).find((t) => t.key === key);
    return npc ? `${npc.looks}` : key;
  };
  const sample = (key: string) => lines.filter((l) => l.speaker === key).slice(0, 3).map((l) => `"${l.text}"`).join(' ');
  const prompt = `You cast voice actors for a 2D painted point-and-click adventure.

Game: ${world.title}. ${world.pitch}
Look: ${world.style}

Characters:
${speakers.map((k) => `- ${k}: ${who(k)}. Says: ${sample(k)}`).join('\n')}

Voices you can cast (id: name, labels, description):
${voices.map((v) => `- ${v.voice_id}: ${v.name}; ${Object.values(v.labels ?? {}).join(', ')}; ${v.description ?? ''}`).join('\n')}

For each character pick the voice that fits their age, gender, temperament and the world. Use a different voice for each character. Set "stability" 0.3-0.7 (lower is more expressive) and "style" 0-0.5 (higher exaggerates the delivery).

Reply with JSON only: {"<character key>": {"voice": "<voice id>", "why": "few words", "stability": 0.45, "style": 0.2}}`;
  const ids = new Set(voices.map((v) => v.voice_id));
  const answer = await askSparkJson<unknown>(memo, { label: 'cast-voices', prompt });
  const cast = Cast.parse(answer);
  for (const key of speakers) {
    if (!cast[key] || !ids.has(cast[key].voice)) throw new Error(`voice cast: ${key} has no stock voice (${cast[key]?.voice ?? 'none'})`);
  }
  return cast;
}

const letters = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * How much of the line was heard: 1 - letter edit distance / letters in the line. Letters, not words, so
 * "trap door" for "trapdoor" or "harbor" for "harbour" cost little and a skipped or garbled phrase costs a lot.
 */
export function heardMatch(line: string, heard: string): number {
  const a = letters(line);
  const b = letters(heard);
  if (!a.length) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return Math.max(0, 1 - prev[b.length] / a.length);
}

/** 16-bit mono PCM at 24 kHz, what the transcriber takes. */
function pcm24k(pcm: Pcm): Buffer {
  const step = RATE / 24000;
  const n = Math.floor(pcm.left.length / step);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(i * step);
    const v = Math.max(-1, Math.min(1, (pcm.left[k] + pcm.right[k]) / 2));
    out.writeInt16LE(Math.round(v * 32767), i * 2);
  }
  return out;
}

function speak(memo: Memo, label: string, text: string, voice: Cast[string], take: number): Promise<Buffer> {
  const body = { text, model_id: TTS_MODEL, voice_settings: { stability: voice.stability, similarity_boost: 0.8, style: voice.style, use_speaker_boost: true }, ...(take > 1 && { seed: 1000 + take }) };
  return memo.remember('voice', label, inputHash('eleven-tts', voice.voice, JSON.stringify(body)), 'mp3', async () =>
    Buffer.from(await (await eleven(`/text-to-speech/${voice.voice}?output_format=mp3_44100_128`, { method: 'POST', body: JSON.stringify(body) })).arrayBuffer()));
}

export const lineId = (line: Line) => `line-${inputHash(line.speaker, line.text).slice(0, 10)}`;

/** Close enough: 90% of the letters, or at most two letters off, so a short line is not failed for one misheard word ("a" for "of"). */
export const heardOk = (line: string, match: number) => match >= 0.9 || (1 - match) * letters(line).length <= 2.01;

/** Reads one line, listens back, and reads it again (up to 3 takes) until the transcript matches. */
export async function voiceLine(memo: Memo, line: Line, voice: Cast[string], write: (id: string, mp3: Buffer) => string): Promise<z.infer<typeof VoiceLine>> {
  const id = lineId(line);
  let best: { pcm: Pcm; heard: string; match: number; take: number } | undefined;
  for (let take = 1; take <= 3; take++) {
    const pcm = trim(decode(await speak(memo, `${id}-${take}`, line.text, voice, take)), 0.005);
    const heard = await transcribe(memo, `${id}-${take}`, pcm24k(pcm), 10);
    const match = heardMatch(line.text, heard);
    if (!best || match > best.match) best = { pcm, heard, match, take };
    if (heardOk(line.text, match)) break;
  }
  const flags = !heardOk(line.text, best!.match) ? [`heard ${Math.round(best!.match * 100)}% of the line after 3 takes`] : best!.take > 1 ? [`take ${best!.take} used`] : [];
  const pcm = normalise(best!.pcm, -18);
  return { speaker: line.speaker, text: line.text, file: write(id, encodeMp3(pcm, 96)), seconds: Math.round(seconds(pcm) * 100) / 100, heard: best!.heard, match: Math.round(best!.match * 100) / 100, flags };
}
