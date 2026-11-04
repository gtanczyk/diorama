// Small provider boundary: the video pipeline only knows PCM in, normalized evidence out.
import { metaFileStt } from '../meta/voice-file.ts';
import { inputHash, MUSE_VOICE, type Memo } from '../meta/memo.ts';
import { Transcript, type SpeechOptions, type SttProvider } from './types.ts';
export { type SttProvider, type SpeechOptions, Transcript } from './types.ts';
export const defaultStt = metaFileStt;
const inFlight = new Map<string, Promise<Transcript>>();
const lanes = new Map<string, Promise<unknown>>();
export async function transcribeFile(memo: Memo, label: string, pcm: Buffer, options: SpeechOptions = {}, provider: SttProvider = defaultStt): Promise<Transcript> {
  const seconds = pcm.length / 48000;
  if (!pcm.length || pcm.length % 2 || seconds > provider.capabilities.maxSeconds) throw new Error(`Invalid PCM or clip exceeds ${provider.id}'s ${provider.capabilities.maxSeconds}s limit`);
  const check = (raw: unknown) => {
    const result = Transcript.parse(raw);
    if (result.provider !== provider.id || result.model !== provider.model) throw new Error('STT provider/model mismatch');
    const level = { none: 0, turn: 1, word: 2 };
    if (level[result.timing] > level[provider.capabilities.timing]) throw new Error('STT claims unsupported timestamp precision');
    if (result.segments.some(s => s.speaker) && (!provider.capabilities.speakers || !result.speakerScope)) throw new Error('STT speaker labels need supported, session-scoped attribution');
    if (result.timing === 'none' && result.segments.length) throw new Error('Untimed STT must not invent segment timestamps');
    if (result.segments.some(s => s.end < s.start || s.end > seconds + .5)) throw new Error('STT timestamp lies outside its clip');
    if (result.timing !== 'none' && result.text.trim() && !result.segments.length) throw new Error('STT claims timestamps without segments');
    return result;
  };
  const hash = inputHash('file-stt-v1', provider.id, provider.model, JSON.stringify(options), pcm);
  const key = `${memo.dir}:${hash}`;
  if (inFlight.has(key)) return inFlight.get(key)!;
  const lane = `${provider.id}:${provider.model}`;
  const run = async () => {
    const saved = await memo.remember('voice', label, hash, 'json', async () => {
      const request = (lanes.get(lane) ?? Promise.resolve()).catch(() => {}).then(() => provider.transcribe(pcm, options));
      lanes.set(lane, request);
      try { return { data: Buffer.from(JSON.stringify(check(await request))), via: MUSE_VOICE }; }
      finally { if (lanes.get(lane) === request) lanes.delete(lane); }
    });
    return check(JSON.parse(saved.toString('utf8')));
  };
  const pending = run(); inFlight.set(key, pending);
  try { return await pending; } finally { inFlight.delete(key); }
}
