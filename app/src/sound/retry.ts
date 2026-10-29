import type { WorldFiles } from '../world/files.ts';
import { Story } from '../story/schema.ts';
import { creditGuard } from './cost.ts';
import { elevenKey } from './sources.ts';
import { DesignedVoices, freeVoiceSlot, PENDING_DESIGN, storyLines, voiceLine, Voices } from './voices.ts';

/** Resolve at queue time and again when the job starts, so removed dialogue cannot be regenerated. */
export function voiceRetryTarget(files: WorldFiles, speaker: string, text: string) {
  const saved = files.readJson(files.path('voices.json')) as Voices;
  const old = Voices.parse(saved);
  const line = storyLines(files.world(), Story.parse(files.readJson(files.path('story.json'))), true).find((l) => l.speaker === speaker && l.text === text);
  if (!line) throw new Error('this speaker no longer says that line');
  const voice = old.cast[speaker];
  if (!voice || voice.voice === PENDING_DESIGN) throw new Error('the voice is not ready; run voices to finish voice design first');
  return { old, saved, line, voice };
}

/** Retry only this line, preserving the cast, every other recording and every other failure. */
export async function retryVoiceLine(files: WorldFiles, speaker: string, text: string) {
  const { old, saved, line, voice } = voiceRetryTarget(files, speaker, text);
  if (!elevenKey()) throw new Error('no ELEVENLABS_API_KEY');
  const guard = await creditGuard(elevenKey(), 'voice retry');
  if (voice.design && !(await freeVoiceSlot())) throw new Error('No free ElevenLabs voice slot; free one and retry. The selected voice is unchanged.');
  const same = (l: { speaker: string; text: string }) => l.speaker === speaker && l.text === text;
  const failed = old.failures.find(same);
  const designed = new DesignedVoices(`diorama ${files.slug}`);
  try {
    const result = await voiceLine(files.memo, line, voice, (id, mp3) => {
      const file = `sound/voice/${id}.mp3`;
      files.write(files.path(file), mp3);
      return file;
    }, designed, { retryRejected: failed?.reason.startsWith('speech rejected') });
    files.write(files.path('voices.json'), { ...saved, lines: [...saved.lines.filter((l) => !same(l)), result], failures: old.failures.filter((l) => !same(l)) });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    // Do not discard a previous recording if a requested replacement fails.
    files.write(files.path('voices.json'), { ...saved, failures: [...old.failures.filter((l) => !same(l)), { speaker, text, reason }] });
    throw error;
  } finally { if (voice.design) await designed.close(); }
  console.log(`voice retry ${speaker}: ${text} · ${await guard.report()}`);
}
