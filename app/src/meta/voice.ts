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
    // A busy server ("Audio processing backlog too large"), a dropped socket or a timeout passes: ask again, slower each time.
    for (let n = 1; ; n++) {
      try {
        return await listen(label, pcm24k, pace);
      } catch (error) {
        if (n === 5 || !/backlog|busy|overload|socket error|timed out|closed 10(06|11|13)/i.test(String(error))) throw error;
        await new Promise((r) => setTimeout(r, 2000 * 2 ** n));
      }
    }
  }).then((b) => b.toString('utf8'));
}

async function listen(label: string, pcm24k: Buffer, pace: number): Promise<Buffer> {
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
    // A client may only close with 1000 or 3000-4999; anything but 1000 is taken as a failure below.
    } else if (msg.type === 'error') ws.close(4000, String(msg.message).slice(0, 100));
  };
  ws.onopen = () => ws.send(JSON.stringify({
    authorization: { accessToken: `Bearer ${apiKey()}` },
    audioEncoding: 'PCM_24KHZ',
    model: VOICE_TRANSCRIBE,
    mode: 'PUSH_TO_TALK',
  }));
  return Buffer.from(await done, 'utf8');
}
