// Audio as plain samples: ffmpeg decodes and encodes, everything else (loop checks, seams, slicing steps) is code.
import { execFileSync } from 'node:child_process';

export const RATE = 44100;

/** Interleaved stereo float samples at RATE. */
export type Pcm = { left: Float32Array; right: Float32Array };

function ffmpeg(args: string[], input: Buffer): Buffer {
  try {
    return execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { input, maxBuffer: 1 << 30 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Error('the sound step needs ffmpeg on PATH (brew install ffmpeg / apt install ffmpeg)');
    throw error;
  }
}

export function decode(audio: Buffer): Pcm {
  const raw = ffmpeg(['-i', 'pipe:0', '-f', 'f32le', '-ac', '2', '-ar', String(RATE), 'pipe:1'], audio);
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const n = all.length / 2;
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) (left[i] = all[2 * i]), (right[i] = all[2 * i + 1]);
  return { left, right };
}

export function encodeMp3(pcm: Pcm, kbps = 128): Buffer {
  const n = pcm.left.length;
  const all = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) (all[2 * i] = pcm.left[i]), (all[2 * i + 1] = pcm.right[i]);
  return ffmpeg(['-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-i', 'pipe:0', '-c:a', 'libmp3lame', '-b:a', `${kbps}k`, '-f', 'mp3', 'pipe:1'], Buffer.from(all.buffer));
}

export const seconds = (pcm: Pcm) => pcm.left.length / RATE;

/** RMS per window of `ms`, both channels. */
export function envelope(pcm: Pcm, ms: number): number[] {
  const w = Math.max(1, Math.round((RATE * ms) / 1000));
  const out: number[] = [];
  for (let at = 0; at + w <= pcm.left.length; at += w) {
    let sum = 0;
    for (let i = at; i < at + w; i++) sum += pcm.left[i] ** 2 + pcm.right[i] ** 2;
    out.push(Math.sqrt(sum / (2 * w)));
  }
  return out;
}

const quantile = (values: number[], q: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
};

/**
 * Whether a take meant to loop is really one event (a crash, a single gust) with silence around it.
 * A loop needs sound all the way through: its quiet windows stay near its loud ones, and neither end dies out.
 */
export function loopProblem(pcm: Pcm): string | undefined {
  const env = envelope(pcm, 100);
  if (env.length < 10) return 'shorter than a second';
  const median = quantile(env, 0.5);
  if (Math.max(...env) < 0.003) return 'nearly silent';
  // Most of the take far under its loudest moments: an event in silence, not a bed.
  const steady = median / quantile(env, 0.98);
  if (steady < 0.06) return `one event and silence, not a bed (median/peak ${steady.toFixed(2)})`;
  const ends = Math.max(3, Math.round(env.length * 0.1));
  const head = env.slice(0, ends).reduce((a, b) => a + b, 0) / ends;
  const tail = env.slice(-ends).reduce((a, b) => a + b, 0) / ends;
  if (tail < median * 0.25) return `dies out at the end (${(tail / median).toFixed(2)} of its median)`;
  if (head < median * 0.25) return `fades in from silence (${(head / median).toFixed(2)} of its median)`;
  return undefined;
}

/** Folds the last `fade` seconds over the start with an equal-power crossfade, so the take repeats without a seam. */
export function seamless(pcm: Pcm, fade = 1): Pcm {
  const f = Math.min(Math.round(fade * RATE), Math.floor(pcm.left.length / 3));
  const len = pcm.left.length - f;
  const fold = (ch: Float32Array) => {
    const out = new Float32Array(len);
    out.set(ch.subarray(0, len));
    // The tail [len, len+f) fades out over the head [0, f): playing out[len-1] then out[0] continues the original.
    for (let i = 0; i < f; i++) {
      const t = (i + 0.5) / f;
      out[i] = ch[i] * Math.sin((t * Math.PI) / 2) + ch[len + i] * Math.cos((t * Math.PI) / 2);
    }
    return out;
  };
  return { left: fold(pcm.left), right: fold(pcm.right) };
}

/** Scales to a target RMS (dBFS) and keeps peaks under -1 dBFS, so every sound starts at a known level. */
export function normalise(pcm: Pcm, targetDb: number): Pcm {
  const env = envelope(pcm, 50).filter((v) => v > 1e-4);
  const rms = env.length ? Math.sqrt(env.reduce((a, b) => a + b * b, 0) / env.length) : 0;
  if (!rms) return pcm;
  let peak = 0;
  for (let i = 0; i < pcm.left.length; i++) peak = Math.max(peak, Math.abs(pcm.left[i]), Math.abs(pcm.right[i]));
  const gain = Math.min(10 ** (targetDb / 20) / rms, 0.89 / peak);
  return { left: pcm.left.map((v) => v * gain), right: pcm.right.map((v) => v * gain) };
}

/** Trims silence from both ends, leaving a few ms. */
export function trim(pcm: Pcm, floor = 0.01): Pcm {
  const env = envelope(pcm, 5);
  const max = Math.max(...env, 1e-9);
  const first = env.findIndex((v) => v > max * floor);
  const last = env.length - 1 - [...env].reverse().findIndex((v) => v > max * floor);
  const w = Math.round(RATE * 0.005);
  const from = Math.max(0, (first - 2) * w);
  const to = Math.min(pcm.left.length, (last + 3) * w);
  return { left: pcm.left.slice(from, to), right: pcm.right.slice(from, to) };
}

/**
 * Single footsteps in a take of several: onsets where the 10 ms envelope jumps above a share of its peak,
 * each cut until just before the next one (at most `max` seconds). Returns [start, duration] in seconds.
 */
export function steps(pcm: Pcm, max = 0.45): Array<[number, number]> {
  const ms = 10;
  const env = envelope(pcm, ms);
  const peak = Math.max(...env, 1e-9);
  const onsets: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < env.length; i++) {
    const rising = env[i] > peak * 0.25 && env[i] > env[i - 1] * 1.8;
    if (rising && i - last > 200 / ms) {
      onsets.push(i);
      last = i;
    }
  }
  return onsets.map((on, k) => {
    const start = Math.max(0, on - 2) * ms / 1000;
    const next = k + 1 < onsets.length ? (onsets[k + 1] - 3) * ms / 1000 : seconds(pcm);
    return [Math.round(start * 1000) / 1000, Math.round(Math.min(max, next - start) * 1000) / 1000] as [number, number];
  }).filter(([, d]) => d >= 0.12);
}
