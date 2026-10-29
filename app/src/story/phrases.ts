/** Phrases supplied by the game rather than the story, shared by play and voice generation. */
export function goodbye(language?: string): string {
  return language === 'Polish' ? 'Do widzenia.' : 'Goodbye.';
}
