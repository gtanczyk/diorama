// The story gate: every name must exist in the world, every ending must be reachable, and no
// reachable state may cut the player off from all endings. Finds a shortest route to each ending too.
import type { World } from '../world/schema.ts';
import { actions, apply, describe, pickInteraction, startState, stateKey, type Action, type State } from './engine.ts';
import { Story } from './schema.ts';

export type Route = { ending: string; steps: string[]; actions: Action[] };
export type StoryReport = { issues: string[]; states: number; routes: Route[] };

const MAX_STATES = 200_000;

export function storyNameIssues(world: World, story: Story): string[] {
  const issues: string[] = [];
  const place = (key: string) => world.places.find((p) => p.key === key);
  const items = new Set(story.items.map((i) => i.key));
  const endings = new Set(story.endings.map((e) => e.key));
  const setFlags = new Set<string>();
  const given = new Set<string>();
  const allEffects = [...story.interactions.flatMap((i) => i.do), ...story.dialogues.flatMap((d) => d.lines.flatMap((l) => l.choices.flatMap((c) => c.do)))];
  for (const e of allEffects) {
    if ('set' in e) setFlags.add(e.set);
    if ('give' in e) given.add(e.give);
    if ('give' in e || 'take' in e) { const k = 'give' in e ? e.give : (e as { take: string }).take; if (!items.has(k)) issues.push(`effect uses unknown item "${k}"`); }
    if ('go' in e && !place(e.go)) issues.push(`effect goes to unknown place "${e.go}"`);
    if ('ending' in e && !endings.has(e.ending)) issues.push(`effect ends with unknown ending "${e.ending}"`);
  }
  const checkWhen = (where: string, when: string[]) => {
    for (const fact of when) {
      const body = fact.replace(/^!/, '');
      if (body.startsWith('has:') && !items.has(body.slice(4))) issues.push(`${where}: unknown item in "${fact}"`);
      else if (body.startsWith('at:') && !place(body.slice(3))) issues.push(`${where}: unknown place in "${fact}"`);
      else if (!body.includes(':') && !fact.startsWith('!') && !setFlags.has(body)) issues.push(`${where}: flag "${body}" is never set`);
    }
  };
  const thingIn = (where: string, placeKey: string, thing: string, role?: string) => {
    const p = place(placeKey);
    if (!p) return issues.push(`${where}: unknown place "${placeKey}"`);
    const t = p.things.find((x) => x.key === thing);
    if (!t) issues.push(`${where}: "${thing}" is not a thing in ${placeKey}`);
    else if (role && t.role !== role) issues.push(`${where}: "${thing}" must have role "${role}"`);
  };
  story.interactions.forEach((it, i) => {
    const where = `interaction ${i + 1} (${it.verb} ${it.thing})`;
    thingIn(where, it.place, it.thing, it.verb === 'talk' ? 'npc' : undefined);
    // Clicking an exit always walks through it (and obeys its lock), so an exit only answers "look".
    const exit = place(it.place)?.things.find((t) => t.key === it.thing)?.role === 'exit';
    if (exit && it.verb !== 'look') issues.push(`${where}: "${it.thing}" is an exit; clicking it goes through, so it can only have "look" interactions (use a lock to stop it)`);
    if (it.with && !items.has(it.with)) issues.push(`${where}: unknown item "${it.with}"`);
    checkWhen(where, it.when);
  });
  for (const lock of story.locks) {
    thingIn(`lock on ${lock.via}`, lock.place, lock.via, 'exit');
    checkWhen(`lock on ${lock.via}`, lock.until);
  }
  story.changes.forEach((c, i) => {
    thingIn(`change ${i + 1} (${c.thing})`, c.place, c.thing);
    checkWhen(`change ${i + 1} (${c.thing})`, c.when);
  });
  for (const d of story.dialogues) {
    const where = `dialogue with ${d.npc}`;
    thingIn(where, d.place, d.npc, 'npc');
    checkWhen(where, d.when);
    const keys = new Set(d.lines.map((l) => l.key));
    if (!keys.has(d.start)) issues.push(`${where}: start line "${d.start}" is missing`);
    for (const l of d.lines) for (const c of l.choices) {
      if (c.next && !keys.has(c.next)) issues.push(`${where}: line "${l.key}" leads to missing "${c.next}"`);
      checkWhen(`${where}, line ${l.key}`, c.when);
    }
  }
  for (const item of items) if (!given.has(item)) issues.push(`item "${item}" is never given`);
  return issues;
}

