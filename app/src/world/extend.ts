// Incremental world design. Spark proposes additions; the existing world and story are never model output.
import { z } from 'zod';
import type { Memo } from '../meta/memo.ts';
import { askSparkJson } from '../meta/spark.ts';
import { checkStory, questionIssues, type StoryReport } from '../story/check.ts';
import { Story } from '../story/schema.ts';
import { NPC_STORY_GUIDANCE } from '../story/npc-guidance.ts';
import { drawnIssues, type Drawn } from './drawings.ts';
import { checkWorld, Place, Slug, Thing, type World } from './schema.ts';

const Additions = z.object({
  anchor: Slug,
  things: z.array(Thing).min(1),
  exits: z.array(z.object({ to: Slug, via: Slug })).default([]),
  places: z.array(Place).default([]),
  names: z.record(z.string(), z.string().min(1).max(40)).default({}),
});
export type Additions = z.infer<typeof Additions>;

/** Merge only additions; the model cannot rewrite a place, hero or prior exit. */
export function mergeWorld(world: World, raw: unknown, drawings: Drawn[]): { world?: World; issues: string[]; changed: string[] } {
  const parsed = Additions.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`), changed: [] };
  const a = parsed.data;
  const anchor = world.places.find(p => p.key === a.anchor);
  if (!anchor) return { issues: [`unknown anchor ${a.anchor}`], changed: [] };
  const existingPlaces = new Set(world.places.map(p => p.key));
  const existingThings = new Set([world.hero.key, ...world.places.flatMap(p => p.things.map(t => t.key))]);
  const issues: string[] = [];
  const allNew = [...a.things, ...a.places.flatMap(p => p.things)];
  if (a.places.some(p => existingPlaces.has(p.key))) issues.push('new place keys must not reuse existing places');
  if (allNew.some(t => existingThings.has(t.key))) issues.push('new thing keys must not reuse existing things or the hero');
  if (new Set(allNew.map(t => t.key)).size !== allNew.length) issues.push('new thing keys must be unique across places');
  if (a.exits.some(e => !a.things.some(t => t.key === e.via && t.role === 'exit'))) issues.push('each new anchor exit must use a newly added exit thing');
  if (a.exits.some(e => existingPlaces.has(e.to))) issues.push('new anchor exits must lead to new places');
  if (a.places.length && !a.exits.length) issues.push('connect new places to the anchor');
  for (const key of Object.keys(a.names)) if (existingThings.has(key) || existingPlaces.has(key) || world.names?.[key] !== undefined) issues.push(`cannot replace the existing name ${key}`);
  const candidate = { ...world, places: world.places.map(p => p.key === a.anchor ? { ...p, things: [...p.things, ...a.things], exits: [...p.exits, ...a.exits] } : p).concat(a.places), names: { ...world.names, ...a.names } };
  const checked = checkWorld(candidate);
  issues.push(...checked.issues);
  if (checked.world) issues.push(...drawnIssues(checked.world, drawings));
  return { ...(checked.world && !issues.length ? { world: checked.world } : {}), issues, changed: [a.anchor, ...a.places.map(p => p.key)] };
}

const StoryAddition = Story.omit({ intro: true }).extend({ endings: z.array(Story.shape.endings.element).default([]) });
export type StoryAddition = z.infer<typeof StoryAddition>;

/** Existing script keeps its order, including conditional interactions and changes/plate indices. */
export function mergeStory(world: World, old: Story, raw: unknown, changed: string[], oldWorld: World): { story?: Story; issues: string[]; report?: StoryReport } {
  const parsed = StoryAddition.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`) };
  const a = parsed.data;
  const oldKeys = new Set(oldWorld.places.flatMap(p => p.things.map(t => `${p.key}/${t.key}`)));
  const newThings = world.places.filter(p => changed.includes(p.key)).flatMap(p => p.things.filter(t => !oldKeys.has(`${p.key}/${t.key}`)).map(t => ({ ...t, place: p.key })));
  const issues: string[] = [];
  if (a.interactions.some(i => oldKeys.has(`${i.place}/${i.thing}`)) || a.dialogues.some(d => oldKeys.has(`${d.place}/${d.npc}`)) || a.changes.some(c => oldKeys.has(`${c.place}/${c.thing}`)) || a.locks.some(l => oldKeys.has(`${l.place}/${l.via}`))) issues.push('add story only for new things; existing script must remain unchanged');
  for (const t of newThings) {
    if (!a.interactions.some(i => i.place === t.place && i.thing === t.key && i.verb === 'look')) issues.push(`${t.place}/${t.key} needs a look interaction`);
    if (t.role === 'npc' && !a.dialogues.some(d => d.place === t.place && d.npc === t.key && d.lines.some(l => l.choices.length))) issues.push(`${t.place}/${t.key} needs a dialogue with choices`);
    if (t.role === 'item' && (!a.items.some(i => i.key === t.key) || !a.interactions.some(i => i.place === t.place && i.thing === t.key && i.verb === 'take' && i.once && i.do.some(e => 'give' in e && e.give === t.key)))) issues.push(`${t.place}/${t.key} needs an item and a one-time take interaction`);
  }
  for (const field of ['items', 'endings'] as const) {
    const keys = [...old[field], ...a[field]].map(x => x.key);
    if (new Set(keys).size !== keys.length) issues.push(`${field} keys repeat`);
  }
  // New puzzles must not consume the old story's inventory or set/clear its flags.
  const oldItems = new Set(old.items.map(i => i.key));
  const oldFlags = new Set<string>();
  const scan = (value: unknown) => {
    if (typeof value === 'string' && /^!?[a-z][a-z0-9-]*$/.test(value)) oldFlags.add(value.replace(/^!/, ''));
    else if (Array.isArray(value)) value.forEach(scan);
    else if (value && typeof value === 'object') Object.values(value).forEach(scan);
  };
  for (const i of old.interactions) { scan(i.when); for (const e of i.do) if ('set' in e || 'clear' in e) scan('set' in e ? e.set : e.clear); }
  for (const l of old.locks) scan(l.until);
  for (const c of old.changes) scan(c.when);
  for (const p of old.patrols ?? []) scan(p.when);
  for (const d of old.dialogues) { scan(d.when); for (const l of d.lines) for (const c of l.choices) { scan(c.when); for (const e of c.do) if ('set' in e || 'clear' in e) scan('set' in e ? e.set : e.clear); } }
  const effects = [...a.interactions.flatMap(i => i.do), ...a.dialogues.flatMap(d => d.lines.flatMap(l => l.choices.flatMap(c => c.do)))];
  const oldNpcs = new Set(oldWorld.places.flatMap(p => p.things.filter(t => t.role === 'npc').map(t => t.key)));
  if (effects.some(e => 'moveNpc' in e && oldNpcs.has(e.moveNpc.npc)) || a.patrols?.some(p => oldNpcs.has(p.npc))) issues.push('new motion must not change existing NPCs');
  if (effects.some(e => ('set' in e && oldFlags.has(e.set)) || ('clear' in e && oldFlags.has(e.clear)) || ('take' in e && oldItems.has(e.take)) || ('give' in e && oldItems.has(e.give)))) issues.push('new effects must not change old flags or inventory items');
  if (!a.dialogues.length && !a.interactions.some(i => i.verb !== 'look' && i.do.length)) issues.push('add a conversation or an interactive activity, not only look lines');
  issues.push(...questionIssues(Story.parse({ intro: old.intro, ...a, endings: a.endings.length ? a.endings : old.endings })));
  const story = Story.parse({ intro: old.intro, items: [...old.items, ...a.items], locks: [...old.locks, ...a.locks], interactions: [...old.interactions, ...a.interactions], dialogues: [...old.dialogues, ...a.dialogues], changes: [...old.changes, ...a.changes],
    ...((old.patrols || a.patrols) && { patrols: [...(old.patrols ?? []), ...(a.patrols ?? [])] }), endings: [...old.endings, ...a.endings] });
  const report = checkStory(world, story);
  issues.push(...report.issues);
  const oldPlaceKeys = new Set(oldWorld.places.map(p => p.key));
  const newPlaces = world.places.filter(p => !oldPlaceKeys.has(p.key));
  const newEndings = new Set(a.endings.map(e => e.key));
  for (const place of newPlaces) {
    const incoming = world.places.flatMap(p => p.exits.filter(e => e.to === place.key).map(e => e.via));
    const endsHere = new Set([
      ...a.interactions.filter(i => i.place === place.key).flatMap(i => i.do),
      ...a.dialogues.filter(d => d.place === place.key).flatMap(d => d.lines.flatMap(l => l.choices.flatMap(c => c.do))),
    ].flatMap(e => 'ending' in e ? [e.ending] : []));
    if (!report.routes.some(r => newEndings.has(r.ending) && endsHere.has(r.ending) && r.actions.some(a => a.kind === 'go' && incoming.includes(a.via)))) issues.push(`a new ending must be reached by an activity in ${place.key}`);
  }
  return { ...(!issues.length ? { story } : {}), issues, report };
}

