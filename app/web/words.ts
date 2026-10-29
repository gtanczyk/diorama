// The few words the game says itself, in the language the world is written in (world.json language).
const WORDS = {
  English: { useOn: (a: string, b: string) => `Use ${a} on ${b}`, nope: (a: string) => `The ${a} won't help here.`, goodbye: 'Goodbye.', end: 'The end', again: 'Play again', player: 'Player', padHint: 'gamepad: stick or d-pad walks · A uses · B puts back or looks · X Y or shoulders pick an item · in a talk up/down and A answer, B says goodbye', leave: 'Esc or walk away to say goodbye', padLeave: 'B says goodbye', tapLeave: 'Tap away to say goodbye', sound: 'Click once for sound' },
  Polish: { useOn: (a: string, b: string) => `Użyj: ${a} → ${b}`, nope: (a: string) => `${a[0].toUpperCase()}${a.slice(1)} tu nie pomoże.`, goodbye: 'Do widzenia.', end: 'Koniec', again: 'Zagraj jeszcze raz', player: 'Gracz', padHint: 'pad: gałka lub krzyżak chodzi · A używa · B odkłada lub ogląda · X Y lub boczne wybierają przedmiot · w rozmowie góra/dół i A, B żegna', leave: 'Esc albo odejdź, żeby się pożegnać', padLeave: 'B żegna', tapLeave: 'Stuknij obok, żeby się pożegnać', sound: 'Kliknij raz, żeby włączyć dźwięk' },
};

export let words = WORDS.English;

export function useLanguage(language?: string) {
  words = WORDS[language as keyof typeof WORDS] ?? WORDS.English;
}
