// The story rules as pure functions over a plain state. The browser runtime plays with them,
// and the checker walks every state with them, so what the checker proves is what the player gets.
import type { World } from '../world/schema.ts';
import type { Effect, Story } from './schema.ts';
import { goodbye } from './phrases.ts';

export type State = {
  place: string;
  flags: string[];
  items: string[];
  /** Indexes of `once` interactions already fired. */
  spent: number[];
  talk?: { dialogue: number; line: string };
  ending?: string;
  /** Only people relocated by the story: absence preserves their world.json placement. */
  npcs?: Record<string, string>;
};

export type Action =
  /** `to` picks among several places one thing leads to (a car that drives anywhere). */
  | { kind: 'go'; via: string; to?: string }
  | { kind: 'do'; thing: string; verb: string; with?: string }
  | { kind: 'talk'; npc: string }
  | { kind: 'choose'; index: number }
  | { kind: 'leave' };

export type Step = { state: State; say: string[]; issues?: string[] };

/** Who says an interaction's line: a person talked to answers in their own voice; everything else is the hero's remark. */
export function speakerOf(world: World, it: { place: string; thing: string; verb: string }): string {
  if (it.verb !== 'talk') return world.hero.key;
  const local = world.places.find((p) => p.key === it.place)?.things.find((t) => t.key === it.thing);
  const npc = local ? local.role === 'npc' : world.places.some((p) => p.things.some((t) => t.key === it.thing && t.role === 'npc'));
  return npc ? it.thing : world.hero.key;
}

export function startState(world: World): State {
  return { place: world.start, flags: [], items: [], spent: [] };
}

export function holds(state: State, when: readonly string[]): boolean {
  return when.every((fact) => {
    const negated = fact.startsWith('!');
    const body = negated ? fact.slice(1) : fact;
    const value = body.startsWith('has:') ? state.items.includes(body.slice(4))
      : body.startsWith('at:') ? state.place === body.slice(3)
      : state.flags.includes(body);
    return value !== negated;
  });
}

/** The interaction a click would fire right now, if any: the first one listed whose condition holds. */
export function npcHere(world: World, state: State, npc: string): boolean {
  return state.npcs?.[npc] ? state.npcs[npc] === state.place
    : !!world.places.find((p) => p.key === state.place)?.things.some((t) => t.key === npc && t.role === 'npc');
}

export function pickInteraction(story: Story, state: State, a: { thing: string; verb: string; with?: string }, world: World): number {
  const local = world.places.find((p) => p.key === state.place)?.things.find((t) => t.key === a.thing);
  if ((!local || local.role === 'npc') && world.places.some((p) => p.things.some((t) => t.key === a.thing && t.role === 'npc')) && !npcHere(world, state, a.thing)) return -1;
  return story.interactions.findIndex((it, i) =>
    it.place === state.place && it.thing === a.thing && it.verb === a.verb && it.with === a.with
    && !state.spent.includes(i) && holds(state, it.when));
}

export function pickDialogue(story: Story, state: State, npc: string, world: World): number {
  if (!npcHere(world, state, npc)) return -1;
  return story.dialogues.findIndex((d) => d.place === state.place && d.npc === npc && holds(state, d.when));
}

export function lockOn(story: Story, state: State, via: string) {
  return story.locks.find((l) => l.place === state.place && l.via === via && !holds(state, l.until));
}

/**
 * The next step toward facts the player still lacks (a lock's `until`): the first interaction that sets a missing
 * fact and can be done now, the item for it in the bag. A nudge for a stuck player; undefined when the way there
 * starts somewhere the player has not been yet (an item still to find).
 */
export function hintFor(story: Story, state: State, facts: readonly string[]): { place: string; thing: string; with?: string } | undefined {
  for (const fact of facts) {
    if (fact.startsWith('!') || holds(state, [fact])) continue;
    const it = story.interactions.find((i, k) => !state.spent.includes(k) && holds(state, i.when) && i.do.some((d) => 'set' in d && d.set === fact)
      && (!i.with || state.items.includes(i.with)));
    if (it) return { place: it.place, thing: it.thing, ...(it.with && { with: it.with }) };
  }
  return undefined;
}

/** Where an item in hand is wanted in this place now, when it was tried on the wrong thing. */
export function useFor(story: Story, state: State, item: string): string | undefined {
  return story.interactions.find((i, k) => i.place === state.place && i.with === item && !state.spent.includes(k) && holds(state, i.when))?.thing;
}

/** Everything that would change the state from here. Clicks that only print a refusal are left out. */
export function actions(world: World, story: Story, state: State): Action[] {
  if (state.ending) return [];
  if (state.talk) {
    const line = lineOf(story, state)!;
    const open = line.choices.flatMap((c, index) => (holds(state, c.when) ? [{ kind: 'choose' as const, index }] : []));
    return open.length ? open : [{ kind: 'leave' }];
  }
  const place = world.places.find((p) => p.key === state.place)!;
  const out: Action[] = [];
  for (const exit of place.exits) {
    if (lockOn(story, state, exit.via)) continue;
    const shared = place.exits.filter((e) => e.via === exit.via).length > 1;
    out.push({ kind: 'go', via: exit.via, ...(shared && { to: exit.to }) });
  }
  const seen = new Set<string>();
  for (const it of story.interactions) {
    const id = `${it.thing}|${it.verb}|${it.with ?? ''}`;
    if (it.place !== state.place || seen.has(id)) continue;
    if (it.with && !state.items.includes(it.with)) continue;
    const a = { kind: 'do' as const, thing: it.thing, verb: it.verb, ...(it.with ? { with: it.with } : {}) };
    if (pickInteraction(story, state, a, world) >= 0) { seen.add(id); out.push(a); }
  }
  for (const d of story.dialogues) {
    if (d.place === state.place && !out.some((a) => a.kind === 'talk' && a.npc === d.npc) && pickDialogue(story, state, d.npc, world) >= 0) {
      out.push({ kind: 'talk', npc: d.npc });
    }
  }
  return out;
}

