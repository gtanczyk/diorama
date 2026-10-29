/** World language names and voice-library language labels use different formats. */
export function languageKey(language = 'English'): string {
  const name = language.trim().toLowerCase();
  const names: Record<string, string> = {
    polish: 'pl', polski: 'pl', english: 'en', german: 'de', deutsch: 'de', french: 'fr', français: 'fr',
    spanish: 'es', español: 'es', italian: 'it', portuguese: 'pt', dutch: 'nl', ukrainian: 'uk',
    russian: 'ru', czech: 'cs', slovak: 'sk', swedish: 'sv', norwegian: 'no', danish: 'da', finnish: 'fi',
    japanese: 'ja', korean: 'ko', chinese: 'zh', arabic: 'ar', hindi: 'hi', turkish: 'tr',
  };
  return names[name] ?? (/^[a-z]{2}(-[a-z]{2})?$/.test(name) ? name.slice(0, 2) : name);
}
