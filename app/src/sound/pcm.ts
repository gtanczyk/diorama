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

/**
 * Raises (or lowers) the pitch by `semitones` and keeps the length: a young adult voice read a few semitones up
 * sounds like a child, which no stock voice does.
 */
export function pitchShift(pcm: Pcm, semitones: number): Pcm {
  if (!semitones) return pcm;
  const r = 2 ** (semitones / 12);
  const n = pcm.left.length;
  const all = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) (all[2 * i] = pcm.left[i]), (all[2 * i + 1] = pcm.right[i]);
  const out = ffmpeg(['-f', 'f32le', '-ac', '2', '-ar', String(RATE), '-i', 'pipe:0', '-af', `asetrate=${Math.round(RATE * r)},aresample=${RATE},atempo=${(1 / r).toFixed(5)}`, '-f', 'f32le', '-ac', '2', '-ar', String(RATE), 'pipe:1'], Buffer.from(all.buffer));
  const f = new Float32Array(out.buffer, out.byteOffset, out.byteLength / 4);
  const m = f.length / 2;
  const left = new Float32Array(m);
  const right = new Float32Array(m);
  for (let i = 0; i < m; i++) (left[i] = f[2 * i]), (right[i] = f[2 * i + 1]);
  return { left, right };
}

export const seconds = (pcm: Pcm) => pcm.left.length / RATE;

/** Objective recording defects, before normalisation can disguise silence or clipping. */
export function audioProblem(pcm: Pcm): string | undefined {
  if (pcm.left.length !== pcm.right.length || seconds(pcm) < 0.08) return 'empty or too short';
  let energy = 0, clipped = 0;
  for (const channel of [pcm.left, pcm.right]) for (const v of channel) {
    if (!Number.isFinite(v)) return 'non-finite audio samples';
    energy += v * v;
    if (Math.abs(v) >= 0.999) clipped++;
  }
  const count = pcm.left.length * 2;
  if (Math.sqrt(energy / count) < 0.0001) return 'nearly silent';
  if (clipped / count > 0.01) return 'clipped recording';
  return undefined;
}

/**
 * The median pitch of a voice in Hz (autocorrelation over voiced 40 ms frames): about 100-130 for a man,
 * 180-230 for a woman, 260 and up for a child. 0 when nothing voiced is found.
 */
export function pitchHz(pcm: Pcm): number {
  const step = 3; // 44.1 kHz down to 14.7 kHz is plenty for 70-500 Hz
  const sr = RATE / step;
  const x = new Float32Array(Math.floor(pcm.left.length / step)).map((_, i) => (pcm.left[i * step] + pcm.right[i * step]) / 2);
  const w = Math.round(sr * 0.04);
  const lo = Math.floor(sr / 500);
  const hi = Math.ceil(sr / 70);
  const found: number[] = [];
  for (let at = 0; at + w + hi < x.length; at += w >> 1) {
    let energy = 0;
    for (let i = 0; i < w; i++) energy += x[at + i] ** 2;
    if (Math.sqrt(energy / w) < 0.02) continue;
    let best = 0;
    let lag = 0;
    for (let k = lo; k <= hi; k++) {
      let sum = 0;
      for (let i = 0; i < w; i++) sum += x[at + i] * x[at + i + k];
      if (sum > best) (best = sum), (lag = k);
    }
    if (lag && best > 0.4 * energy) found.push(sr / lag);
  }
  return Math.round(quantile(found, 0.5));
}

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

function quantile(values: number[], q: number) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

/**
 * Whether a take meant to loop is really one event (a crash, a single gust) with silence around it.
 * A loop needs sound all the way through: its quiet windows stay near its loud ones, and neither end dies out.
 */