/** Breadth-first over every state the player can reach. */
export function checkStory(world: World, raw: unknown): StoryReport & { story?: Story } {
  const parsed = Story.safeParse(raw);
  if (!parsed.success) return { issues: parsed.error.issues.map((i) => `${i.path.join('.') || 'story'}: ${i.message}`), states: 0, routes: [] };
  const story = parsed.data;
  const nameIssues = storyNameIssues(world, story);
  if (nameIssues.length) return { issues: nameIssues, states: 0, routes: [] };

  const start = startState(world);
  const seen = new Map<string, { state: State; from?: string; via?: Action }>([[stateKey(start), { state: start }]]);
  const edges = new Map<string, string[]>();
  const queue = [stateKey(start)];
  const fired = new Set<number>();
  while (queue.length && seen.size < MAX_STATES) {
    const key = queue.shift()!;
    const { state } = seen.get(key)!;
    const out: string[] = [];
    for (const action of actions(world, story, state)) {
      const step = apply(world, story, state, action);
      if (action.kind === 'do') fired.add(pickInteraction(story, state, action));
      const nextKey = stateKey(step.state);
      out.push(nextKey);
      if (!seen.has(nextKey)) { seen.set(nextKey, { state: step.state, from: key, via: action }); queue.push(nextKey); }
    }
    edges.set(key, out);
  }
  const issues: string[] = [];
  if (seen.size >= MAX_STATES) issues.push(`more than ${MAX_STATES} states; the story is too loose to check`);

  const actionsTo = (key: string) => {
    const out: Action[] = [];
    for (let at = seen.get(key); at?.from; at = seen.get(at.from)) out.unshift(at.via!);
    return out;
  };
  const routeTo = (key: string) => actionsTo(key).map(describe);
  const routes: Route[] = [];
  for (const ending of story.endings) {
    const hit = [...seen.entries()].find(([, v]) => v.state.ending === ending.key);
    if (hit) routes.push({ ending: ending.key, steps: routeTo(hit[0]), actions: actionsTo(hit[0]) });
    else issues.push(`ending "${ending.key}" cannot be reached`);
  }

  // States that can still reach an ending, found backwards from the ending states.
  const back = new Map<string, string[]>();
  for (const [from, tos] of edges) for (const to of tos) back.set(to, [...(back.get(to) ?? []), from]);
  const alive = new Set([...seen.keys()].filter((k) => seen.get(k)!.state.ending));
  const stack = [...alive];
  while (stack.length) for (const from of back.get(stack.pop()!) ?? []) if (!alive.has(from)) { alive.add(from); stack.push(from); }
  const stuck = [...seen.keys()].filter((k) => !alive.has(k) && edges.has(k));
  if (stuck.length) {
    const first = stuck.reduce((a, b) => (routeTo(a).length <= routeTo(b).length ? a : b));
    issues.push(`${stuck.length} reachable state(s) can never reach an ending, e.g. after: ${routeTo(first).join(' → ') || 'the start'}`);
  }

  story.interactions.forEach((it, i) => {
    if (!fired.has(i)) issues.push(`interaction ${i + 1} (${it.verb} ${it.thing} in ${it.place}) can never happen`);
  });
  return { issues, states: seen.size, routes, story: issues.length ? undefined : story };
}

/** Word limits per kind of line: everything said is read or voiced, so less is better. */
export const BREVITY = { intro: 30, say: 14, npcLine: 20, choice: 8, ending: 25, linesPerDialogue: 6 } as const;

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean).length;

/** Lines over the limits, for the designer to shorten. Not part of checkStory: a person may write longer by hand. */
export function brevityIssues(story: Story): string[] {
  const issues: string[] = [];
  const over = (where: string, text: string, max: number) => {
    if (words(text) > max) issues.push(`${where} has ${words(text)} words, keep it to ${max}: "${text}"`);
  };
  over('intro', story.intro, BREVITY.intro);
  story.interactions.forEach((it, i) => over(`interaction ${i + 1} (${it.verb} ${it.thing}) say`, it.say, BREVITY.say));
  story.locks.forEach((l) => over(`lock on ${l.via} say`, l.say, BREVITY.say));
  for (const d of story.dialogues) {
    if (d.lines.length > BREVITY.linesPerDialogue) issues.push(`dialogue with ${d.npc} has ${d.lines.length} lines, keep it to ${BREVITY.linesPerDialogue}`);
    for (const l of d.lines) {
      over(`${d.npc} line ${l.key}`, l.says, BREVITY.npcLine);
      l.choices.forEach((c, i) => over(`${d.npc} line ${l.key} choice ${i + 1}`, c.text, BREVITY.choice));
    }
  }
  story.endings.forEach((e) => over(`ending ${e.key} text`, e.text, BREVITY.ending));
  return issues;
}

const asks = (text: string) => /\?["'”’)]*\s*$/.test(text.trim());

/** Questions the player cannot answer: a "say" is not a conversation, and a line without choices ends one. */
export function questionIssues(story: Story): string[] {
  const issues: string[] = [];
  story.interactions.forEach((it, i) => {
    if (asks(it.say)) issues.push(`interaction ${i + 1} (${it.verb} ${it.thing}) say ends with a question the player cannot answer: "${it.say}". Make it a statement, or ask it in a dialogue line with choices`);
  });
  for (const d of story.dialogues) {
    for (const l of d.lines) {
      if (asks(l.says) && l.choices.length === 0) issues.push(`${d.npc} line ${l.key} asks "${l.says}" but has no choices, so the conversation ends on the question. Give it answers, or make it a statement`);
    }
  }
  return issues;
}
