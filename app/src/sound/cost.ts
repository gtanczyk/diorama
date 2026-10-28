// What sound costs. ElevenLabs bills every effect, line and design, so while a world is being developed the
// pipeline spends little: draft quality by default (cheaper speech model, shorter beds and loops, fewer takes,
// no ElevenLabs music), one cache for every world on this machine, and a stop when credits run out.
import os from 'node:os';
import path from 'node:path';

/** draft while developing; final (DIORAMA_SOUND=final or --final) for the film and a release. */
export type Quality = 'draft' | 'final';

export function soundQuality(args: string[] = []): Quality {
  if (args.includes('--final')) process.env.DIORAMA_SOUND = 'final';
  return process.env.DIORAMA_SOUND === 'final' ? 'final' : 'draft';
}

/** Speech: Flash v2.5 costs half of Multilingual v2 per character. */
export const FINAL_TTS = 'eleven_multilingual_v2';
export const ttsModel = () => (soundQuality() === 'final' ? FINAL_TTS : 'eleven_flash_v2_5');
/** Takes per line before it is flagged: each take is paid. */
export const lineTakes = () => (soundQuality() === 'final' ? 3 : 2);

/**
 * Sounds, speech and voice designs every world on this machine shares: the same request is never paid twice,
 * and generic sounds (footsteps per surface, clicks, pick-ups) are reused across worlds in draft quality.
 */
export function sharedDir(...parts: string[]): string {
  return path.join(process.env.DIORAMA_CACHE || path.join(os.homedir(), '.cache', 'diorama'), ...parts);
}

let outOf: string | undefined;

/** Called with every ElevenLabs refusal: an empty account stops all later calls at once instead of each failing. */
export function noteRefusal(status: number, body: string) {
  if (/quota_exceeded|insufficient_credits|credits remaining/i.test(body) || (status === 402)) outOf = 'ElevenLabs has no credits left (top up, or the world stays silent)';
}

export function checkCredits() {
  if (outOf) throw new Error(outOf);
}

export type Credits = { used: number; limit: number; left: number };

/** The account's credits, or undefined when the key cannot read them. */
export async function credits(key: string | undefined): Promise<Credits | undefined> {
  if (!key) return undefined;
  try {
    const res = await fetch('https://api.elevenlabs.io/v1/user/subscription', { headers: { 'xi-api-key': key } });
    if (!res.ok) return undefined;
    const s = (await res.json()) as { character_count: number; character_limit: number };
    return { used: s.character_count, limit: s.character_limit, left: s.character_limit - s.character_count };
  } catch {
    return undefined;
  }
}

/** Credits a step may still spend: DIORAMA_ELEVEN_FLOOR (default 2000) are always left for other work. */
export async function creditGuard(key: string | undefined, step: string): Promise<{ start?: Credits; report: () => Promise<string> }> {
  const start = await credits(key);
  const floor = Number(process.env.DIORAMA_ELEVEN_FLOOR ?? 2000);
  if (start && start.left <= floor) throw new Error(`${step}: ElevenLabs has ${start.left} credits left (floor ${floor}); top up or set DIORAMA_ELEVEN_FLOOR lower. The world plays silent until then.`);
  return {
    start,
    report: async () => {
      const end = start && (await credits(key));
      return start && end ? `credits: ${end.used - start.used} used, ${end.left} left (${soundQuality()} quality)` : `${soundQuality()} quality`;
    },
  };
}
