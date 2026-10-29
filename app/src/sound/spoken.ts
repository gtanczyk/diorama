// What a line sounds like read aloud: "10+10=20" on screen is "dziesięć plus dziesięć równa się dwadzieścia" spoken.
// The voice actor reads the spoken form, and the transcript is checked against it, so a line with digits and signs
// is neither left to the actor's guess nor failed because the transcriber wrote words where the line has digits.
import { languageKey } from './language.ts';

type Words = { number: (n: number) => string; ops: Record<string, string> };

const PL_UNITS = ['zero', 'jeden', 'dwa', 'trzy', 'cztery', 'pięć', 'sześć', 'siedem', 'osiem', 'dziewięć'];
const PL_TEENS = ['dziesięć', 'jedenaście', 'dwanaście', 'trzynaście', 'czternaście', 'piętnaście', 'szesnaście', 'siedemnaście', 'osiemnaście', 'dziewiętnaście'];
const PL_TENS = ['', '', 'dwadzieścia', 'trzydzieści', 'czterdzieści', 'pięćdziesiąt', 'sześćdziesiąt', 'siedemdziesiąt', 'osiemdziesiąt', 'dziewięćdziesiąt'];
const PL_HUNDREDS = ['', 'sto', 'dwieście', 'trzysta', 'czterysta', 'pięćset', 'sześćset', 'siedemset', 'osiemset', 'dziewięćset'];

function plBelow1000(n: number): string[] {
  const h = Math.floor(n / 100), r = n % 100, t = Math.floor(r / 10), u = r % 10;
  return [PL_HUNDREDS[h], r >= 10 && r < 20 ? PL_TEENS[r - 10] : PL_TENS[t], r >= 10 && r < 20 ? '' : u ? PL_UNITS[u] : ''].filter(Boolean);
}

function plNumber(n: number): string {
  if (n === 0) return PL_UNITS[0];
  const thousands = Math.floor(n / 1000), rest = n % 1000;
  const k = thousands === 0 ? [] : thousands === 1 ? ['tysiąc']
    : [...plBelow1000(thousands), [2, 3, 4].includes(thousands % 10) && ![12, 13, 14].includes(thousands % 100) ? 'tysiące' : 'tysięcy'];
  return [...k, ...plBelow1000(rest)].join(' ');
}

const EN_UNITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

function enBelow1000(n: number): string[] {
  const h = Math.floor(n / 100), r = n % 100;
  const tail = r === 0 ? [] : r < 20 ? [EN_UNITS[r]] : [EN_TENS[Math.floor(r / 10)] + (r % 10 ? `-${EN_UNITS[r % 10]}` : '')];
  return [...(h ? [EN_UNITS[h], 'hundred'] : []), ...tail];
}

function enNumber(n: number): string {
  if (n === 0) return 'zero';
  const thousands = Math.floor(n / 1000), rest = n % 1000;
  return [...(thousands ? [...enBelow1000(thousands), 'thousand'] : []), ...enBelow1000(rest)].join(' ');
}

const LANGUAGES: Record<string, Words> = {
  pl: { number: plNumber, ops: { '+': 'plus', '-': 'minus', '−': 'minus', '×': 'razy', '*': 'razy', '÷': 'podzielić przez', '=': 'równa się' } },
  en: { number: enNumber, ops: { '+': 'plus', '-': 'minus', '−': 'minus', '×': 'times', '*': 'times', '÷': 'divided by', '=': 'equals' } },
};

/** Whole numbers up to 999 999 read as words; others (a year said its own way, decimals) are left to the actor. */
const NUMBER = /(?<![\d.,:])\d{1,6}(?![\d]|[.,:]\d)/g;

/** The line as it is said: whole numbers as words, and a sign between two numbers ("10+10", "3 × 4 = 12") as its word. */
export function spokenText(text: string, language?: string): string {
  const words = LANGUAGES[languageKey(language)];
  if (!words) return text;
  const signs = Object.keys(words.ops).map((s) => s.replace(/[-*+]/g, '\\$&')).join('');
  // Only between numbers: a dash between words is punctuation, not "minus".
  const between = new RegExp(`(\\d)\\s*([${signs}])\\s*(?=\\d)`, 'g');
  // "22 000" is one number: a space (or a no-break one) between thousands goes first.
  let out = text.replace(/(?<![\d.,])(\d{1,3})[ \u00a0](\d{3})(?![\d])/g, '$1$2');
  for (let i = 0; i < 2; i++) out = out.replace(between, (_, a: string, op: string) => `${a} ${words.ops[op]} `);
  return out.replace(NUMBER, (d) => words.number(Number(d))).replace(/\s+/g, ' ');
}

/** The number words of a language, in the order said: "dziesięć plus dziesięć równa się dwadzieścia" has dziesięć, dziesięć, dwadzieścia. */
export function numberWords(spoken: string, language?: string): string[] {
  const words = LANGUAGES[languageKey(language)];
  if (!words) return [];
  const vocabulary = new Set(language && languageKey(language) === 'pl'
    ? [...PL_UNITS, ...PL_TEENS, ...PL_TENS, ...PL_HUNDREDS, 'tysiąc', 'tysiące', 'tysięcy'].filter(Boolean)
    : [...EN_UNITS, ...EN_TENS, 'hundred', 'thousand'].filter(Boolean));
  return spoken.normalize('NFC').toLowerCase().split(/[^\p{L}]+/u).flatMap((w) => w.split('-')).filter((w) => vocabulary.has(w));
}