export function loopProblem(pcm: Pcm, opts: { beats?: boolean } = {}): string | undefined {
  const env = envelope(pcm, 100);
  if (env.length < 10) return 'shorter than a second';
  const median = quantile(env, 0.5);
  // ElevenLabs makes a room hum or distant birds at -50..-65 dBFS; levelling raises them to the bed's loudness, so only
  // takes with nothing in them fail here (a classroom hum peaking at 0.002 was a usable bed, not silence).
  if (Math.max(...env) < 0.0005) return 'nearly silent';
  // A thing's own loop may be a beat (a clock ticking, a drip, a blinker): even events with quiet between are its sound.
  if (opts.beats && regularBeats(pcm)) return undefined;
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

/** Four or more clear events at an even pace (gaps within 30% of their mean): ticking, not one event in silence. */
export function regularBeats(pcm: Pcm): boolean {
  const env = envelope(pcm, 20);
  const peak = quantile(env, 0.98);
  if (peak < 0.003) return false;
  const onsets: number[] = [];
  let armed = true;
  env.forEach((v, i) => {
    if (armed && v > peak * 0.4) {
      onsets.push(i);
      armed = false;
    } else if (v < peak * 0.15) armed = true;
  });
  if (onsets.length < 4) return false;
  const gaps = onsets.slice(1).map((o, i) => o - onsets[i]);
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const spread = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) ** 2, 0) / gaps.length);
  return mean >= 5 && spread / mean < 0.3;
}

/** How much of the sound is hiss: the energy of the change from sample to sample over the energy (white noise 2, music about 0.06). */
export function hiss(pcm: Pcm): number {
  let e = 0, d = 0;
  for (let i = 1; i < pcm.left.length; i++) {
    const x = (pcm.left[i] + pcm.right[i]) / 2;
    const y = (pcm.left[i - 1] + pcm.right[i - 1]) / 2;
    e += x * x;
    d += (x - y) ** 2;
  }
  return e > 0 ? d / e : 0;
}

/**
 * How much of the sound's high end is tones rather than noise: the share of loud 12 ms frames whose sample-to-sample
 * change repeats itself (autocorrelation over 2-80 samples above 0.5). Crickets, birdsong and a whistle are tones and
 * score high; hiss, air and rustle have no period and score near 0. `hiss` alone cannot tell them apart: a cricket
 * at 4.5 kHz changes from sample to sample as much as white noise does.
 */
export function tonalShare(pcm: Pcm): number {
  const N = 512;
  const frames: Array<{ e: number; tonal: boolean }> = [];
  for (let at = 1; at + N <= pcm.left.length; at += N) {
    const d = new Float32Array(N);
    for (let i = 0; i < N; i++) d[i] = (pcm.left[at + i] + pcm.right[at + i] - pcm.left[at + i - 1] - pcm.right[at + i - 1]) / 2;
    let e = 0;
    for (const v of d) e += v * v;
    if (e <= 0) continue;
    let best = 0;
    for (let lag = 2; lag <= 80; lag++) {
      let r = 0;
      for (let i = lag; i < N; i++) r += d[i] * d[i - lag];
      best = Math.max(best, r / e);
    }
    frames.push({ e, tonal: best > 0.5 });
  }
  if (!frames.length) return 0;
  // Only frames that carry the sound count: the quiet gaps between chirps are noise floor.
  const loud = frames.filter((f) => f.e >= frames.map((x) => x.e).sort((a, b) => a - b)[Math.floor(frames.length / 2)]);
  return loud.filter((f) => f.tonal).length / loud.length;
}

/** Takes off what is above `hz`: two passes of a one-pole low-pass, each way. */
export function lowpass(pcm: Pcm, hz: number): Pcm {
  const a = Math.exp((-2 * Math.PI * hz) / RATE);
  const pass = (ch: Float32Array) => {
    const out = Float32Array.from(ch);
    for (let k = 0; k < 2; k++) {
      let y = out[0];
      for (let i = 0; i < out.length; i++) out[i] = y = (1 - a) * out[i] + a * y;
      y = out[out.length - 1];
      for (let i = out.length - 1; i >= 0; i--) out[i] = y = (1 - a) * out[i] + a * y;
    }
    return out;
  };
  return { left: pass(pcm.left), right: pass(pcm.right) };
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
