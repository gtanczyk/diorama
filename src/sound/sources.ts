// Where sounds come from. The Meta Model API has no audio generation, so effects come from ElevenLabs
// and music from Meta's open-weights MusicGen run locally (or ElevenLabs music when Python is not set up).
// Every take is kept in the memo by a hash of its request, so a rerun never pays twice.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inputHash, type Memo } from '../meta/memo.ts';

const ELEVEN = 'https://api.elevenlabs.io/v1';

export function elevenKey(): string | undefined {
  return process.env.ELEVENLABS_API_KEY || process.env.ELEVEN_API_KEY;
}

async function elevenPost(route: string, body: unknown): Promise<Buffer> {
  const key = elevenKey();
  if (!key) throw new Error('no ElevenLabs key: set ELEVENLABS_API_KEY');
  for (let n = 1; ; n++) {
    const res = await fetch(ELEVEN + route, { method: 'POST', headers: { 'xi-api-key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    const text = (await res.text()).slice(0, 300);
    if (![429, 500, 502, 503].includes(res.status) || n === 4) throw new Error(`ElevenLabs ${route}: ${res.status} ${text}`);
    await new Promise((r) => setTimeout(r, 1000 * 2 ** n));
  }
}

export type EffectAsk = { label: string; prompt: string; seconds: number; loop: boolean; take?: number };

/** An effect or ambience from ElevenLabs text-to-sound, as mp3. `take` > 1 asks again for a different take. */
export function soundEffect(memo: Memo, ask: EffectAsk): Promise<Buffer> {
  const body = { text: ask.prompt, duration_seconds: ask.seconds, loop: ask.loop, prompt_influence: 0.45, model_id: 'eleven_text_to_sound_v2' };
  return memo.remember('sound', ask.label, inputHash('eleven-sfx', JSON.stringify(body), String(ask.take ?? 1)), 'mp3', () => elevenPost('/sound-generation', body));
}

/** Music from ElevenLabs, for when MusicGen is not available. */
export function elevenMusic(memo: Memo, label: string, prompt: string, seconds: number): Promise<Buffer> {
  const body = { prompt, music_length_ms: Math.round(seconds * 1000), model_id: 'music_v1', force_instrumental: true };
  return memo.remember('sound', label, inputHash('eleven-music', JSON.stringify(body)), 'mp3', () => elevenPost('/music', body));
}

const MUSICGEN_PY = fileURLToPath(new URL('./musicgen.py', import.meta.url));
export const MUSICGEN_MODEL = 'facebook/musicgen-small';

/** The Python that has torch and transformers: DIORAMA_PYTHON, or none. */
export function musicgenPython(): string | undefined {
  const py = process.env.DIORAMA_PYTHON;
  if (!py) return undefined;
  try {
    execFileSync(py, ['-c', 'import torch, transformers'], { stdio: 'ignore' });
    return py;
  } catch {
    return undefined;
  }
}

/** Music from Meta's MusicGen (open weights, runs on CPU in a few minutes), as wav. */
export function musicgen(memo: Memo, label: string, prompt: string, seconds: number, python: string): Promise<Buffer> {
  return memo.remember('music', label, inputHash(MUSICGEN_MODEL, prompt, String(seconds)), 'wav', async () => {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'musicgen-')), 'out.wav');
    execFileSync(python, ['-I', MUSICGEN_PY, MUSICGEN_MODEL, prompt, String(seconds), out], { stdio: ['ignore', 'inherit', 'inherit'] });
    return fs.readFileSync(out);
  });
}
