// The person's changes to the story, kept in story-fixes.json and applied by every rebuild of story.json:
// a wish Spark writes the story to (puzzles, conditions, endings), and lines reworded by hand.
import fs from 'node:fs';
import { z } from 'zod';
import type { WorldFiles } from '../world/files.ts';
import type { Story } from './schema.ts';

export const StoryFixes = z.object({
  wish: z.string().min(5).optional(),
  /** Reworded text by its place in story.json, e.g. "dialogues.0.lines.2.says". */
  texts: z.record(z.string(), z.object({ text: z.string().min(1), at: z.string() })).default({}),
});
export type StoryFixes = z.infer<typeof StoryFixes>;

/** The fields that are only words: changing them never changes what the player can do. */
export const TEXT_KEYS = ['intro', 'say', 'says', 'text', 'title', 'name', 'looks'] as const;

export const storyFixesFile = (files: WorldFiles) => files.path('story-fixes.json');

export function readStoryFixes(files: WorldFiles): StoryFixes {
  const file = storyFixesFile(files);
  return fs.existsSync(file) ? StoryFixes.parse(files.readJson(file)) : { texts: {} };
}

/** The object holding a text field and the field's name, or null when the path names no text. */
function locate(story: unknown, path: string): [Record<string, unknown>, string] | null {
  const parts = path.split('.');
  const last = parts.pop()!;
  if (!(TEXT_KEYS as readonly string[]).includes(last)) return null;
  let at: unknown = story;
  for (const p of parts) {
    if (Array.isArray(at) && /^\d+$/.test(p)) at = at[Number(p)];
    else if (at && typeof at === 'object' && !Array.isArray(at) && /^[a-z]+$/.test(p)) at = (at as Record<string, unknown>)[p];
    else return null;
  }
  return at && typeof at === 'object' && typeof (at as Record<string, unknown>)[last] === 'string' ? [at as Record<string, unknown>, last] : null;
}

export function textAt(story: Story, path: string): string | null {
  const hit = locate(story, path);
  return hit ? (hit[0][hit[1]] as string) : null;
}

/** The story with the reworded lines in; paths that no longer name a text are left out and listed. */
export function applyTexts(story: Story, fixes: StoryFixes): { story: Story; skipped: string[] } {
  const out = structuredClone(story);
  const skipped: string[] = [];
  for (const [path, { text }] of Object.entries(fixes.texts)) {
    const hit = locate(out, path);
    if (hit) hit[0][hit[1]] = text;
    else skipped.push(path);
  }
  return { story: out, skipped };
}
