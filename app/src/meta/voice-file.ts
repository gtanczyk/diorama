// Meta Model API's file route: https://dev.meta.ai/docs/api-reference/voice/transcribe
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { apiKey, META_API, MetaHttpError } from './http.ts';
import type { SpeechOptions, SttProvider, Transcript } from '../speech/types.ts';
const MODEL = 'muse-voice-transcribe-1.0';
const ResponseBody = z.object({ sessionId: z.string(), transcript: z.string(), audioDurationMs: z.number().nonnegative(), turns: z.array(z.object({ turnId: z.number(), startMs: z.number().nonnegative(), endMs: z.number().nonnegative(), transcript: z.string(), speaker: z.string().optional() })) });
/** RIFF/WAVE is required by the file API. No ffmpeg conversion or lossy encoding is needed for PCM. */
export function wav24k(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF'); h.writeUInt32LE(pcm.length + 36, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(24000, 24); h.writeUInt32LE(48000, 28);
  h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
async function fileTranscribe(pcm: Buffer, options: SpeechOptions): Promise<Transcript> {
  const seconds = pcm.length / 48000;
  // A clipped utterance can otherwise be returned with empty text. Silence lets the model finish the last turn.
  const padding = Math.min(1, 600 - seconds);
  const wav = wav24k(Buffer.concat([pcm, Buffer.alloc(Math.floor(padding * 48000))])), sessionId = randomUUID(), key = apiKey();
  const request = { model: MODEL, audioEncoding: 'WAV', mode: 'DIARIZATION', ...(options.languages?.length && { languageBias: options.languages }), ...(options.keywords?.length && { keywords: options.keywords }) };
  let serverErrors = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      const body = new FormData();
      body.set('request', new Blob([JSON.stringify(request)], { type: 'application/json' }));
      body.set('audio', new Blob([new Uint8Array(wav)], { type: 'audio/wav' }), 'speech.wav');
      const response = await fetch(`${META_API}/asr/transcribe?sessionId=${sessionId}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, body, signal: AbortSignal.timeout(240000) });
      if (!response.ok) throw new MetaHttpError(response.status, `Meta file STT: ${response.status} ${(await response.text()).slice(0, 300)}`);
      const got = ResponseBody.parse(await response.json());
      if (got.turns.some(t => t.endMs < t.startMs || t.endMs > (seconds + padding + .5) * 1000)) throw new z.ZodError([{ code: 'custom', path: ['turns'], message: 'STT timestamp lies outside its clip' }]);
      const turns = got.turns.filter(t => t.transcript.trim() && t.startMs < seconds * 1000);
      return { provider: 'meta', model: MODEL, text: got.transcript, timing: turns.length ? 'turn' : 'none', speakerScope: got.sessionId,
        segments: turns.map(t => ({ start: t.startMs / 1000, end: Math.min(seconds, t.endMs / 1000), text: t.transcript, ...(t.speaker && { speaker: t.speaker }) })) };
    } catch (error) {
      // Retry server-budget errors once, and bounded rate-limit/network errors with backoff.
      if (error instanceof z.ZodError || (error instanceof MetaHttpError && ![408, 429, 500, 502, 503, 504].includes(error.status))) throw error;
      if (error instanceof MetaHttpError && error.status >= 500 && ++serverErrors > 1) throw error;
      if (attempt >= 3) throw error;
      await new Promise(r => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
export const metaFileStt: SttProvider = { id: 'meta', model: MODEL, capabilities: { timing: 'turn', speakers: true, maxSeconds: 600 }, transcribe: fileTranscribe };
