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
    if (it.with && !items.has(it.with)) issues.push(`${where}: unknown item "${it.with}"`);
    checkWhen(where, it.when);
  });
  for (const lock of story.locks) {
    thingIn(`lock on ${lock.via}`, lock.place, lock.via, 'exit');
    checkWhen(`lock on ${lock.via}`, lock.until);
  }
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
