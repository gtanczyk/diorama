// The few words the game says itself, in the language the world is written in (world.json language).
const WORDS = {
  English: { useOn: (a: string, b: string) => `Use ${a} on ${b}`, nope: (a: string) => `The ${a} won't help here.`, goodbye: 'Goodbye.', end: 'The end', again: 'Play again', player: 'Player' },
  Polish: { useOn: (a: string, b: string) => `Użyj: ${a} → ${b}`, nope: (a: string) => `${a[0].toUpperCase()}${a.slice(1)} tu nie pomoże.`, goodbye: 'Do widzenia.', end: 'Koniec', again: 'Zagraj jeszcze raz', player: 'Gracz' },
};

export let words = WORDS.English;

export function useLanguage(language?: string) {
  words = WORDS[language as keyof typeof WORDS] ?? WORDS.English;
}
