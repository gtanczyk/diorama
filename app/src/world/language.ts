// A world told in another language: every word the player reads or hears (title, pitch, names, the whole story)
// translated in one Spark pass, so names stay the same everywhere they appear. What the painters read (style,
// shows, mood, looks, a change's looks) is English already and stays; keys and flags never change, so the
// puzzles, masks, paintings and sounds all still fit. The voices are cast again for the new language afterwards.
import fs from 'node:fs';
import { z } from 'zod';
import { askSparkJson } from '../meta/spark.ts';
import type { Memo } from '../meta/memo.ts';
import { soundQuality } from '../sound/cost.ts';
import { languageKey } from '../sound/language.ts';
import { needsDesign, storyLines, Voices } from '../sound/voices.ts';
import type { Story } from '../story/schema.ts';
import type { WorldFiles } from './files.ts';
import type { World } from './schema.ts';

/** Story fields the player reads or hears. A change's `looks` is for the painter: it stays English. */
const STORY_TEXT = new Set(['intro', 'say', 'says', 'text', 'title', 'name', 'nope']);

/** Every player-facing text of a world and its story, by an id that says where it lives. */
export function worldTexts(world: World, story: Story | null): Record<string, string> {
  const out: Record<string, string> = { 'world.title': world.title, 'world.pitch': world.pitch };
  for (const [key, name] of Object.entries(world.names ?? {})) out[`names.${key}`] = name;
  const walk = (node: unknown, path: string[]) => {
    if (Array.isArray(node)) node.forEach((n, i) => walk(n, [...path, String(i)]));
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (typeof v === 'string') {
          if (STORY_TEXT.has(k) && !(path[0] === 'changes')) out[`story.${[...path, k].join('.')}`] = v;
        } else walk(v, [...path, k]);
      }
    }
  };
  if (story) walk(story, []);
  return out;
}

/** The world and story with the translated texts put back at their ids. */
export function applyWorldTexts(world: World, story: Story | null, texts: Record<string, string>, language: string): { world: World; story: Story | null } {
  const w: World = structuredClone(world);
  const s: Story | null = story && structuredClone(story);
  for (const [id, text] of Object.entries(texts)) {
    const [head, ...rest] = id.split('.');
    if (head === 'world') (w as Record<string, unknown>)[rest[0]] = text;
    else if (head === 'names') w.names = { ...w.names, [rest.join('.')]: text };
    else if (head === 'story' && s) {
      let at: unknown = s;
      const last = rest.pop()!;
      for (const p of rest) at = Array.isArray(at) ? at[Number(p)] : (at as Record<string, unknown>)[p];
      if (at && typeof at === 'object') (at as Record<string, unknown>)[last] = text;
    }
  }
  if (languageKey(language) === 'en') delete w.language;
  else w.language = language;
  return { world: w, story: s };
}

const Answer = z.object({ texts: z.record(z.string(), z.string()) });

/**
 * One Spark pass over all the texts, so a name reads the same in the title, the dialogue and the inventory.
 * Ids missing from the answer are asked for once more, with the names already chosen; an empty answer throws.
 */
export async function translateTexts(memo: Memo, texts: Record<string, string>, from: string, to: string, kids: boolean): Promise<Record<string, string>> {
  const ask = (todo: Record<string, string>, names: Record<string, string>) => askSparkJson(memo, {
    label: `language:${languageKey(to)}`,
    schema: Answer,
    prompt: `Translate the player-facing text of a point-and-click adventure game from ${from} to ${to}.
Write it as a native ${to} game writer would${kids ? ' for children aged 5 to 7, who hear every line read aloud' : ''}: natural, idiomatic and warm, not word for word. Keep each line's meaning, mood and humour, and keep it about as short (never longer by more than a few words).
- Names of characters, places and items ("names.*", items' "name"): give each a natural ${to} name that keeps the idea or pun of the original (a cat named after butter keeps a buttery name). Use exactly the same name every time it appears in any line, with the same capitalisation style as the original (a lowercase item name stays lowercase).
- A line that is a statement stays a statement; a question stays a question. Keep sound tags in square brackets ([laughs], [whispers]) exactly as they are, untranslated.
- Numbers, riddles and wordplay must still work in ${to}: adapt them, keep the answer the same.
- Every text must be fully in ${to}: no ${from} words left, except a name that is the same in both languages.
${Object.keys(names).length ? `Names already chosen (use them): ${JSON.stringify(names)}\n` : ''}Texts (id: text): ${JSON.stringify(todo)}
Reply with JSON only: {"texts": {"<the same id>": "<${to} text>", ...}} with every id above exactly once.`,
  });
  const first = (await ask(texts, {})).texts;
  const done = Object.fromEntries(Object.keys(texts).filter((id) => first[id]?.trim()).map((id) => [id, first[id].trim()]));
  const missing = Object.fromEntries(Object.entries(texts).filter(([id]) => !done[id]));
  if (Object.keys(missing).length) {
    const names = Object.fromEntries(Object.entries(done).filter(([id]) => id.startsWith('names.') || /\.name$/.test(id)));
    const again = (await ask(missing, names)).texts;
    for (const id of Object.keys(missing)) if (again[id]?.trim()) done[id] = again[id].trim();
  }
  const still = Object.keys(texts).filter((id) => !done[id]);
  if (still.length) throw new Error(`Spark left ${still.length} text(s) untranslated: ${still.slice(0, 5).join(', ')}`);
  return done;
}

/** A person's voice wish written for the old language ("Native Polish speaker…") says the new one instead. */
export function relanguage(text: string, from: string, to: string): string {
  return text.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), to);
}

export type LanguagePlan = { from: string; to: string; same: boolean; texts: number; lines: number; characters: number; credits: number; designs: string[]; quality: 'draft' | 'final' };

/**
 * What a change of language redoes: one Spark pass over the texts, then every spoken line read again (about one
 * ElevenLabs credit a character in final quality, half in draft) and a Voice Design for each child, teen or old speaker.
 * The lines are counted in the old language: a translation is about as long.
 */
export function languagePlan(files: WorldFiles, world: World, story: Story | null, language: string): LanguagePlan {
  const from = world.language ?? 'English';
  const same = languageKey(from) === languageKey(language);
  const kids = world.audience === 'kids';
  const lines = story ? storyLines(world, story, kids) : [];
  const characters = lines.reduce((n, l) => n + l.text.length, 0);
  const quality = soundQuality();
  const voices = fs.existsSync(files.path('voices.json')) ? Voices.safeParse(files.readJson(files.path('voices.json'))) : undefined;
  const designs = voices?.success ? Object.entries(voices.data.cast).filter(([, c]) => c.profile && needsDesign(c.profile)).map(([k]) => k) : [];
  return { from, to: language, same, texts: Object.keys(worldTexts(world, story)).length, lines: lines.length, characters, credits: Math.round(characters * (quality === 'final' ? 1 : 0.5)), designs, quality };
}

export const planLine = (p: LanguagePlan) => (p.same
  ? `already in ${p.to}: the texts stay; the voices are read again only where they are not in ${p.to} yet`
  : `${p.texts} texts translated from ${p.from} to ${p.to} in one Spark pass (cents); then ${p.lines} spoken lines read again, about ${p.characters} characters, ~${p.credits} ElevenLabs credits (${p.quality})`
    + `${p.designs.length ? `, plus a new designed voice for ${p.designs.join(', ')}` : ''}; paintings, masks, sounds and puzzles stay`);
