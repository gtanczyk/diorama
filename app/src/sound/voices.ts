// Spoken lines: Spark casts a voice for the narrator, the hero and every NPC from how they look and talk,
// ElevenLabs reads each line, and Muse Voice Transcribe listens back: a take that does not say its line is read again.
import fs from 'node:fs';
import path from 'node:path';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { trackOperation } from '../studio/operation.ts';
import { inputHash, type Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { transcribe } from '../meta/voice.ts';
import { quickTranscribe } from '../meta/voice-file.ts';
import { speakerOf } from '../story/engine.ts';
import { goodbye } from '../story/phrases.ts';
import type { Story } from '../story/schema.ts';
import type { World } from '../world/schema.ts';
import { decode, encodeMp3, normalise, pitchHz, pitchShift, audioProblem, RATE, seconds, trim, type Pcm } from './pcm.ts';
import { checkCredits, FINAL_TTS, lineTakes, noteRefusal, sharedDir, ttsModel } from './cost.ts';
import { elevenKey } from './sources.ts';
import { languageKey } from './language.ts';
import { numberWords, spokenText } from './spoken.ts';

export const VOICE_PIPELINE = 2;

export const NARRATOR = 'narrator';

export type Line = { speaker: string; text: string; previousText?: string; nextText?: string };

/**
 * The lines to speak and who says them: conversations (the NPC's lines, the hero's answers) and the narrator's
 * intro and endings. The hero's remarks on things stay text only unless `all`: a game that talks at every click tires.
 */
export function storyLines(world: World, story: Story, all = false): Line[] {
  const lines: Line[] = [{ speaker: NARRATOR, text: story.intro }];
  // A person's own talk lines (a fisherman who answers when spoken to) are spoken like a conversation.
  for (const i of story.interactions) if (speakerOf(world, i) !== world.hero.key) lines.push({ speaker: speakerOf(world, i), text: i.say });
  if (all) {
    for (const i of story.interactions) if (speakerOf(world, i) === world.hero.key) lines.push({ speaker: world.hero.key, text: i.say });
    for (const l of story.locks) lines.push({ speaker: world.hero.key, text: l.say });
    for (const it of story.items) if (it.nope) lines.push({ speaker: world.hero.key, text: it.nope });
  }
  for (const d of story.dialogues) {
    for (const l of d.lines) {
      const incoming = d.lines.flatMap((n) => n.choices.filter((c) => c.next && c.next === l.key).map((c) => c.text));
      const previous = [...new Set(incoming)];
      lines.push({ speaker: d.npc, text: l.says, ...(previous.length === 1 && { previousText: previous[0] }) });
      for (const c of l.choices) {
        const next = c.next ? d.lines.find((n) => n.key === c.next)?.says : undefined;
        lines.push({ speaker: world.hero.key, text: c.text, previousText: l.says, ...(next && { nextText: next }) });
      }
    }
  }
  if (story.dialogues.length) lines.push({ speaker: world.hero.key, text: goodbye(world.language) });
  for (const e of story.endings) lines.push({ speaker: NARRATOR, text: e.text });
  const unique = new Map<string, Line>();
  for (const line of lines) {
    const key = JSON.stringify([line.speaker, line.text]);
    const prior = unique.get(key);
    if (!prior) unique.set(key, { ...line });
    else for (const field of ['previousText', 'nextText'] as const) {
      // A repeated sentence with ambiguous branches must not inherit a different branch's context.
      if (prior[field] !== line[field]) delete prior[field];
    }
  }
  return [...unique.values()];
}

export const AGES = ['child', 'teen', 'young', 'middle_aged', 'old'] as const;
export const Profile = z.object({
  gender: z.enum(['male', 'female', 'any']),
  age: z.enum(AGES),
  /** How they should sound, in a few words ("bright, quick, cheeky"). */
  sound: z.string().default(''),
  language: z.string().optional(),
});
export type Profile = z.infer<typeof Profile>;

export const Cast = z.record(z.string(), z.object({
  voice: z.string(),
  why: z.string().default(''),
  /** ElevenLabs voice settings: lower stability is more expressive, style exaggerates the delivery. */
  stability: z.number().min(0).max(1).default(0.45),
  style: z.number().min(0).max(1).default(0.2),
  speed: z.number().min(0.7).max(1.2).default(1),
  /** Who Spark saw in the figure; the voice was picked to match it. Missing on casts made before profiles. */
  profile: Profile.optional(),
  /** Semitones the takes are raised. Only a stand-in: raising an adult voice sounds sped up, not young. */
  pitch: z.number().default(0),
  warnings: z.array(z.string()).optional(),
  /** No substitute is spoken while the required design or voice slot is unavailable. */
  pending: z.string().optional(),
  /**
   * A voice made for this character by ElevenLabs Voice Design (voice is then DESIGNED): no stock voice is a child or
   * truly old. `generated` is the design ElevenLabs returned; the voice is created from it only while lines are read.
   */
  design: z.object({ description: z.string(), generated: z.string(), hz: z.number().optional(), profileKey: z.string().optional(), request: z.string().optional() }).optional(),
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
export const Voices = z.object({ pipeline: z.number().optional(), castingFrom: z.string().optional(), cast: Cast, lines: z.array(VoiceLine), failures: z.array(z.object({ speaker: z.string(), text: z.string(), reason: z.string() })).default([]) });
export type Voices = z.infer<typeof Voices>;

export type Voice = { voice_id: string; name: string; category?: string; labels?: Record<string, string>; description?: string };

async function eleven(route: string, init?: RequestInit): Promise<Response> {
  if (init?.method === 'POST') checkCredits();
  const operation = route.startsWith('/text-to-speech/') ? 'speech response headers' : route.startsWith('/text-to-voice') ? 'voice design response headers' : route.startsWith('/voices') ? 'voices response headers' : 'API response headers';
  return trackOperation('elevenlabs', operation, async () => {
    for (let n = 1; ; n++) {
      const res = await fetch(`https://api.elevenlabs.io/v1${route}`, { ...init, headers: { 'xi-api-key': elevenKey() ?? '', 'Content-Type': 'application/json' } });
      if (res.ok) return res;
      const text = (await res.text()).slice(0, 300);
      noteRefusal(res.status, text);
      if (![429, 500, 502, 503].includes(res.status) || n === 4) throw new Error(`ElevenLabs ${route}: ${res.status} ${text}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
    }
  });
}

/**
 * The voices to cast from: the stock voices every account has, and labelled voices in all languages on this account
 * (from the voice library or made before) that say their gender and age. Using them costs nothing extra.
 */
export async function stockVoices(): Promise<Voice[]> {
  return trackOperation('elevenlabs', 'load available voices', async () => {
    const body = (await (await eleven('/voices')).json()) as { voices: Voice[] };
    return body.voices.filter((v) => v.category === 'premade' || (!v.name.startsWith('diorama ') && !!v.labels?.gender && !!v.labels?.age));
  });
}

/** The voice id of a character whose voice is designed for them rather than picked from stock. */
export const DESIGNED = 'design';
export const PENDING_DESIGN = 'pending-design';

/** Who stock voices cannot play: every stock voice is an adult, and the old ones are mature narrators, not old people. */
export const needsDesign = (p: Profile) => p.age === 'child' || p.age === 'teen' || p.age === 'old';

/**
 * What Voice Design is asked for, best first. ElevenLabs refuses descriptions that name a child, a girl or a boy, or an
 * age in years. Describe a youthful animated performance without forcing a squeak or changing the language.
 */
export function designDescriptions(p: Profile): string[] {
  const sound = p.sound.replace(/\b(child(ren|ish|like)?|kid(s|dy|die)?|girl(s|ish)?|boy(s|ish)?|little|young(ster)?|tiny|baby|teen(age(r|d)?)?|\d+[- ]?(years?|yo)[- ]?(old)?|year[- ]old|aged? \d+)\b/gi, '')
    .replace(/\s+/g, ' ').replace(/\s*,\s*(,\s*)*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
  const tail = sound ? ` Persona and delivery: ${sound}.` : '';
  const sex = p.gender === 'female' ? 'female' : 'male';
  // The last rung drops the persona: ElevenLabs refuses some words in it (blocked_generation), and a voice of the
  // right age without the persona is better than none.
  const ladder = (base: string, fallback: string) => [...[base, fallback].map((text) => `Native ${p.language ?? 'English'} speaker. Studio-quality clean recording. ${text}.${tail} Natural conversational intonation, clear diction, comfortable pitch, no forced squeak.`),
    `Native ${p.language ?? 'English'} speaker. Studio-quality clean recording. ${fallback}. Natural conversational intonation, clear diction.`];
  if (p.age === 'child') return ladder(`Youthful ${sex} character voice for an animated adventure game, warm and expressive`, `Warm cheerful animated ${sex} voice, clear and expressive`);
  if (p.age === 'teen') return ladder(`Youthful ${sex} character voice for an animated adventure game, not yet adult, light`, `Youthful cheerful cartoon ${sex === 'female' ? 'heroine' : 'hero'} voice, light and eager.`);
  if (p.age === 'old') return ladder(`A very old ${p.gender === 'female' ? 'woman' : 'man'} in their late seventies, aged weathered voice, slower and a little creaky`, `An elderly ${p.gender === 'female' ? 'woman' : 'man'}, aged thin voice, slow.`);
  return ladder(`A ${p.age.replace('_', '-')} ${p.gender === 'female' ? 'woman' : 'man'}`, `A clear warm ${sex} voice.`);
}

/** A design belongs to a language and a specific performance brief, not just gender and age. */
export const profileKey = (p: Profile) => inputHash('voice-design-v2', languageKey(p.language), p.gender, p.age, p.sound.trim().toLowerCase());

export function previewText(says: string[]): string {
  const sample = says.join(' ').trim();
  if (!sample) throw new Error('voice design needs sample dialogue in the story language');
  let text = sample;
  while (text.length < 100) text += ` ${sample}`;
  return text.length <= 1000 ? text : text.slice(0, 1000).replace(/\s+\S*$/, '');
}

/** Preview selection checks intelligibility and recording integrity; it does not claim to judge acting. */
export async function designVoice(memo: Memo, p: Profile, says: string[], description?: string): Promise<NonNullable<Cast[string]['design']>> {
  return trackOperation('voice-design', 'create and validate voice', () => prepareVoice(memo, p, says, description));
}

async function prepareVoice(memo: Memo, p: Profile, says: string[], description?: string): Promise<NonNullable<Cast[string]['design']>> {
  const text = spokenText(previewText(says), p.language);
  const tries = [...new Set(description ? [`Native ${p.language ?? 'English'} speaker. ${description}`, ...designDescriptions(p).slice(1)] : designDescriptions(p))];
  let last: unknown;
  for (const d of tries) {
    try {
      // Keep the paid previews until validation finishes; a transcriber outage must not buy a new design.
      const pendingFile = path.join(memo.dir, 'voice-design', `${inputHash(elevenKey() ?? '', d, text)}.json`);
      let body: { previews: Array<{ generated_voice_id: string; audio_base_64: string; language?: string }> };
      if (fs.existsSync(pendingFile)) body = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
      else {
        const res = await eleven('/text-to-voice/design', { method: 'POST', body: JSON.stringify({ voice_description: d, model_id: 'eleven_multilingual_ttv_v2', text, auto_generate_text: false }) });
        body = await res.json() as typeof body;
        fs.mkdirSync(path.dirname(pendingFile), { recursive: true });
        fs.writeFileSync(pendingFile, JSON.stringify(body));
      }
      let best: { generated: string; hz: number; match: number } | undefined;
      for (const v of body.previews ?? []) {
        if (v.language && languageKey(v.language) !== languageKey(p.language)) continue;
        const pcm = decode(Buffer.from(v.audio_base_64, 'base64'));
        if (audioProblem(pcm)) continue;
        let heard: string | undefined;
        // Transcribe owns the bounded retry/backoff. Do not multiply it with another retry loop here.
        let match: number;
        try { ({ heard, match } = await listenBack(memo, `voice-preview:${v.generated_voice_id}`, pcm24k(pcm), text, p.language)); }
        catch (error) { throw new Error(`Voice Design validation pending: ${error instanceof Error ? error.message : error}`); }
        if (!heardOk(text, match)) continue;
        // Pitch is diagnostic only. Highest pitch is not evidence of a convincing character.
        if (!best || match > best.match) best = { generated: v.generated_voice_id, hz: pitchHz(pcm), match };
      }
      if (best) {
        const design = { description: d, generated: best.generated, hz: best.hz, profileKey: description ? inputHash(profileKey(p), description) : profileKey(p), ...(description && { request: description }) };
        keepDesign(p, design);
        fs.rmSync(pendingFile, { force: true });
        return design;
      }
      fs.rmSync(pendingFile, { force: true });
      last = new Error('no intelligible, clean preview in the story language');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Voice Design validation pending:')) throw error;
      last = error;
    }
  }
  throw new Error(`Voice Design failed: ${last instanceof Error ? last.message : last}`);
}

/** Resume saved previews for pending actors without recasting the actors whose voices already work. */
export async function resumePendingVoices(memo: Memo, cast: Cast, lines: Line[]): Promise<Cast> {
  const next = { ...cast };
  for (const [key, voice] of Object.entries(cast)) {
    if (voice.voice !== PENDING_DESIGN || !voice.profile) continue;
    try {
      const design = await designVoice(memo, voice.profile, lines.filter((l) => l.speaker === key).map((l) => l.text));
      next[key] = { ...voice, voice: DESIGNED, design, pending: undefined, why: design.description };
    } catch (error) {
      next[key] = { ...voice, pending: error instanceof Error ? error.message : String(error) };
    }
  }
  return next;
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
  const k = keptDesigns().find((d) => d.profileKey === profileKey(p) && !taken.has(d.generated));
  return k && { description: k.description, generated: k.generated, profileKey: k.profileKey, ...(k.hz && { hz: k.hz }) };
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
  const languagePenalty = p.language ? (!v.labels?.language ? 10 : languageKey(v.labels.language) === languageKey(p.language) ? 0 : 20) : 0;
  return languagePenalty + Math.abs((age < 0 ? 3 : age) - Math.max(AGES.indexOf(p.age), AGES.indexOf('young')));
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
  if (who.key === NARRATOR) return { gender: 'any', age: 'middle_aged', sound: `a warm, natural storyteller for: ${world.style}`, language: world.language ?? 'English' };
  const hero = who.key === world.hero.key;
  const prompt = `This is a character of a 2D adventure game${who.figure ? ' (the picture shows them)' : ''}.
Game: ${world.title}. ${world.pitch}
Spoken language: ${world.language ?? 'English'}. Give each character a distinct temperament and natural delivery. Do not infer that every animal or small drawing must sound like a squeaky baby. Avoid toy-robot or exaggerated pitch unless the character is explicitly a robot or the author requested it.
Character key: ${who.key}${hero ? ' (the hero the player plays)' : ''}
Description: ${who.looks}
${who.says?.length ? `They say: ${who.says.map((l) => `"${l}"`).join(' ')}\n` : ''}
Who are they, as far as their voice goes? The key, the description, the game text and how they talk decide gender when they say it (a "girl", "he", a name); otherwise judge by the picture. Judge age by the face and body${who.figure ? ' in the picture' : ''} and the text: a child is under 14 (a boy, a girl, a kid, an errand boy, a small figure next to the adults), a teen 14-19 with a grown body. When unsure between child and teen, say child: an adult-sounding boy is worse than a young-sounding one.
Reply with JSON only: {"gender": "male | female", "age": "child | teen | young | middle_aged | old", "sound": "how their voice should sound, a few words"}`;
  return { ...Profile.parse(await askSparkJson(memo, { schema: Profile, label: `voice-profile:${who.key}`, prompt, images: who.figure ? [who.figure] : [] })), language: world.language ?? 'English' };
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
  const wantsDesign = (k: string) => needsDesign(profiles[k]) || !voiceCandidates(voices, profiles[k]).some((v) => v.labels?.language && languageKey(v.labels.language) === languageKey(profiles[k].language));
  const taken = new Set<string>();
  const reused = Object.fromEntries(keys.filter(wantsDesign).flatMap((k) => {
    const d = reusableDesign(profiles[k], taken);
    if (d) taken.add(d.generated);
    return d ? [[k, d] as const] : [];
  }));
  const designErrors: Record<string, string> = {};
  const designs = Object.fromEntries(await Promise.all(keys.filter(wantsDesign).map(async (k) => {
    if (reused[k]) return [k, reused[k]] as const;
    try {
      return [k, await designVoice(memo, profiles[k], lines.filter((l) => l.speaker === k).map((l) => l.text))] as const;
    } catch (error) {
      designErrors[k] = error instanceof Error ? error.message : String(error);
      console.log(`  ${k}: ${designErrors[k]}; voice remains pending`);
      return [k, undefined] as const;
    }
  })));
  const stock = keys.filter((k) => !wantsDesign(k));
  const candidates = Object.fromEntries(keys.map((k) => [k, voiceCandidates(voices, profiles[k])]));
  const sample = (key: string) => lines.filter((l) => l.speaker === key).slice(0, 2).map((l) => `"${l.text}"`).join(' ');
  const describe = (v: Voice) => `${v.voice_id}: ${v.name}; ${Object.values(v.labels ?? {}).join(', ')}; ${v.description ?? ''}`;
  const prompt = `You cast voice actors for a 2D painted point-and-click adventure: ${world.title}. ${world.pitch}

For each character pick ONE voice from that character's own list (the lists already match their gender and age). Pick by temperament and how they talk. Give different characters different voices when you can. The spoken language is ${world.language ?? 'English'}. Prefer voices native in that language. Set "stability" 0.3-0.7, "style" 0-0.5 and "speed" 0.85-1.0 to suit their personality (a storybook pace a child can follow: never faster than normal; a narrator 0.85-0.92), avoiding exaggerated cartoon delivery.

${stock.map((k) => `## ${k}: ${profiles[k].age.replace('_', ' ')} ${profiles[k].gender === 'any' ? '' : profiles[k].gender}, ${profiles[k].sound}. Says: ${sample(k)}
${candidates[k].map((v) => `- ${describe(v)}`).join('\n')}`).join('\n\n')}

Reply with JSON only: {"<character key>": {"voice": "<voice id>", "why": "few words", "stability": 0.45, "style": 0.2}}`;
  const picked = Cast.safeParse(stock.length ? await askSparkJson<unknown>(memo, { schema: Cast, label: 'cast-voices', prompt }).catch(() => ({})) : {});
  const cast: Cast = {};
  const used = new Set<string>();
  for (const k of keys) {
    const p = profiles[k];
    const design = designs[k];
    if (design) {
      cast[k] = { voice: DESIGNED, why: design.description, stability: 0.45, style: 0.2, speed: 1, profile: p, pitch: 0, design };
      continue;
    }
    if (wantsDesign(k)) {
      cast[k] = { voice: PENDING_DESIGN, why: 'Voice Design pending', stability: 0.45, style: 0.2, speed: 1, profile: p, pitch: 0, pending: designErrors[k] ?? 'Voice Design pending' };
      continue;
    }
    const allowed = candidates[k];
    let choice = picked.success ? picked.data[k] : undefined;
    // A pick outside the character's list is not trusted: the nearest unused voice that fits takes its place.
    if (!choice || !allowed.some((v) => v.voice_id === choice!.voice)) {
      const v = allowed.find((x) => !used.has(x.voice_id)) ?? allowed[0];
      if (!v) throw new Error(`no eligible voice for ${k} (${p.language}, ${p.gender})`);
      choice = { voice: v.voice_id, why: `nearest ${p.age.replace('_', ' ')} ${p.gender} voice`, stability: 0.45, style: 0.2, speed: 1, pitch: 0 };
    }
    used.add(choice.voice);
    const selected = voices.find((v) => v.voice_id === choice.voice);
    const warnings = [
      ...(wantsDesign(k) ? ['Voice Design unavailable; a stock actor stands in without pitch shifting'] : []),
      ...(languageKey(selected?.labels?.language ?? 'unknown') !== languageKey(p.language) ? [`native ${p.language} voice not confirmed; audition this actor`] : []),
    ];
    cast[k] = { ...choice, profile: p, pitch: 0, warnings };
  }
  return cast;
}

const letters = (s: string) => s.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

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

/**
 * heardMatch on what is said, not what is written: "10+10=20" is compared as "dziesięć plus dziesięć równa się
 * dwadzieścia", and a transcript that writes digits is read as words too. Numbers must be the same numbers: a take
 * that says another number than the line fails however close the letters are.
 */
export function spokenMatch(line: string, heard: string, language?: string): number {
  // Laughs, hoots and snores in a line ("Hu-hu... dobranoc... Chrrr.") are acted, but the transcriber writes them
  // down rarely and never the same way: 4 lines of one world were rejected after 3 takes for them alone. Only the
  // words are compared. A word written twice in a row that the line has once is a transcriber stutter.
  const said = spokenText(withoutSounds(line), language);
  const raw = spokenText(withoutSounds(heard), language);
  const got = [raw, withoutStutter(raw, said)];
  const want = numberWords(said, language);
  const best = Math.max(...got.map((g) => heardMatch(said, g)));
  if (want.length && got.every((g) => want.join(' ') !== numberWords(g, language).join(' '))) return Math.min(best, 0.5);
  return best;
}

/** The text without words that are only a sound (see soundsOnly); a line of sounds alone stays as it is. */
export function withoutSounds(text: string): string {
  const kept = text.split(/\s+/).filter((w) => {
    const parts = w.normalize('NFC').toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
    return !parts.length || !parts.every((p) => p.length > 1 && SOUND.test(p));
  });
  return kept.some((w) => /\p{L}/u.test(w)) ? kept.join(' ') : text;
}

/** Drops a word repeated right after itself, unless the line itself repeats it there. */
function withoutStutter(heard: string, said: string): string {
  const key = (w: string) => w.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const lineWords = said.split(/\s+/).map(key);
  const doubled = new Set(lineWords.filter((w, i) => w && w === lineWords[i - 1]));
  const words = heard.split(/\s+/);
  return words.filter((w, i) => !(i > 0 && key(w) && key(w) === key(words[i - 1]) && !doubled.has(key(w)))).join(' ');
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

/** Context stays in API fields, never in the spoken text. Multilingual v2 has no language_code support. */
export function speechRequest(line: Line, voice: Cast[string], model: string, take: number) {
  const language = languageKey(voice.profile?.language);
  // The actor reads the spoken form: "10+10=20" as words, in the line's language.
  return { text: spokenText(line.text, voice.profile?.language), model_id: model,
    voice_settings: { stability: voice.stability, similarity_boost: 0.8, style: voice.style, speed: voice.speed ?? 1, use_speaker_boost: true },
    ...(model !== FINAL_TTS && /^[a-z]{2}$/.test(language) && { language_code: language }),
    ...(line.previousText && { previous_text: line.previousText }), ...(line.nextText && { next_text: line.nextText }),
    ...(take > 1 && { seed: 1000 + take }) };
}

function speak(memo: Memo, label: string, line: Line, voice: Cast[string], take: number, designed?: DesignedVoices, retrySeed?: number): Promise<Buffer> {
  const body = (model: string) => ({ ...speechRequest(line, voice, model, take), ...(retrySeed !== undefined && { seed: retrySeed + take - 1 }) });
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

/**
 * Listens to a take: first on the file route (a few at once, 2-3 s a line), and only a take that does not match goes
 * to the realtime route too (one stream at a time, as long as the clip), because the file route now and then writes
 * a word twice. The better hearing counts. Voices of one world were 15 minutes of realtime listening before.
 */
export async function listenBack(memo: Memo, label: string, pcm: Buffer, line: string, language?: string): Promise<{ heard: string; match: number }> {
  const spoken = spokenText(line, language);
  let quick: { heard: string; match: number } | undefined;
  try {
    const heard = (await memo.remember('voice', `${label}#file`, inputHash('quick-stt-v1', pcm), 'txt', async () => Buffer.from(await quickTranscribe(pcm), 'utf8'))).toString('utf8');
    quick = { heard, match: spokenMatch(line, heard, language) };
    if (heardOk(spoken, quick.match)) return quick;
  } catch { /* the realtime route below decides */ }
  try {
    const heard = await transcribe(memo, label, pcm);
    const slow = { heard, match: spokenMatch(line, heard, language) };
    return quick && quick.match > slow.match ? quick : slow;
  } catch (error) {
    if (quick) return quick;
    throw error;
  }
}

export const lineId = (line: Line) => `line-${inputHash(line.speaker, line.text).slice(0, 10)}`;

/** Close enough: 90% of the letters, or at most two letters off, so a short line is not failed for one misheard word ("a" for "of"). */
export const heardOk = (line: string, match: number) => match >= 0.9 || (match >= 0.7 && (1 - match) * letters(withoutSounds(line)).length <= 2.01);

/** Laughs, sighs and calls: no word a transcriber writes down the way the line spells it. */
const SOUND = /^(?:c?h+r+|(?:h+[aeiouy]+h*)+|(?:[aeiouy]+h+)+|a+w+|o+w+|u+g+h+|e+w+|h+m+|m+h*m*|m+|u+h*m+|e+r+m*|h+u+h+|h+e+h+|p+s+t+|s+h+|t+s+k+|z+|w+h+e+e+|y+a+y+|w+o+w+|o+o+h*|a+r+g+h+|o+j+(?:e+j+)?|a+c+h+|o+c+h+|e+c+h+|u+f+|h+y+h+y+)$/;
export function soundsOnly(text: string): boolean {
  const words = text.normalize('NFC').toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  return words.length > 0 && words.every((w) => SOUND.test(w));
}

/** Reads one line, listens back, and reads it again (up to 3 takes, 2 in draft) until the transcript matches. */
export async function voiceLine(memo: Memo, line: Line, voice: Cast[string], write: (id: string, mp3: Buffer) => string, designed?: DesignedVoices, opts: { retryRejected?: boolean } = {}): Promise<z.infer<typeof VoiceLine>> {
  const id = lineId(line);
  // A rejected batch needs genuinely new seeds/cache keys. Persist the batch before requesting audio:
  // a later ASR outage must resume these paid takes, not buy another batch or return to rejected ones.
  const retryFile = path.join(memo.dir, 'voice-retakes', `${inputHash(voice.design?.generated ?? voice.voice, JSON.stringify(speechRequest(line, voice, ttsModel(), 1)), String(voice.pitch ?? 0))}.json`);
  let retrySeed: number | undefined;
  if (fs.existsSync(retryFile)) {
    retrySeed = JSON.parse(fs.readFileSync(retryFile, 'utf8')).seed;
    if (!Number.isInteger(retrySeed) || retrySeed! < 1 || retrySeed! > 0xfffffffc) throw new Error('invalid saved voice retake seed');
  }
  if (opts.retryRejected) {
    retrySeed = randomInt(1, 0xfffffffc);
    fs.mkdirSync(path.dirname(retryFile), { recursive: true });
    const tmp = `${retryFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ seed: retrySeed }));
    fs.renameSync(tmp, retryFile);
  }
  const spoken = spokenText(line.text, voice.profile?.language);
  // A laugh or a sigh ("hee hee", "hmm") is no words to transcribe: the transcriber hears nothing or something else,
  // and three takes of it were rejected. The first clean take is used, flagged.
  const sound = soundsOnly(spoken);
  let best: { pcm: Pcm; heard: string; match: number; take: number } | undefined;
  const takes = lineTakes();
  for (let take = 1; take <= takes; take++) {
    const pcm = pitchShift(trim(decode(await speak(memo, `${id}-${take}`, line, voice, take, designed, retrySeed)), 0.005), voice.pitch ?? 0);
    if (audioProblem(pcm)) continue;
    if (sound) { best = { pcm, heard: '', match: 0, take }; break; }
    const { heard, match } = await listenBack(memo, `${id}-${take}`, pcm24k(pcm), line.text, voice.profile?.language);
    if (!best || match > best.match) best = { pcm, heard, match, take };
    if (heardOk(spoken, match)) break;
  }
  if (!best || !(sound || heardOk(spoken, best.match))) throw new Error(`speech rejected after ${takes} takes: ${best ? `heard ${Math.round(best.match * 100)}% of the line: "${best.heard}"` : 'no clean audible recording'}`);
  const flags = [...(best.take > 1 ? [`take ${best.take} used`] : []), ...(sound ? ['a sound, not words: not checked by transcript'] : [])];
  const pcm = normalise(best!.pcm, -18);
  return { speaker: line.speaker, text: line.text, file: write(id, encodeMp3(pcm, 128)), seconds: Math.round(seconds(pcm) * 100) / 100, heard: best!.heard, match: Math.round(best!.match * 100) / 100, flags };
}
