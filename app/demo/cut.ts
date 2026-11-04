// The demo film's edit as data: app/demo/cut.json lists the shots, this script renders them with ffmpeg.
// npx tsx app/demo/cut.ts [app/demo/cut.json] [out.mp4]
// A shot is a clip (`src`, optional `from`), a still (`image`) or a title card (`card`), held for `dur` seconds;
// `fade` blends it in over the previous shot; `speed` plays a clip faster (a model's wait at 40x).
// Paths are relative to the cut file. Missing clips render as a labelled placeholder card,
// so the cut always plays end to end while the real shots are still being made.
// Sound: a shot's `audio` is the volume of its clip's own sound (left out = silent), `music` loops under the
// whole film and ducks while a `voice` line (voice-over, placed at `at` seconds) plays: one voice at a time.
// The mix is normalised to -14 LUFS, where YouTube and X play it without turning it down.
// `caption` lays a lower third over a shot (what happens), with `by` as a badge naming the model that does it,
// and `speedup` marks a sped-up wait in the corner ("70x"). `crop` [x, y, w, h] in the clip's pixels zooms in on part of it.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';

type Shot = { name: string; dur: number; src?: string; from?: number; speed?: number; image?: string; card?: string; fade?: number; audio?: number; caption?: string; captionTop?: boolean; by?: string; speedup?: string; crop?: [number, number, number, number] };
type Cut = { fps?: number; shots: Shot[]; music?: { src: string; volume?: number }; voice?: { src: string; at: number; volume?: number }[] };

const W = 1920, H = 1080;
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

async function cardPng(title: string, note: string): Promise<Buffer> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><rect width="100%" height="100%" fill="#101014"/>
<text x="120" y="500" font-family="DejaVu Sans, sans-serif" font-size="64" font-weight="bold" fill="#fff">${esc(title)}</text>
<text x="120" y="580" font-family="DejaVu Sans, sans-serif" font-size="34" fill="#9a9aa8">${esc(note)}</text></svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

