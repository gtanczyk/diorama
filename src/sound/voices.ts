// Spoken lines: Spark casts a voice for the narrator, the hero and every NPC from how they look and talk,
// ElevenLabs reads each line, and Muse Voice Transcribe listens back: a take that does not say its line is read again.
import { z } from 'zod';
import { inputHash, type Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { transcribe } from '../meta/voice.ts';
import type { Story } from '../story/schema.ts';
import type { World } from '../world/schema.ts';
import { decode, encodeMp3, normalise, pitchShift, RATE, seconds, trim, type Pcm } from './pcm.ts';
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

export const AGES = ['child', 'teen', 'young', 'middle_aged', 'old'] as const;
export const Profile = z.object({
  gender: z.enum(['male', 'female', 'any']),
  age: z.enum(AGES),
  /** How they should sound, in a few words ("bright, quick, cheeky"). */
  sound: z.string().default(''),
});
export type Profile = z.infer<typeof Profile>;

export const Cast = z.record(z.string(), z.object({
  voice: z.string(),
  why: z.string().default(''),
  /** ElevenLabs voice settings: lower stability is more expressive, style exaggerates the delivery. */
  stability: z.number().min(0).max(1).default(0.45),
  style: z.number().min(0).max(1).default(0.2),
  /** Who Spark saw in the figure; the voice was picked to match it. Missing on casts made before profiles. */
  profile: Profile.optional(),
  /** Semitones the takes are raised: stock voices are adults, so a child or a teen is a young voice read higher. */
  pitch: z.number().default(0),
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

export type Voice = { voice_id: string; name: string; category?: string; labels?: Record<string, string>; description?: string };

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

const PITCH: Partial<Record<Profile['age'], number>> = { child: 4, teen: 2.5 };
const ageOf = (v: Voice) => AGES.indexOf((v.labels?.age as Profile['age']) ?? 'middle_aged');

/** How far a stock voice is from who should speak: a wrong gender rules it out, then age steps apart. */
export function voiceDistance(v: Voice, p: Profile): number {
  const gender = v.labels?.gender;
  if (p.gender !== 'any' && gender && gender !== 'neutral' && gender !== p.gender) return Infinity;
  const age = ageOf(v);
  return Math.abs((age < 0 ? 3 : age) - Math.max(AGES.indexOf(p.age), AGES.indexOf('young')));
}

/** The voices that fit a profile: right gender, nearest in age (a child gets the youngest voices there are). */
export function voiceCandidates(voices: Voice[], p: Profile): Voice[] {
  const scored = voices.map((v) => ({ v, d: voiceDistance(v, p) })).filter((x) => Number.isFinite(x.d));
  const best = Math.min(...scored.map((x) => x.d));
  return scored.filter((x) => x.d <= Math.max(best, 0)).map((x) => x.v);
}

export type Speaker = { key: string; looks: string; figure?: Buffer; says?: string[] };

/** Spark looks at the figure (and reads its description): gender, age and how they should sound. */
export async function profileOf(memo: Memo, world: World, who: Speaker): Promise<Profile> {
  if (who.key === NARRATOR) return { gender: 'any', age: 'middle_aged', sound: `a storyteller for: ${world.style}` };
  const hero = who.key === world.hero.key;
  const prompt = `This is a character of a 2D adventure game${who.figure ? ' (the picture shows them)' : ''}.
Game: ${world.title}. ${world.pitch}
Character key: ${who.key}${hero ? ' (the hero the player plays)' : ''}
Description: ${who.looks}
${who.says?.length ? `They say: ${who.says.map((l) => `"${l}"`).join(' ')}\n` : ''}
Who are they, as far as their voice goes? The key, the description, the game text and how they talk decide gender when they say it (a "girl", "he", a name); otherwise judge by the picture. Judge age by the face and body${who.figure ? ' in the picture' : ''} and the text: a child is under 14 (a boy, a girl, a kid, an errand boy, a small figure next to the adults), a teen 14-19 with a grown body. When unsure between child and teen, say child: an adult-sounding boy is worse than a young-sounding one.
Reply with JSON only: {"gender": "male | female", "age": "child | teen | young | middle_aged | old", "sound": "how their voice should sound, a few words"}`;
  return Profile.parse(await askSparkJson(memo, { label: `voice-profile:${who.key}`, prompt, images: who.figure ? [who.figure] : [] }));
}

/**
 * Casts a stock voice for each speaker. Spark sees each figure and says who they are; code keeps only the voices
 * of that gender and age; Spark picks among those for temperament; code checks the pick and falls back to the
 * nearest unused voice. Children and teens are read higher (pitch), since no stock voice is a child.
 */
export async function castVoices(memo: Memo, world: World, lines: Line[], voices: Voice[], speakers: Speaker[]): Promise<Cast> {
  const keys = [...new Set(lines.map((l) => l.speaker))];
  const byKey = new Map(speakers.map((s) => [s.key, s]));
  const profiles = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await profileOf(memo, world, { ...(byKey.get(k) ?? { key: k, looks: k }), says: lines.filter((l) => l.speaker === k).slice(0, 4).map((l) => l.text) })] as const)));
  const candidates = Object.fromEntries(keys.map((k) => [k, voiceCandidates(voices, profiles[k])]));
  const sample = (key: string) => lines.filter((l) => l.speaker === key).slice(0, 2).map((l) => `"${l.text}"`).join(' ');
  const describe = (v: Voice) => `${v.voice_id}: ${v.name}; ${Object.values(v.labels ?? {}).join(', ')}; ${v.description ?? ''}`;
  const prompt = `You cast voice actors for a 2D painted point-and-click adventure: ${world.title}. ${world.pitch}

For each character pick ONE voice from that character's own list (the lists already match their gender and age). Pick by temperament and how they talk. Give different characters different voices when you can. Set "stability" 0.3-0.7 (lower is more expressive) and "style" 0-0.5.

${keys.map((k) => `## ${k}: ${profiles[k].age.replace('_', ' ')} ${profiles[k].gender === 'any' ? '' : profiles[k].gender}, ${profiles[k].sound}. Says: ${sample(k)}
${candidates[k].map((v) => `- ${describe(v)}`).join('\n')}`).join('\n\n')}

Reply with JSON only: {"<character key>": {"voice": "<voice id>", "why": "few words", "stability": 0.45, "style": 0.2}}`;
  const picked = Cast.safeParse(await askSparkJson<unknown>(memo, { label: 'cast-voices', prompt }).catch(() => ({})));
  const cast: Cast = {};
  const used = new Set<string>();
  for (const k of keys) {
    const p = profiles[k];
    const allowed = candidates[k];
    let choice = picked.success ? picked.data[k] : undefined;
    // A pick outside the character's list is not trusted: the nearest unused voice that fits takes its place.
    if (!choice || !allowed.some((v) => v.voice_id === choice!.voice)) {
      const v = allowed.find((x) => !used.has(x.voice_id)) ?? allowed[0] ?? voices[0];
      choice = { voice: v.voice_id, why: `nearest ${p.age.replace('_', ' ')} ${p.gender} voice`, stability: 0.45, style: 0.2, pitch: 0 };
    }
    used.add(choice.voice);
    cast[k] = { ...choice, profile: p, pitch: PITCH[p.age] ?? 0 };
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
    const pcm = pitchShift(trim(decode(await speak(memo, `${id}-${take}`, line.text, voice, take)), 0.005), voice.pitch ?? 0);
    const heard = await transcribe(memo, `${id}-${take}`, pcm24k(pcm), 10);
    const match = heardMatch(line.text, heard);
    if (!best || match > best.match) best = { pcm, heard, match, take };
    if (heardOk(line.text, match)) break;
  }
  const flags = !heardOk(line.text, best!.match) ? [`heard ${Math.round(best!.match * 100)}% of the line after 3 takes`] : best!.take > 1 ? [`take ${best!.take} used`] : [];
  const pcm = normalise(best!.pcm, -18);
  return { speaker: line.speaker, text: line.text, file: write(id, encodeMp3(pcm, 96)), seconds: Math.round(seconds(pcm) * 100) / 100, heard: best!.heard, match: Math.round(best!.match * 100) / 100, flags };
}