export async function designExtension(memo: Memo, oldWorld: World, oldStory: Story, drawings: Drawn[], wish: string): Promise<{ world: World; story: Story; changed: string[]; report: StoryReport }> {
  const base = `Extend this existing point-and-click world from the new drawings and the person's wish. Do not rewrite existing places, people, exits, or script. Add a new place for each drawing whose kind is place, and include each new drawing under exactly its key and role. Add characters shown in scenes as NPCs where appropriate. Existing places have at most 10 things and the whole world at most 8 places. Connect each new place both ways with visible exit things. Use one existing anchor, adding visible things to it; its painting will be rebuilt. Keep descriptions in English, names in ${oldWorld.language ?? 'English'}. Wish: ${wish}\nDrawings: ${JSON.stringify(drawings)}\nExisting world: ${JSON.stringify(oldWorld)}\nReturn JSON only: {"anchor":"existing-place-key","things":[{"key":"new-key","role":"exit|npc|item|prop","looks":"..."}],"exits":[{"via":"new-exit-key","to":"new-place-key"}],"places":[{"key":"...","shows":"...","mood":"...","things":[...],"exits":[...]}],"names":{"new-key":"name"}}. No reused thing keys. For character/item-only drawings, add them to the anchor; places may be empty.`;
  let prompt = base;
  let world: World | undefined; let changed: string[] = [];
  for (let i = 1; i <= 4; i++) {
    const answer = await askSparkJson(memo, { label: `extend-world#${i}`, prompt });
    const result = mergeWorld(oldWorld, answer, drawings);
    if (result.world) { world = result.world; changed = result.changed; break; }
    prompt = `${base}\nPrevious answer: ${JSON.stringify(answer)}\nFix: ${result.issues.join('; ')}`;
  }
  if (!world) throw new Error('Could not design a valid extension in 4 tries; the existing world was not changed');
  const scriptBase = `Write ONLY additions to this point-and-click story. Preserve every existing line, ending and puzzle: do not repeat or edit them. Add look interactions for every new thing, take for new items (give their key, once true), dialogue with choices for new NPCs, and a small engaging activity involving the new material. Add a new ending reachable through each new place, triggered by an activity there. New interactions, dialogues, changes and locks may address only new things. Do not set or clear existing flags, or give or take existing items. Exit things may only have look interactions; they already move the player. Every ending must remain reachable from every non-ending state. A line with no choices must not ask a question.\n${NPC_STORY_GUIDANCE}\nExtension scope: apply these stages and optional motion only to newly added NPCs. Preserve existing NPC flags, patrol order, locations and script. Use fresh NPC-prefixed flags, including flags used only in negative conditions; new effects must not move old NPCs. Dialogue and interactions for a newly added travelling NPC may refer to its destination even though it is declared only at its original place. Use short friendly lines in ${world.language ?? 'English'}.\nWish: ${wish}\nDrawings: ${JSON.stringify(drawings)}\nExisting world: ${JSON.stringify(oldWorld)}\nExtended world: ${JSON.stringify(world)}\nExisting story: ${JSON.stringify(oldStory)}\nReturn JSON with arrays items, locks, interactions, dialogues, changes, endings and optional patrols (omit or [] when nobody needs a repeated walk). Same shapes and effects as existing story; empty arrays are fine. Do not include intro. Each new item and ending needs a unique key.`;
  prompt = scriptBase;
  for (let i = 1; i <= 4; i++) {
    const answer = await askSparkJson(memo, { label: `extend-story#${i}`, prompt });
    const result = mergeStory(world, oldStory, answer, changed, oldWorld);
    if (result.story && result.report) return { world, story: result.story, changed, report: result.report };
    prompt = `${scriptBase}\nPrevious answer: ${JSON.stringify(answer)}\nFix: ${result.issues.join('; ')}`;
  }
  throw new Error('Could not design a playable story extension in 4 tries; the existing world was not changed');
}