/** The lower third of a shot: a dark band with the model's badge and what happens, plus a speed mark. */
async function captionPng(shot: Shot): Promise<Buffer> {
  // Centred and lifted clear of the bottom ~14%, where a video player draws its controls and timecode: a solid dark
  // pill under every caption, bold white type, the model badge inside the pill, so it reads at first glance on a phone.
  const text = shot.caption ?? '';
  const font = 'Inter, DejaVu Sans, sans-serif';
  const size = 50;
  const badge = shot.by ? Math.round(shot.by.length * 21 + 60) : 0;
  const gap = badge ? 26 : 0;
  const textW = Math.round(text.length * size * 0.56);
  const pillW = 64 + badge + gap + textW;
  const pillH = 112;
  const x0 = Math.round((W - pillW) / 2);
  // `captionTop` lifts it to the top of the frame, clear of a screen recording's own buttons along the bottom.
  const y0 = shot.captionTop ? Math.round(H * 0.06) : Math.round(H * 0.86) - pillH;
  const mid = y0 + pillH / 2;
  const shade = `<defs><linearGradient id="sh" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient></defs>${shot.captionTop ? '' : `<rect x="0" y="${y0 - 120}" width="${W}" height="${H - y0 + 120}" fill="url(#sh)"/>`}`;
  const band = text || shot.by ? `${shade}<rect x="${x0}" y="${y0}" width="${pillW}" height="${pillH}" rx="${pillH / 2}" fill="#0b0b10" fill-opacity="0.95"/>
${shot.by ? `<rect x="${x0 + 32}" y="${mid - 30}" width="${badge}" height="60" rx="30" fill="#2f5bea"/><text x="${x0 + 32 + badge / 2}" y="${mid + 11}" text-anchor="middle" font-family="${font}" font-size="32" font-weight="bold" fill="#fff">${esc(shot.by)}</text>` : ''}
<text x="${x0 + 32 + badge + gap}" y="${mid + 17}" font-family="${font}" font-size="${size}" font-weight="bold" fill="#ffffff">${esc(text)}</text>` : '';
  const speed = shot.speedup ? `<rect x="${W - 230}" y="64" width="166" height="76" rx="38" fill="#0b0b10" fill-opacity="0.95"/><text x="${W - 147}" y="116" text-anchor="middle" font-family="${font}" font-size="38" font-weight="bold" fill="#ffb347">${esc(shot.speedup)} ▸▸</text>` : '';
  return sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${band}${speed}</svg>`)).png().toBuffer();
}

async function main() {
  const cutFile = path.resolve(process.argv[2] ?? 'app/demo/cut.json');
  const out = path.resolve(process.argv[3] ?? 'app/demo/out/cut.mp4');
  const cut = JSON.parse(fs.readFileSync(cutFile, 'utf8')) as Cut;
  const fps = cut.fps ?? 30;
  const base = path.dirname(cutFile);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cut-'));
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${fps},format=yuv420p,setsar=1`;

  // Every shot becomes a same-sized, same-rate segment, running past its slot by the overlap with the next one.
  // A clip shorter than its slot holds its last frame, so the joins below never run out of picture.
  const segments: string[] = [];
  for (const [i, shot] of cut.shots.entries()) {
    const next = cut.shots[i + 1];
    const len = shot.dur + (next ? next.fade ?? 1 / fps : 0);
    const seg = path.join(tmp, `${String(i).padStart(3, '0')}.mp4`);
    const src = shot.src && path.resolve(base, shot.src);
    const image = shot.image && path.resolve(base, shot.image);
    const speed = shot.speed ?? 1;
    let input: string[];
    if (src && fs.existsSync(src)) input = ['-ss', String(shot.from ?? 0), '-t', String(len * speed), '-i', src];
    else {
      const png = path.join(tmp, `${i}.png`);
      if (image && fs.existsSync(image)) fs.copyFileSync(image, png);
      else fs.writeFileSync(png, await cardPng(shot.card ?? shot.name, shot.card ? '' : `placeholder: ${shot.src ?? shot.image ?? 'to shoot'}`));
      input = ['-loop', '1', '-t', String(len), '-i', png];
    }
    const crop = shot.crop ? `crop=${shot.crop[2]}:${shot.crop[3]}:${shot.crop[0]}:${shot.crop[1]},` : '';
    const picture = `${crop}${speed === 1 ? '' : `setpts=PTS/${speed},`}${fit},tpad=stop_mode=clone:stop_duration=${len}`;
    let filter = ['-vf', picture];
    if (shot.caption || shot.by || shot.speedup) {
      const png = path.join(tmp, `${i}-caption.png`);
      fs.writeFileSync(png, await captionPng(shot));
      input.push('-loop', '1', '-t', String(len), '-i', png);
      filter = ['-filter_complex', `[0:v]${picture}[v];[1:v]format=rgba,fade=in:st=0.25:d=0.35:alpha=1,fade=out:st=${Math.max(0.6, shot.dur - 0.4).toFixed(2)}:d=0.3:alpha=1[c];[v][c]overlay=0:0,format=yuv420p`];
    }
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...input, ...filter, '-an', '-t', String(len), '-c:v', 'libx264', '-crf', '18', '-video_track_timescale', '15360', seg]);
    segments.push(seg);
  }

  // Join: a hard cut is an xfade of a single frame, so every join goes through the same chain.
  // Each segment runs past its slot by the overlap, so shot i starts exactly at the sum of the slots before it.
  const inputs = segments.flatMap((s) => ['-i', s]);
  let chain = '', last = '[0:v]', at = 0;
  for (let i = 1; i < segments.length; i++) {
    at += cut.shots[i - 1].dur;
    const fade = cut.shots[i].fade ?? 1 / fps;
    const label = `[j${i}]`;
    chain += `${last}[${i}:v]xfade=transition=fade:duration=${fade}:offset=${at.toFixed(3)}${label};`;
    last = label;
  }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const map = segments.length > 1 ? ['-filter_complex', chain.slice(0, -1).replace(/\[j\d+\]$/, '[v]'), '-map', '[v]'] : [];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...inputs, ...map, '-c:v', 'libx264', '-crf', '20', '-pix_fmt', 'yuv420p', out], { stdio: 'inherit' });
  const total = cut.shots.reduce((s, x) => s + x.dur, 0);
  const sound = mixSound(cut, base, total);
  if (sound) {
    const silent = path.join(tmp, 'picture.mp4');
    fs.renameSync(out, silent);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...sound.inputs, '-i', silent, '-filter_complex', sound.graph,
      '-map', `${sound.inputs.filter((a) => a === '-i').length}:v`, '-map', '[mix]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', String(total), out], { stdio: 'inherit' });
  }
  console.log(`${out}: ${cut.shots.length} shots, ${total.toFixed(1)}s${sound ? ', with sound' : ''}`);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/** Whether a clip has a sound track: a screen recording has none. */