export function apply(world: World, story: Story, state: State, action: Action): Step {
  const next: State = { ...state, flags: [...state.flags], items: [...state.items], spent: [...state.spent], ...(state.npcs && { npcs: { ...state.npcs } }) };
  const say: string[] = [];
  const issues: string[] = [];
  switch (action.kind) {
    case 'go': {
      const lock = lockOn(story, state, action.via);
      if (lock) return { state, say: [lock.say] };
      const exit = world.places.find((p) => p.key === state.place)?.exits.find((e) => e.via === action.via && (!action.to || e.to === action.to));
      if (!exit) throw new Error(`no exit "${action.via}" in ${state.place}`);
      next.place = exit.to;
      break;
    }
    case 'do': {
      const i = pickInteraction(story, state, action, world);
      if (i < 0) return { state, say: [] };
      const it = story.interactions[i];
      say.push(it.say);
      if (it.once) next.spent.push(i);
      issues.push(...run(world, next, it.do));
      break;
    }
    case 'talk': {
      const d = pickDialogue(story, state, action.npc, world);
      if (d < 0) return { state, say: [] };
      next.talk = { dialogue: d, line: story.dialogues[d].start };
      say.push(lineOf(story, next)!.says);
      break;
    }
    case 'choose': {
      const choice = lineOf(story, state)?.choices[action.index];
      if (!choice || !holds(state, choice.when)) return { state, say: [] };
      say.push(choice.text);
      issues.push(...run(world, next, choice.do));
      next.talk = choice.next && !next.ending ? { dialogue: state.talk!.dialogue, line: choice.next } : undefined;
      if (next.talk) say.push(lineOf(story, next)!.says);
      break;
    }
    case 'leave':
      if (state.talk) say.push(goodbye(world.language));
      next.talk = undefined;
      break;
  }
  next.flags.sort();
  next.items.sort();
  next.spent.sort((a, b) => a - b);
  if (!next.talk) delete next.talk;
  if (next.npcs) next.npcs = Object.fromEntries(Object.entries(next.npcs).sort(([a], [b]) => a.localeCompare(b)));
  return { state: next, say, ...(issues.length && { issues }) };
}

function lineOf(story: Story, state: State) {
  if (!state.talk) return undefined;
  return story.dialogues[state.talk.dialogue].lines.find((l) => l.key === state.talk!.line);
}

function run(world: World, state: State, effects: Effect[]) {
  const issues: string[] = [];
  for (const e of effects) {
    if ('set' in e && !state.flags.includes(e.set)) state.flags.push(e.set);
    if ('clear' in e) state.flags = state.flags.filter((f) => f !== e.clear);
    if ('give' in e && !state.items.includes(e.give)) state.items.push(e.give);
    if ('take' in e) state.items = state.items.filter((i) => i !== e.take);
    if ('go' in e) state.place = e.go;
    if ('ending' in e) state.ending = e.ending;
    if ('moveNpc' in e) {
      const { npc, to } = e.moveNpc;
      const from = state.npcs?.[npc] ?? world.places.find((p) => p.things.some((t) => t.key === npc && t.role === 'npc'))?.key;
      // A repeated action is harmless; an NPC cannot teleport across an unrelated place.
      if (from && from !== to && world.places.find((p) => p.key === from)?.exits.some((exit) => exit.to === to))
        state.npcs = { ...state.npcs, [npc]: to };
      else if (from !== to) issues.push(`NPC "${npc}" cannot move from "${from ?? 'unknown'}" to "${to}" without a connecting exit`);
    }
  }
  return issues;
}

export function stateKey(state: State): string {
  return JSON.stringify(state);
}

export function describe(action: Action): string {
  switch (action.kind) {
    case 'go': return `go ${action.via}${action.to ? ` to ${action.to}` : ''}`;
    case 'do': return `${action.verb} ${action.thing}${action.with ? ` with ${action.with}` : ''}`;
    case 'talk': return `talk ${action.npc}`;
    case 'choose': return `choose ${action.index + 1}`;
    case 'leave': return 'leave';
  }
}

/** Things the player can carry off: a once-only "take" that gives an item. Each one needs a clean plate under it. */
/**
 * A take carries the thing itself off only when it gives the item of the same key (the brief keys an item after its
 * thing). Taking a dried fish from the market stalls gives an item and leaves the stalls standing.
 */
export const carriesOff = (it: Story['interactions'][number]) => it.verb === 'take' && it.do.some((e) => 'give' in e && e.give === it.thing);

export function removableThings(story: Story): { place: string; thing: string }[] {
  const out = story.interactions.filter((it) => it.once && carriesOff(it));
  return [...new Map(out.map((it) => [`${it.place}|${it.thing}`, { place: it.place, thing: it.thing }])).values()];
}

/** Things already carried off in this state, to be painted over with their clean plate. */
export function hiddenThings(story: Story, state: State): { place: string; thing: string }[] {
  return state.spent.map((i) => story.interactions[i]).filter(carriesOff)
    .map((it) => ({ place: it.place, thing: it.thing }));
}

/** Indexes into story.changes whose condition holds in this state: the runtime draws their plates. */
export function activeChanges(story: Story, state: State): number[] {
  return story.changes.flatMap((c, i) => (holds(state, c.when) ? [i] : []));
}
