// Muse Voice Transcribe realtime transport. File uploads use voice-file.ts through speech/transcribe.ts.
import { apiKey } from './http.ts';
import { inputHash, type Memo } from './memo.ts';

export const VOICE_TRANSCRIBE = 'muse-voice-transcribe-1.0';
const URL_ASR = 'wss://api.meta.ai/v1/asr/realtime';
/** 80 ms of 16-bit mono PCM at 24 kHz. */
const FRAME = 3840;

// One active ASR stream per process, including the retry cooldown. Voice Design and speech share it.
let queue: Promise<unknown> = Promise.resolve();
const transient = (error: unknown) => /backlog|busy|overload|socket error|timed out|closed 10(06|11|13)/i.test(String(error));

/** `pcm24k`: 16-bit mono PCM at 24 kHz. Never send faster than real time, even for legacy callers. */
export function transcribe(memo: Memo, label: string, pcm24k: Buffer, pace = 1): Promise<string> {
  return memo.remember('voice', label, inputHash(VOICE_TRANSCRIBE, pcm24k), 'txt', () => {
    const run = queue.then(async () => {
      let rate = Number.isFinite(pace) ? Math.max(0.25, Math.min(1, pace)) : 1;
      for (let attempt = 0; ; attempt++) {
        try { return await listen(label, pcm24k, rate); }
        catch (error) {
          if (!transient(error) || attempt === 3) throw error;
          // Retrying the same overloaded stream at the same speed only recreates the backlog.
          rate = Math.max(0.25, rate / 2);
          await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
        }
      }
    });
    queue = run.catch(() => {});
    return run;
  }).then((b) => b.toString('utf8'));
}

async function listen(label: string, pcm24k: Buffer, pace: number): Promise<Buffer> {
  const ws = new WebSocket(URL_ASR);
  ws.binaryType = 'arraybuffer';
  const finals: string[] = [];
  let partial = '';
  // Budget includes transmission at the current rate, then 30 seconds for the final transcript.
  const audio = Buffer.concat([pcm24k, Buffer.alloc(FRAME * 12)]);
  const done = new Promise<string>((resolve, reject) => {
    let stopped = false, opened = false, ended = false;
    let sendTimer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const wait = (ms: number) => new Promise<void>((r) => { wake = r; sendTimer = setTimeout(() => { wake = undefined; r(); }, ms); });
    const finish = (error?: Error) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer); clearTimeout(sendTimer); wake?.();
      if (error) reject(error);
      else resolve([...finals, partial].join(' ').replace(/\s+/g, ' ').trim());
      if (ws.readyState < 2) ws.close(1000);
    };
    const fail = (reason: string) => finish(new Error(`transcribe ${label}: ${reason}`));
    const timer = setTimeout(() => fail('timed out'), Math.max(60000, audio.length / 48000 / pace * 1000 + 30000));
    const sendAudio = async () => {
      for (let at = 0; at < audio.length; at += FRAME) {
        while (!stopped && ws.bufferedAmount > FRAME * 4) await wait(20);
        if (stopped || ws.readyState !== 1) return;
        const frame = audio.subarray(at, at + FRAME);
        ws.send(frame);
        if (stopped) return;
        await wait(frame.length / 48000 / pace * 1000);
      }
      if (!stopped && ws.readyState === 1) {
        ended = true;
        ws.send(JSON.stringify({ type: 'endStream' }));
      }
    };
    ws.onerror = () => fail('socket error');
    ws.onclose = (e) => {
      if (e.code === 1000 && ended) finish();
      else fail(`closed ${e.code} ${e.reason}${e.code === 1000 ? ' before endStream' : ''}`);
    };
    ws.onmessage = (e) => {
      if (stopped) return;
      try {
        const msg = JSON.parse(String(e.data)) as { type?: string; sessionId?: string; transcript?: string; final?: boolean; message?: string };
        if (!msg.type && msg.sessionId && !opened) {
          opened = true;
          void sendAudio().catch((error) => fail(`socket error: ${error}`));
        } else if (msg.type === 'transcript' && msg.transcript !== undefined) {
          if (msg.final) { finals.push(msg.transcript); partial = ''; }
          else partial = msg.transcript;
        } else if (msg.type === 'error') fail(String(msg.message).slice(0, 300));
      } catch { fail('invalid server message'); }
    };
    ws.onopen = () => {
      if (stopped) return;
      try {
        ws.send(JSON.stringify({ authorization: { accessToken: `Bearer ${apiKey()}` }, audioEncoding: 'PCM_24KHZ', model: VOICE_TRANSCRIBE, mode: 'PUSH_TO_TALK' }));
      } catch (error) { fail(String(error)); }
    };
  });
  return Buffer.from(await done, 'utf8');
}
