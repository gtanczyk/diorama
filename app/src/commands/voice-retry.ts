import { defineCommand } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { soundQuality } from '../sound/cost.ts';
import { retryVoiceLine } from '../sound/retry.ts';

defineCommand({
  name: 'voice-retry',
  usage: 'voice-retry <slug> <speaker> "<exact text>"  retry one line without changing its voice or other recordings',
  async run([slug, speaker, text]) {
    if (!slug || !speaker || !text) throw new Error('usage: voice-retry <slug> <speaker> "<exact text>"');
    process.env.DIORAMA_SOUND = soundQuality();
    await retryVoiceLine(new WorldFiles(slug), speaker, text);
  },
});
