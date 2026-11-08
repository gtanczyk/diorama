// The few words the game says itself, in the language the world is written in (world.json language).
import { goodbye } from '../src/story/phrases.ts';
const WORDS = {
  English: { useOn: (a: string, b: string) => `Use ${a} on ${b}`, nope: (a: string) => `The ${a} won't help here.`, goodbye: goodbye('English'), end: 'The end', again: 'Play again', credits: 'Credits', player: 'Player', padHint: 'gamepad: stick or d-pad walks · A uses · B puts back or looks · X Y or shoulders pick an item · in a talk up/down and A answer, B says goodbye', leave: '↑↓ and Enter answer · Esc or a click away says goodbye', padLeave: 'B says goodbye', tapLeave: 'Tap away to say goodbye', sound: 'Click once for sound', hintWith: (a: string) => `Maybe my ${a[0].toLowerCase()}${a.slice(1)} can help over there.`, hint: 'Maybe something over there can help.' },
  Polish: { useOn: (a: string, b: string) => `Użyj: ${a} → ${b}`, nope: (a: string) => `${a[0].toUpperCase()}${a.slice(1)} tu nie pomoże.`, goodbye: goodbye('Polish'), end: 'Koniec', again: 'Zagraj jeszcze raz', credits: 'Twórcy', player: 'Gracz', padHint: 'pad: gałka lub krzyżak chodzi · A używa · B odkłada lub ogląda · X Y lub boczne wybierają przedmiot · w rozmowie góra/dół i A, B żegna', leave: '↑↓ i Enter odpowiadają · Esc albo klik obok żegna', padLeave: 'B żegna', tapLeave: 'Stuknij obok, żeby się pożegnać', sound: 'Kliknij raz, żeby włączyć dźwięk', hintWith: (a: string) => `Może ${a.toLowerCase()} przyda się tam?`, hint: 'Może tam coś pomoże?' },
};

export let words = WORDS.English;

export function useLanguage(language?: string) {
  words = WORDS[language as keyof typeof WORDS] ?? WORDS.English;
}
