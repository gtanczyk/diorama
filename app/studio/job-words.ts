// Jobs and build steps in plain words, with place and character names instead of slugs and step ids.
const name = (key: string) => key.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
/** A build step as people say it. */
const STEP_WORDS: Record<string, string> = {
  world: 'writing the story', story: 'writing the story', layout: 'planning the places', paint: 'painting', masks: 'cutting out things',
  plates: 'painting changed things', icons: 'drawing the items', derive: 'measuring depth and walk', backdrop: 'painting the far view',
  weather: 'setting the weather', reactions: 'choosing scene reactions', cast: 'painting the cast', model: 'building 3D models', sprites: 'painting sprites',
  sound: 'making sounds', voices: 'giving voices', faces: 'animating speaking faces', verify: 'play testing',
};
export const stepWords = (s: string) => STEP_WORDS[s] ?? name(s).toLowerCase();
/** A job's label ("fix princess-castle from paint", "masks · tram-stop") in plain words with place names, no step ids. */
export function jobWords(label: string): string {
  let m: RegExpExecArray | null;
  if ((m = /^fix (\S+) from (\S+)/.exec(label))) return `repairing ${name(m[1])}, starting again at ${stepWords(m[2])}`;
  if (/^build\b/.test(label)) return 'building the world';
  if ((m = /^(\S+) · (\S+)$/.exec(label))) return `${stepWords(m[1])} in ${name(m[2])}`;
  if ((m = /^animate (\S+)/.exec(label))) return `moving ${name(m[1])} into 3D`;
  if ((m = /^cast (\S+)/.exec(label))) return `repainting ${name(m[1])}`;
  if ((m = /^voice (\S+)/.exec(label))) return `a new voice for ${name(m[1])}`;
  if ((m = /^icon (\S+)/.exec(label))) return `redrawing ${name(m[1]).toLowerCase()}`;
  if ((m = /^walk (\S+)/.exec(label))) return `the walk of ${name(m[1])}`;
  if ((m = /^(fog|water area|water|weather) (\S+?):?(?: |$)/.exec(label))) return `the ${m[1]} in ${name(m[2])}`;
  if (STEP_WORDS[label]) return STEP_WORDS[label];
  return label.replace(/\b[a-z0-9]+(?:-[a-z0-9]+)+\b/g, (k) => name(k));
}