const hasSound = (file: string) => execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', file], { encoding: 'utf8' }).trim() !== '';

/** The film's sound as ffmpeg inputs and a filter graph ending in [mix], or nothing when the cut has no sound. */
function mixSound(cut: Cut, base: string, total: number): { inputs: string[]; graph: string } | undefined {
  const inputs: string[] = [];
  const parts: string[] = [];
  const add = (args: string[]) => (inputs.push(...args), inputs.filter((a) => a === '-i').length - 1);
  const game: string[] = [];
  let at = 0;
  for (const shot of cut.shots) {
    const src = shot.src && path.resolve(base, shot.src);
    // A sped-up clip's sound would be noise, so only clips at normal speed keep theirs.
    if (shot.audio && src && fs.existsSync(src) && (shot.speed ?? 1) === 1 && hasSound(src)) {
      const k = add(['-ss', String(shot.from ?? 0), '-t', String(shot.dur), '-i', src]);
      const ms = Math.round(at * 1000);
      parts.push(`[${k}:a]afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, shot.dur - 0.3)}:d=0.3,volume=${shot.audio},adelay=${ms}|${ms}[g${k}]`);
      game.push(`[g${k}]`);
    }
    at += shot.dur;
  }
  const voices = (cut.voice ?? []).filter((v) => fs.existsSync(path.resolve(base, v.src))).map((v) => {
    const k = add(['-i', path.resolve(base, v.src)]);
    const ms = Math.round(v.at * 1000);
    parts.push(`[${k}:a]volume=${v.volume ?? 1},adelay=${ms}|${ms}[v${k}]`);
    return `[v${k}]`;
  });
  const musicSrc = cut.music && path.resolve(base, cut.music.src);
  const hasMusic = !!musicSrc && fs.existsSync(musicSrc);
  if (!game.length && !voices.length && !hasMusic) return undefined;
  const mixed: string[] = [...game];
  if (voices.length) {
    parts.push(`${voices.join('')}amix=inputs=${voices.length}:normalize=0,asplit=2[vo][key]`);
    mixed.push('[vo]');
  }
  if (hasMusic) {
    const k = add(['-stream_loop', '-1', '-i', musicSrc!]);
    parts.push(`[${k}:a]atrim=0:${total},volume=${cut.music!.volume ?? 0.3},afade=t=out:st=${Math.max(0, total - 2)}:d=2[mus]`);
    // Music ducks under the voice-over, so there is never more than one voice to follow.
    if (voices.length) parts.push('[mus][key]sidechaincompress=threshold=0.02:ratio=10:attack=20:release=400[musd]');
    mixed.push(voices.length ? '[musd]' : '[mus]');
  } else if (voices.length) parts.push('[key]anullsink');
  parts.push(`${mixed.join('')}amix=inputs=${mixed.length}:normalize=0:duration=longest,apad,atrim=0:${total},loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[mix]`);
  return { inputs, graph: parts.join(';') };
}

await main();
