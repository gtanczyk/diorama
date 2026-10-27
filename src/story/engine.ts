// The story rules as pure functions over a plain state. The browser runtime plays with them,
// and the checker walks every state with them, so what the checker proves is what the player gets.
import type { World } from '../world/schema.ts';
import type { Effect, Story } from './schema.ts';

export type State = {
  place: string;
  flags: string[];
  items: string[];
  /** Indexes of `once` interactions already fired. */
  spent: number[];
  talk?: { dialogue: number; line: string };
  ending?: string;
};

export type Action =
  | { kind: 'go'; via: string }
  | { kind: 'do'; thing: string; verb: string; with?: string }
  | { kind: 'talk'; npc: string }
  | { kind: 'choose'; index: number }
  | { kind: 'leave' };

export type Step = { state: State; say: string[] };

/** Who says an interaction's line: a person talked to answers in their own voice; everything else is the hero's remark. */
export function speakerOf(world: World, it: { place: string; thing: string; verb: string }): string {
  const npc = it.verb === 'talk' && world.places.find((p) => p.key === it.place)?.things.some((t) => t.key === it.thing && t.role === 'npc');
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
export function pickInteraction(story: Story, state: State, a: { thing: string; verb: string; with?: string }): number {
  return story.interactions.findIndex((it, i) =>
    it.place === state.place && it.thing === a.thing && it.verb === a.verb && it.with === a.with
    && !state.spent.includes(i) && holds(state, it.when));
}

export function pickDialogue(story: Story, state: State, npc: string): number {
  return story.dialogues.findIndex((d) => d.place === state.place && d.npc === npc && holds(state, d.when));
}

export function lockOn(story: Story, state: State, via: string) {
  return story.locks.find((l) => l.place === state.place && l.via === via && !holds(state, l.until));
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
  for (const exit of place.exits) if (!lockOn(story, state, exit.via)) out.push({ kind: 'go', via: exit.via });
  const seen = new Set<string>();
  for (const it of story.interactions) {
    const id = `${it.thing}|${it.verb}|${it.with ?? ''}`;
    if (it.place !== state.place || seen.has(id)) continue;
    if (it.with && !state.items.includes(it.with)) continue;
    const a = { kind: 'do' as const, thing: it.thing, verb: it.verb, ...(it.with ? { with: it.with } : {}) };
    if (pickInteraction(story, state, a) >= 0) { seen.add(id); out.push(a); }
  }
  for (const d of story.dialogues) {
    if (d.place === state.place && !out.some((a) => a.kind === 'talk' && a.npc === d.npc) && pickDialogue(story, state, d.npc) >= 0) {
      out.push({ kind: 'talk', npc: d.npc });
    }
  }
  return out;
}

export function apply(world: World, story: Story, state: State, action: Action): Step {
  const next: State = { ...state, flags: [...state.flags], items: [...state.items], spent: [...state.spent] };
  const say: string[] = [];
  switch (action.kind) {
    case 'go': {
      const lock = lockOn(story, state, action.via);
      if (lock) return { state, say: [lock.say] };
      const exit = world.places.find((p) => p.key === state.place)?.exits.find((e) => e.via === action.via);
      if (!exit) throw new Error(`no exit "${action.via}" in ${state.place}`);
      next.place = exit.to;
      break;
    }
    case 'do': {
      const i = pickInteraction(story, state, action);
      if (i < 0) return { state, say: [] };
      const it = story.interactions[i];
      say.push(it.say);
      if (it.once) next.spent.push(i);
      run(next, it.do);
      break;
    }
    case 'talk': {
      const d = pickDialogue(story, state, action.npc);
      if (d < 0) return { state, say: [] };
      next.talk = { dialogue: d, line: story.dialogues[d].start };
      say.push(lineOf(story, next)!.says);
      break;
    }
    case 'choose': {
      const choice = lineOf(story, state)?.choices[action.index];
      if (!choice || !holds(state, choice.when)) return { state, say: [] };
      say.push(choice.text);
      run(next, choice.do);
      next.talk = choice.next && !next.ending ? { dialogue: state.talk!.dialogue, line: choice.next } : undefined;
      if (next.talk) say.push(lineOf(story, next)!.says);
      break;
    }
    case 'leave':
      next.talk = undefined;
      break;
  }
  next.flags.sort();
  next.items.sort();
  next.spent.sort((a, b) => a - b);
  if (!next.talk) delete next.talk;
  return { state: next, say };
}

function lineOf(story: Story, state: State) {
  if (!state.talk) return undefined;
  return story.dialogues[state.talk.dialogue].lines.find((l) => l.key === state.talk!.line);
}

function run(state: State, effects: Effect[]) {
  for (const e of effects) {
    if ('set' in e && !state.flags.includes(e.set)) state.flags.push(e.set);
    if ('clear' in e) state.flags = state.flags.filter((f) => f !== e.clear);
    if ('give' in e && !state.items.includes(e.give)) state.items.push(e.give);
    if ('take' in e) state.items = state.items.filter((i) => i !== e.take);
    if ('go' in e) state.place = e.go;
    if ('ending' in e) state.ending = e.ending;
  }
}

export function stateKey(state: State): string {
  return JSON.stringify(state);
}

export function describe(action: Action): string {
  switch (action.kind) {
    case 'go': return `go ${action.via}`;
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
