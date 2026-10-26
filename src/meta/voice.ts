// Muse Voice Transcribe: what a recording says, over the realtime ASR socket (the API has no batch route).
import { apiKey } from './http.ts';
import { inputHash, type Memo } from './memo.ts';

export const VOICE_TRANSCRIBE = 'muse-voice-transcribe-1.0';
const URL_ASR = 'wss://api.meta.ai/v1/asr/realtime';
/** 80 ms of 16-bit mono PCM at 24 kHz. */
const FRAME = 3840;

/** `pcm24k`: 16-bit little-endian mono PCM at 24 kHz. Sent a few times faster than real time. */
export function transcribe(memo: Memo, label: string, pcm24k: Buffer, pace = 4): Promise<string> {
  return memo.remember('voice', label, inputHash(VOICE_TRANSCRIBE, pcm24k), 'txt', async () => {
    const ws = new WebSocket(URL_ASR);
    ws.binaryType = 'arraybuffer';
    const finals: string[] = [];
    let partial = '';
    const done = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => (ws.close(), reject(new Error(`transcribe ${label}: timed out`))), 60000);
      ws.onerror = () => reject(new Error(`transcribe ${label}: socket error`));
      ws.onclose = (e) => {
        clearTimeout(timer);
        if (e.code === 1000) resolve([...finals, partial].join(' ').replace(/\s+/g, ' ').trim());
        else reject(new Error(`transcribe ${label}: closed ${e.code} ${e.reason}`));
      };
    });
    let opened = false;
    ws.onmessage = async (e) => {
      const msg = JSON.parse(String(e.data)) as { type?: string; sessionId?: string; transcript?: string; final?: boolean; message?: string };
      if (!msg.type && msg.sessionId && !opened) {
        opened = true;
        // A second of silence after the line lets the endpointing close the last word.
        const audio = Buffer.concat([pcm24k, Buffer.alloc(FRAME * 12)]);
        for (let at = 0; at < audio.length; at += FRAME) {
          ws.send(audio.subarray(at, at + FRAME));
          await new Promise((r) => setTimeout(r, 80 / pace));
        }
        ws.send(JSON.stringify({ type: 'endStream' }));
      } else if (msg.type === 'transcript' && msg.transcript !== undefined) {
        if (msg.final) {
          finals.push(msg.transcript);
          partial = '';
        } else partial = msg.transcript;
      } else if (msg.type === 'error') ws.close(1000 + 8, String(msg.message).slice(0, 100));
    };
    ws.onopen = () => ws.send(JSON.stringify({
      authorization: { accessToken: `Bearer ${apiKey()}` },
      audioEncoding: 'PCM_24KHZ',
      model: VOICE_TRANSCRIBE,
      mode: 'PUSH_TO_TALK',
    }));
    return Buffer.from(await done, 'utf8');
  }).then((b) => b.toString('utf8'));
}
