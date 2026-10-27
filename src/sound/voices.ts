// Spoken lines: Spark casts a voice for the narrator, the hero and every NPC from how they look and talk,
// ElevenLabs reads each line, and Muse Voice Transcribe listens back: a take that does not say its line is read again.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { inputHash, type Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { transcribe } from '../meta/voice.ts';
import type { Story } from '../story/schema.ts';
import type { World } from '../world/schema.ts';
import { decode, encodeMp3, normalise, pitchHz, pitchShift, RATE, seconds, trim, type Pcm } from './pcm.ts';
import { checkCredits, FINAL_TTS, lineTakes, noteRefusal, sharedDir, ttsModel } from './cost.ts';
import { elevenKey } from './sources.ts';

export const NARRATOR = 'narrator';

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
    for (const it of story.items) if (it.nope) lines.push({ speaker: world.hero.key, text: it.nope });
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
  /** Semitones the takes are raised. Only a stand-in: raising an adult voice sounds sped up, not young. */
  pitch: z.number().default(0),
  /**
   * A voice made for this character by ElevenLabs Voice Design (voice is then DESIGNED): no stock voice is a child or
   * truly old. `generated` is the design ElevenLabs returned; the voice is created from it only while lines are read.
   */
  design: z.object({ description: z.string(), generated: z.string(), hz: z.number().optional() }).optional(),
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
  if (init?.method === 'POST') checkCredits();
  for (let n = 1; ; n++) {
    const res = await fetch(`https://api.elevenlabs.io/v1${route}`, { ...init, headers: { 'xi-api-key': elevenKey() ?? '', 'Content-Type': 'application/json' } });
    if (res.ok) return res;
    const text = (await res.text()).slice(0, 300);
    noteRefusal(res.status, text);
    if (![429, 500, 502, 503].includes(res.status) || n === 4) throw new Error(`ElevenLabs ${route}: ${res.status} ${text}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
  }
}

/**
 * The voices to cast from: the stock voices every account has, and the English voices already on this account
 * (from the voice library or made before) that say their gender and age. Using them costs nothing extra.
 */
export async function stockVoices(): Promise<Voice[]> {
  const body = (await (await eleven('/voices')).json()) as { voices: Voice[] };
  const english = (v: Voice) => (v.labels?.language ?? 'en') === 'en';
  return body.voices.filter((v) => english(v) && (v.category === 'premade' || (!v.name.startsWith('diorama ') && !!v.labels?.gender && !!v.labels?.age)));
}

/** The voice id of a character whose voice is designed for them rather than picked from stock. */
export const DESIGNED = 'design';

/** Who stock voices cannot play: every stock voice is an adult, and the old ones are mature narrators, not old people. */
export const needsDesign = (p: Profile) => p.age === 'child' || p.age === 'teen' || p.age === 'old';

/**
 * What Voice Design is asked for, best first. ElevenLabs refuses descriptions that name a child, a girl or a boy, or an
 * age in years, so a child is a "youthful high-pitched female character voice for an animated game", which it accepts.
 */
export function designDescriptions(p: Profile): string[] {
  const sound = p.sound.replace(/\b(child(ren)?|kids?|girls?|boys?|little|young(ster)?|tiny|baby|teen(age(r|d)?)?|\d+[- ]?(years?|yo)[- ]?(old)?|year[- ]old|aged? \d+)\b/gi, '')
    .replace(/\s+/g, ' ').replace(/\s*,\s*(,\s*)+/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
  const tail = sound ? `, ${sound}` : '';
  const sex = p.gender === 'female' ? 'female' : 'male';
  const ladder = (base: string, fallback: string) => [`${base}${tail}.`, `${base}.`, fallback];
  if (p.age === 'child') return ladder(`Youthful high-pitched ${sex} character voice for an animated adventure game, light and bright`, `High-pitched cheerful cartoon ${sex === 'female' ? 'heroine' : 'hero'} voice, light, bright and eager.`);
  if (p.age === 'teen') return ladder(`Youthful ${sex} character voice for an animated adventure game, not yet adult, light`, `Youthful cheerful cartoon ${sex === 'female' ? 'heroine' : 'hero'} voice, light and eager.`);
  if (p.age === 'old') return ladder(`A very old ${p.gender === 'female' ? 'woman' : 'man'} in their late seventies, aged weathered voice, slower and a little creaky`, `An elderly ${p.gender === 'female' ? 'woman' : 'man'}, aged thin voice, slow.`);
  return ladder(`A ${p.age.replace('_', '-')} ${p.gender === 'female' ? 'woman' : 'man'}`, `A clear warm ${sex} voice.`);
}

/** How high a designed voice must be to pass for its age: Voice Design often answers a youthful wish with a young adult. */
const MIN_HZ: Partial<Record<Profile['age'], number>> = { child: 260, teen: 150 };

const PREVIEW_PAD = ' And so the evening goes on, quiet and slow, while the lanterns are lit one by one along the way.';

/**
 * Voice Design: ElevenLabs makes three voices from a description, reading `says` as the sample. A refused description
 * is asked again in plainer words. For a child or a teen the highest voice is kept, and the next description is
 * tried while even that is pitched like an adult (code measures each sample's pitch).
 */
export async function designVoice(p: Profile, says: string[], description?: string): Promise<NonNullable<Cast[string]['design']>> {
  let text = says.join(' ');
  while (text.length < 100) text += PREVIEW_PAD;
  const tries = [...new Set(description ? [description, ...designDescriptions(p).slice(1)] : designDescriptions(p))];
  const min = MIN_HZ[p.age] ?? 0;
  let best: { description: string; generated: string; hz: number } | undefined;
  let last: unknown;
  for (const d of tries) {
    try {
      const res = await eleven('/text-to-voice/design', { method: 'POST', body: JSON.stringify({ voice_description: d, model_id: 'eleven_multilingual_ttv_v2', text: text.slice(0, 1000), auto_generate_text: false }) });
      const body = (await res.json()) as { previews: Array<{ generated_voice_id: string; audio_base_64: string }> };
      for (const v of body.previews ?? []) {
        const hz = min ? pitchHz(decode(Buffer.from(v.audio_base_64, 'base64'))) : 0;
        if (!best || hz > best.hz) best = { description: d, generated: v.generated_voice_id, hz };
        if (!min) break;
      }
      if (best && best.hz >= min) break;
    } catch (error) {
      last = error;
    }
  }
  if (!best) throw new Error(`Voice Design refused "${tries[0]}": ${last instanceof Error ? last.message : last}`);
  const design = { description: best.description, generated: best.generated, ...(best.hz && { hz: best.hz }) };
  if (!min || best.hz >= min) keepDesign(p, design);
  return design;
}

/** Whether the ElevenLabs account can hold one more voice (a designed voice needs it while its lines are read). */
export async function freeVoiceSlot(): Promise<boolean> {
  try {
    const sub = (await (await eleven('/user/subscription')).json()) as { voice_slots_used?: number; voice_limit?: number };
    return sub.voice_limit === undefined || (sub.voice_slots_used ?? 0) < sub.voice_limit;
  } catch {
    return true;
  }
}

type DesignKept = NonNullable<Cast[string]['design']> & { gender: Profile['gender']; age: Profile['age'] };
const designsFile = () => sharedDir('voices', 'designs.json');

/** Voices designed before, by any world on this machine: a design is kept by ElevenLabs and can be made into a voice again. */
export function keptDesigns(): DesignKept[] {
  try {
    return JSON.parse(fs.readFileSync(designsFile(), 'utf8')) as DesignKept[];
  } catch {
    return [];
  }
}

function keepDesign(p: Profile, d: NonNullable<Cast[string]['design']>) {
  const all = keptDesigns().filter((k) => k.generated !== d.generated);
  fs.mkdirSync(path.dirname(designsFile()), { recursive: true });
  fs.writeFileSync(designsFile(), JSON.stringify([...all, { ...d, gender: p.gender, age: p.age }], null, 1));
}

/** A kept design of the same gender and age that this cast does not use yet: reused instead of designing (and paying) again. */
export function reusableDesign(p: Profile, taken: Set<string>): NonNullable<Cast[string]['design']> | undefined {
  const k = keptDesigns().find((d) => d.age === p.age && (d.gender === p.gender || p.gender === 'any') && !taken.has(d.generated));
  return k && { description: k.description, generated: k.generated, ...(k.hz && { hz: k.hz }) };
}

/**
 * Designed voices exist on the account only while their lines are read: a voice is created from its design when a
 * line needs it, and deleted by `close`, so a world takes no voice slot. ElevenLabs allows few voices per account.
 */
export class DesignedVoices {
  private made = new Map<string, Promise<string>>();
  constructor(private readonly tag: string) {}

  /** The live voice id for a design, created on first use. */
  idFor(design: NonNullable<Cast[string]['design']>): Promise<string> {
    let id = this.made.get(design.generated);
    if (!id) {
      id = (async () => {
        const res = await eleven('/text-to-voice', { method: 'POST', body: JSON.stringify({ voice_name: `${this.tag} ${design.generated.slice(0, 6)}`, voice_description: design.description, generated_voice_id: design.generated }) });
        return ((await res.json()) as { voice_id: string }).voice_id;
      })();
      this.made.set(design.generated, id);
    }
    return id;
  }

  /** Deletes the voices this run created, and any a crashed run of the same world left behind. */
  async close() {
    const ids = new Set((await Promise.allSettled(this.made.values())).flatMap((r) => (r.status === 'fulfilled' ? [r.value] : [])));
    try {
      const all = (await (await eleven('/voices')).json()) as { voices: Voice[] };
      for (const v of all.voices) if (v.name.startsWith(`${this.tag} `)) ids.add(v.voice_id);
    } catch { /* listing is best effort */ }
    await Promise.allSettled([...ids].map((id) => eleven(`/voices/${id}`, { method: 'DELETE' })));
    this.made.clear();
  }
}
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
 * nearest unused voice. Children, teens and the old get a voice designed for them (no stock voice fits them).
 */
export async function castVoices(memo: Memo, world: World, lines: Line[], voices: Voice[], speakers: Speaker[]): Promise<Cast> {
  const keys = [...new Set(lines.map((l) => l.speaker))];
  const byKey = new Map(speakers.map((s) => [s.key, s]));
  const profiles = Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await profileOf(memo, world, { ...(byKey.get(k) ?? { key: k, looks: k }), says: lines.filter((l) => l.speaker === k).slice(0, 4).map((l) => l.text) })] as const)));
  const taken = new Set<string>();
  const reused = Object.fromEntries(keys.filter((k) => needsDesign(profiles[k])).flatMap((k) => {
    const d = reusableDesign(profiles[k], taken);
    if (d) taken.add(d.generated);
    return d ? [[k, d] as const] : [];
  }));
  const designs = Object.fromEntries(await Promise.all(keys.filter((k) => needsDesign(profiles[k])).map(async (k) => {
    if (reused[k]) return [k, reused[k]] as const;
    try {
      return [k, await designVoice(profiles[k], lines.filter((l) => l.speaker === k).map((l) => l.text))] as const;
    } catch (error) {
      console.log(`  ${k}: ${error instanceof Error ? error.message : error}; a stock voice stands in`);
      return [k, undefined] as const;
    }
  })));
  const stock = keys.filter((k) => !designs[k]);
  const candidates = Object.fromEntries(keys.map((k) => [k, voiceCandidates(voices, profiles[k])]));
  const sample = (key: string) => lines.filter((l) => l.speaker === key).slice(0, 2).map((l) => `"${l.text}"`).join(' ');
  const describe = (v: Voice) => `${v.voice_id}: ${v.name}; ${Object.values(v.labels ?? {}).join(', ')}; ${v.description ?? ''}`;
  const prompt = `You cast voice actors for a 2D painted point-and-click adventure: ${world.title}. ${world.pitch}

For each character pick ONE voice from that character's own list (the lists already match their gender and age). Pick by temperament and how they talk. Give different characters different voices when you can. Set "stability" 0.3-0.7 (lower is more expressive) and "style" 0-0.5.

${stock.map((k) => `## ${k}: ${profiles[k].age.replace('_', ' ')} ${profiles[k].gender === 'any' ? '' : profiles[k].gender}, ${profiles[k].sound}. Says: ${sample(k)}
${candidates[k].map((v) => `- ${describe(v)}`).join('\n')}`).join('\n\n')}

Reply with JSON only: {"<character key>": {"voice": "<voice id>", "why": "few words", "stability": 0.45, "style": 0.2}}`;
  const picked = Cast.safeParse(stock.length ? await askSparkJson<unknown>(memo, { label: 'cast-voices', prompt }).catch(() => ({})) : {});
  const cast: Cast = {};
  const used = new Set<string>();
  for (const k of keys) {
    const p = profiles[k];
    const design = designs[k];
    if (design) {
      cast[k] = { voice: DESIGNED, why: design.description, stability: 0.45, style: 0.2, profile: p, pitch: 0, design };
      continue;
    }
    const allowed = candidates[k];
    let choice = picked.success ? picked.data[k] : undefined;
    // A pick outside the character's list is not trusted: the nearest unused voice that fits takes its place.
    if (!choice || !allowed.some((v) => v.voice_id === choice!.voice)) {
      const v = allowed.find((x) => !used.has(x.voice_id)) ?? allowed[0] ?? voices[0];
      choice = { voice: v.voice_id, why: `nearest ${p.age.replace('_', ' ')} ${p.gender} voice`, stability: 0.45, style: 0.2, pitch: 0 };
    }
    used.add(choice.voice);
    // No design (refused, or no ElevenLabs Voice Design): a young stock voice raised a little is the stand-in.
    cast[k] = { ...choice, profile: p, pitch: p.age === 'child' ? 3 : p.age === 'teen' ? 1.5 : 0 };
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
export function pcm24k(pcm: Pcm): Buffer {
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

function speak(memo: Memo, label: string, text: string, voice: Cast[string], take: number, designed?: DesignedVoices): Promise<Buffer> {
  const body = (model: string) => ({ text, model_id: model, voice_settings: { stability: voice.stability, similarity_boost: 0.8, style: voice.style, use_speaker_boost: true }, ...(take > 1 && { seed: 1000 + take }) });
  // A designed voice gets a new id each time it is created, so its takes are remembered by the design.
  const hash = (model: string) => inputHash('eleven-tts', voice.design?.generated ?? voice.voice, JSON.stringify(body(model)));
  // A take already read by the better model is used in a draft too, so lowering the quality never pays again.
  const model = [FINAL_TTS, ttsModel()].find((m) => memo.has('voice', hash(m), 'mp3')) ?? ttsModel();
  return memo.remember('voice', label, hash(model), 'mp3', async () => {
    if (voice.design && !designed) throw new Error('a designed voice needs DesignedVoices to speak');
    const id = voice.design ? await designed!.idFor(voice.design) : voice.voice;
    return Buffer.from(await (await eleven(`/text-to-speech/${id}?output_format=mp3_44100_128`, { method: 'POST', body: JSON.stringify(body(model)) })).arrayBuffer());
  });
}

export const lineId = (line: Line) => `line-${inputHash(line.speaker, line.text).slice(0, 10)}`;

/** Close enough: 90% of the letters, or at most two letters off, so a short line is not failed for one misheard word ("a" for "of"). */
export const heardOk = (line: string, match: number) => match >= 0.9 || (1 - match) * letters(line).length <= 2.01;

/** Reads one line, listens back, and reads it again (up to 3 takes, 2 in draft) until the transcript matches. */
export async function voiceLine(memo: Memo, line: Line, voice: Cast[string], write: (id: string, mp3: Buffer) => string, designed?: DesignedVoices): Promise<z.infer<typeof VoiceLine>> {
  const id = lineId(line);
  let best: { pcm: Pcm; heard: string; match: number; take: number } | undefined;
  const takes = lineTakes();
  for (let take = 1; take <= takes; take++) {
    const pcm = pitchShift(trim(decode(await speak(memo, `${id}-${take}`, line.text, voice, take, designed)), 0.005), voice.pitch ?? 0);
    const heard = await transcribe(memo, `${id}-${take}`, pcm24k(pcm), 10);
    const match = heardMatch(line.text, heard);
    if (!best || match > best.match) best = { pcm, heard, match, take };
    if (heardOk(line.text, match)) break;
  }
  const flags = !heardOk(line.text, best!.match) ? [`heard ${Math.round(best!.match * 100)}% of the line after ${takes} takes`] : best!.take > 1 ? [`take ${best!.take} used`] : [];
  const pcm = normalise(best!.pcm, -18);
  return { speaker: line.speaker, text: line.text, file: write(id, encodeMp3(pcm, 96)), seconds: Math.round(seconds(pcm) * 100) / 100, heard: best!.heard, match: Math.round(best!.match * 100) / 100, flags };
}
