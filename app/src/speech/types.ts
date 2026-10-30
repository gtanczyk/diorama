import { z } from 'zod';
export const Transcript = z.object({
  text: z.string(),
  provider: z.string(), model: z.string(),
  timing: z.enum(['none', 'turn', 'word']),
  // Speaker labels are scoped to this response, never identities across clips.
  speakerScope: z.string().optional(),
  segments: z.array(z.object({ start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string(), speaker: z.string().optional() })),
});
export type Transcript = z.infer<typeof Transcript>;
export type SpeechOptions = { languages?: string[]; keywords?: string[] };
/** File adapters accept mono signed 16-bit PCM at 24 kHz; times in their result are seconds within this clip. */
export interface SttProvider {
  id: string;
  model: string;
  capabilities: { timing: Transcript['timing']; speakers: boolean; maxSeconds: number };
  transcribe(pcm: Buffer, options: SpeechOptions): Promise<Transcript>;
}
