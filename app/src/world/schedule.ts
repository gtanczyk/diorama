// What each build step waits for. The build is not a line of steps but a web: every place goes through its own
// steps as fast as it can, and the world's steps (cast, voices, sound...) start as soon as what they read is there.
// Plain data, so the Studio can work out the time left from the same web the build runs.

export const STEPS = ['world', 'story', 'layout', 'paint', 'masks', 'plates', 'icons', 'derive', 'backdrop', 'weather', 'reactions', 'cast', 'model', 'sprites', 'sound', 'voices', 'faces', 'verify'] as const;
export type Step = (typeof STEPS)[number];
/** The steps that work place by place; `--place` runs only these, for that one place. */
export const PLACE_STEPS: readonly Step[] = ['layout', 'paint', 'masks', 'plates', 'derive', 'backdrop', 'weather', 'reactions', 'verify'];

/**
 * What a step reads, as steps. A place step needs the same place's step before it (PLACE_STEPS order) plus these;
 * a place step named in a world step's list means every place has finished it (or was set aside).
 * - layout and paint read world.json only: places are painted while Spark still writes the story.
 * - plates takes the story's carried-off things out of the painting.
 * - icons: an item is cut from the painting of the place it is picked up in, once that place has masks
 *   (the build runs it per place; items picked up nowhere are painted once the story is there).
 * - cast reads the looks in world.json, so the figures are painted alongside the places.
 * - model needs the story (who speaks, patrols or travels); sprites need that plan and every place's geometry.
 *   NPC stage flags/conditions travel with story.json; they need no separate build step.
 * - sound plans from every place's painting brief and floors; voices from the story's lines.
 */
export const NEEDS: Record<Step, readonly Step[]> = {
  world: [],
  story: ['world'],
  layout: ['world'],
  paint: [],
  masks: [],
  plates: ['story'],
  icons: ['story', 'masks'],
  derive: [],
  backdrop: [],
  weather: [],
  reactions: ['story'],
  cast: ['world'],
  model: ['story', 'cast'],
  sprites: ['model', 'derive'],
  sound: ['story', 'paint'],
  voices: ['story'],
  // Last: talking mouths are polish. They start once every place is verified, so they never hold up a playable game.
  faces: ['cast', 'sprites', 'voices', 'verify'],
  verify: [],
};

/** Every step `step` waits for: its own list, plus the place step before it. */
export function needs(step: Step): Step[] {
  const i = PLACE_STEPS.indexOf(step);
  return [...(i > 0 ? [PLACE_STEPS[i - 1]] : []), ...NEEDS[step]];
}

/**
 * Seconds until every step in `plan` is done, when each starts as soon as what it needs is: the longest chain,
 * not the sum. `left(step)` is what a step still takes (0 when done); steps outside the plan count as done.
 */
export function timeLeft(plan: readonly string[], left: (step: Step) => number): number {
  const end = new Map<Step, number>();
  const finish = (step: Step): number => {
    if (end.has(step)) return end.get(step)!;
    const after = Math.max(0, ...needs(step).filter((s) => plan.includes(s)).map(finish));
    const at = after + (plan.includes(step) ? left(step) : 0);
    end.set(step, at);
    return at;
  };
  return Math.max(0, ...STEPS.filter((s) => plan.includes(s)).map(finish));
}
