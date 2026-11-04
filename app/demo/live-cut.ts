// The live demo film: Grzegorz's phone recording (him at the TV) and his screen recording, synced by one clap and
// cut to an edit list, in a 90s TV game-show look (round boards, model lower thirds, the screen framed as a TV).
//   npx tsx app/demo/live-cut.ts sync <phone.mov> <screen.mov>        prints the screen's offset vs the phone (s)
//   npx tsx app/demo/live-cut.ts boards [--out app/demo/footage/live/boards]   renders the show's boards as PNGs
//   npx tsx app/demo/live-cut.ts cut <live.json> [<out.mp4>]
// live.json: { phone, screen, offset (screen time = phone time - offset), shots: [{ from, to, view, speed?, caption?,
// by?, board? }] }, times on the PHONE clock; view = "phone" | "screen" | "tv" (screen inside a TV frame over a
// blurred phone shot) | "board" (a still board PNG for `dur` seconds). The phone's sound is the voice; the screen's
// sound (the game) is mixed under it while the screen is shown.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { takeOption } from '../src/registry.ts';

const W = 1920, H = 1080, FPS = 30;
const [cmd, ...rest] = process.argv.slice(2);

/** The time (s) of the loudest short transient in the first `within` seconds: the clap. */
function clapAt(file: string, within = 90): number {
  const rate = 8000;
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-t', String(within), '-i', file, '-ac', '1', '-ar', String(rate), '-f', 's16le', '-'], { maxBuffer: 1 << 28 });
  const s = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2);
  const win = rate / 100;
  let best = 0, at = 0, floor = 0;
  const energy: number[] = [];
  for (let i = 0; i + win <= s.length; i += win) {
    let e = 0;
    for (let k = 0; k < win; k++) e += s[i + k] * s[i + k];
    energy.push(e / win);
  }
  // A clap: a sudden jump over the half second before it.
  for (let j = 50; j < energy.length; j++) {
    floor = energy.slice(j - 50, j).reduce((a, b) => a + b, 0) / 50 + 1;
    const jump = energy[j] / floor;
    if (jump > best) [best, at] = [jump, j / 100];
  }
  return at;
}

/** Log loudness per 1/rate s of a file's sound, mean-removed and scaled to unit variance. */
function envelope(file: string, rate: number): Float64Array {
  const sr = 8000, win = sr / rate;
  const raw = execFileSync('ffmpeg', ['-loglevel', 'error', '-i', file, '-ac', '1', '-ar', String(sr), '-f', 's16le', '-'], { maxBuffer: 1 << 30 });
  const s = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const n = Math.floor(s.length / win);
  const e = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let k = 0; k < win; k++) sum += s[i * win + k] ** 2;
    e[i] = Math.log(1 + sum / win);
  }
  const mean = e.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(e.reduce((a, b) => a + (b - mean) ** 2, 0) / n) || 1;
  return e.map((v) => (v - mean) / sd);
}

/** The lag (s, phone time - screen time) in [lo, hi] where the envelopes correlate best, by mean product over the overlap. */
function xcorr(a: Float64Array, b: Float64Array, rate: number, lo: number, hi: number): { lag: number; score: number } {
  let best = { lag: 0, score: -Infinity };
  for (let L = Math.round(lo * rate); L <= Math.round(hi * rate); L++) {
    // phone[i] matches screen[i - L]
    const i0 = Math.max(0, L), i1 = Math.min(a.length, b.length + L);
    if (i1 - i0 < 30 * rate) continue;
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += a[i] * b[i - L];
    const score = sum / (i1 - i0);
    if (score > best.score) best = { lag: L / rate, score };
  }
  return best;
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = "'Arial Black', 'DejaVu Sans', sans-serif";

const SERIF = "Caladea, 'Liberation Serif', serif";
const SANS = "Inter, 'DejaVu Sans', sans-serif";

/** A title board: a still of one of the worlds, blurred and dimmed, with a paper card on it (title, rule, sub). */
async function board(title: string, sub: string, kicker: string, file: string, bg?: string) {
  const card = { w: 1180, h: 430 };
  const x = (W - card.w) / 2, y = (H - card.h) / 2;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>
<radialGradient id="v" cx="0.5" cy="0.5" r="0.75"><stop offset="0.45" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.65"/></radialGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="18" stdDeviation="22" flood-color="#000" flood-opacity="0.55"/></filter></defs>
${bg ? '' : '<rect width="100%" height="100%" fill="#1b2133"/>'}<rect width="100%" height="100%" fill="url(#v)"/>
<rect x="${x}" y="${y}" width="${card.w}" height="${card.h}" rx="26" fill="#f6efe2" filter="url(#sh)"/>
<rect x="${x + 14}" y="${y + 14}" width="${card.w - 28}" height="${card.h - 28}" rx="18" fill="none" stroke="#d9cdb6" stroke-width="2"/>
<text x="${W / 2}" y="${y + 92}" text-anchor="middle" font-family="${SANS}" font-weight="700" font-size="30" letter-spacing="10" fill="#c4472b">${esc(kicker)}</text>
<text x="${W / 2}" y="${y + 236}" text-anchor="middle" font-family="${SERIF}" font-size="${title.length > 12 ? 104 : 124}" fill="#1d1b22">${esc(title)}</text>
<rect x="${W / 2 - 60}" y="${y + 280}" width="120" height="4" rx="2" fill="#c4472b"/>
<text x="${W / 2}" y="${y + 356}" text-anchor="middle" font-family="${SANS}" font-weight="500" font-size="${sub.length > 34 ? 46 : 52}" fill="#4a4550">${esc(sub)}</text></svg>`;
  const over = await sharp(Buffer.from(svg)).png().toBuffer();
  const base = bg
    ? await sharp(bg).resize(W, H, { fit: 'cover' }).blur(16).modulate({ brightness: 0.62, saturation: 1.1 }).toBuffer()
    : await sharp({ create: { width: W, height: H, channels: 3, background: '#1b2133' } }).png().toBuffer();
  await sharp(base).composite([{ input: over }]).png().toFile(file);
}

/** A caption: a paper pill at the lower left, the model in red, then what happens in ink. */
async function lowerThird(caption: string, by: string | undefined, file: string) {
  const y = Math.round(H * 0.84) - 84;
  const text = by ? `<tspan fill="#c4472b" font-weight="700">${esc(by)}</tspan><tspan fill="#1d1b22">   ${esc(caption)}</tspan>` : `<tspan fill="#1d1b22">${esc(caption)}</tspan>`;
  const len = (by ? by.length + 3 : 0) + caption.length;
  const w = Math.min(W - 120, 110 + len * 23);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>
<filter id="sh" x="-10%" y="-40%" width="120%" height="200%"><feDropShadow dx="0" dy="8" stdDeviation="10" flood-color="#000" flood-opacity="0.5"/></filter></defs>
<rect x="60" y="${y}" width="${w}" height="84" rx="42" fill="#f6efe2" fill-opacity="0.96" filter="url(#sh)"/>
<text x="110" y="${y + 55}" font-family="${SANS}" font-weight="500" font-size="40">${text}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

/** The show's boards, edit here: one per round. */
const BOARDS: Array<[string, string, string, string]> = [
  ['intro', 'Diorama', 'Grzegorz Tańczyk plays a game he just made', 'LIVE DEMO'],
  ['idea', 'The idea', 'two drawings and one sentence', 'DIORAMA'],
  ['build', 'The build', 'Muse Spark · Muse Image · SAM 3.1', 'DIORAMA'],
  ['play', "Let's play", 'the game, twenty minutes old', 'DIORAMA'],
  ['change', 'One more thing', 'change it by asking', 'DIORAMA'],
  ['end', 'Diorama', 'grzegorz.tanczyk.pl/diorama/', 'PLAY THE WORLDS'],
];

type Shot = { from?: number; to?: number; dur?: number; view: 'phone' | 'screen' | 'tv' | 'board'; speed?: number; caption?: string; by?: string; board?: string; crop?: [number, number, number, number]; src?: string; bed?: string; bedFrom?: number; bedVolume?: number; fadeOut?: number };
/** A voice-over line laid over the cut: starts `at` seconds into shot `shot`; the game sound ducks under it. */
type Vo = { src: string; shot: number; at?: number; volume?: number };
type Live = { phone: string; screen: string; offset: number; clock?: 'phone' | 'screen'; boards?: string; vhs?: boolean; vo?: Vo[]; shots: Shot[] };

async function cut(file: string, out: string) {
  const live = JSON.parse(fs.readFileSync(file, 'utf8')) as Live;
  const base = path.dirname(path.resolve(file));
  const at = (p: string) => path.resolve(base, p);
  const boards = at(live.boards ?? 'footage/live/boards');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},format=yuv420p,setsar=1`;
  const parts: string[] = [];
  const starts: number[] = [];
  let clock = 0;
  for (const [i, s] of live.shots.entries()) {
    const seg = path.join(tmp, `${String(i).padStart(3, '0')}.mp4`);
    const speed = s.speed ?? 1;
    const len = s.view === 'board' ? s.dur ?? 2 : ((s.to ?? 0) - (s.from ?? 0)) / speed;
    starts.push(clock);
    clock += len;
    const args: string[] = ['-y', '-loglevel', 'error'];
    let video: string;
    let audio: string;
    if (s.view === 'board') {
      args.push('-loop', '1', '-t', String(len), '-i', path.join(boards, `${s.board}.png`), '-f', 'lavfi', '-t', String(len), '-i', 'anullsrc=r=48000:cl=stereo');
      video = `[0:v]${fit},fade=in:d=0.2,fade=out:st=${Math.max(0, len - 0.2)}:d=0.2[v0]`;
      audio = s.bed ? `[BED:a]atrim=0:${len},volume=${s.bedVolume ?? 0.5},aresample=48000,aformat=channel_layouts=stereo[a]` : '[1:a]anull[a]';
    } else {
      // Times are on the phone's clock unless the edit says `clock: "screen"`.
      const pf = (s.from ?? 0) + (live.clock === 'screen' ? live.offset : 0), sf = pf - live.offset;
      const dur = (s.to ?? 0) - (s.from ?? 0);
      // `src`: an extra recording (its own clock) stands in for both the phone and the screen.
      if (s.src) args.push('-ss', String(s.from ?? 0), '-t', String(dur), '-i', at(s.src), '-ss', String(s.from ?? 0), '-t', String(dur), '-i', at(s.src));
      else args.push('-ss', String(pf), '-t', String(dur), '-i', at(live.phone), '-ss', String(Math.max(0, sf)), '-t', String(dur), '-i', at(live.screen));
      const pts = speed === 1 ? '' : `setpts=PTS/${speed},`;
      const atempo = speed === 1 ? 'anull' : Array.from({ length: Math.ceil(Math.log2(speed)) }, () => `atempo=${Math.min(2, speed ** (1 / Math.ceil(Math.log2(speed))))}`).join(',');
      const crop = s.crop ? `crop=${s.crop[2]}:${s.crop[3]}:${s.crop[0]}:${s.crop[1]},` : '';
      if (s.view === 'phone') video = `[0:v]${pts}${fit}[v0]`;
      else if (s.view === 'screen') video = `[1:v]${crop}${pts}${fit}[v0]`;
      // The screen inside a TV: a blurred, darkened phone shot behind a bezelled 16:9 picture.
      else video = `[0:v]${pts}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20,eq=brightness=-0.25,fps=${FPS}[bg];[1:v]${crop}${pts}scale=1500:880:force_original_aspect_ratio=decrease,pad=iw+60:ih+60:30:30:color=#1a1a1a,fps=${FPS}[tv];[bg][tv]overlay=(W-w)/2:(H-h)/2-20,format=yuv420p,setsar=1[v0]`;
      // The screen recording carries the voice and the game (the phone's mic is too weak), so its sound plays under
      // every view; sped up, the voice would chirp, so a speeded shot is silent (a voice-over line goes there).
      audio = speed === 1 ? '[1:a]anull[a]' : `[1:a]${atempo},volume=0[a]`;
      // `bed`: a music file plays under the shot instead (from its start), for speeded shots.
      if (s.bed) audio = `[BED:a]atrim=0:${len},volume=${s.bedVolume ?? 0.5},aresample=48000,aformat=channel_layouts=stereo[a]`;
    }
    if (s.bed) {
      audio = audio.replace('[BED:a]', `[${args.filter((a) => a === '-i').length}:a]`);
      args.push('-ss', String(s.bedFrom ?? 0), '-i', at(s.bed));
    }
    // Short fades at every cut so no word or note is chopped into a click; `fadeOut` lets the last shot fade away.
    const fo = s.fadeOut ?? 0.04;
    audio = audio.replace(/\[a\]$/, `,afade=t=in:d=0.04,afade=t=out:st=${Math.max(0, len - fo)}:d=${fo}[a]`);
    let chain = `${video};${audio}`;
    if (s.caption || s.by) {
      const png = path.join(tmp, `${i}-lt.png`);
      await lowerThird(s.caption ?? '', s.by, png);
      args.push('-loop', '1', '-t', String(len), '-i', png);
      const k = args.filter((a) => a === '-i').length - 1;
      chain = `${video.replace('[v0]', '[vb]')};[${k}:v]format=rgba,fade=in:st=0.2:d=0.3:alpha=1,fade=out:st=${Math.max(0.5, len - 0.4)}:d=0.3:alpha=1[lt];[vb][lt]overlay=0:0,format=yuv420p[v0];${audio}`;
    }
    execFileSync('ffmpeg', [...args, '-filter_complex', chain, '-map', '[v0]', '-map', '[a]', '-t', String(len), '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-ar', '48000', '-ac', '2', seg]);
    parts.push(seg);
  }
  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // A light 90s TV tape look over everything: soft, a little grain, faint scanlines, colour bleeding sideways.
  const vhs = live.vhs === false ? 'null' : `gblur=sigma=0.6,noise=alls=7:allf=t,rgbashift=rh=2:bh=-2,drawgrid=w=${W}:h=3:t=1:c=black@0.12,eq=saturation=1.08:contrast=1.04`;
  // Voice-over lines are placed on the cut's clock and the shots' own sound ducks under them (sidechain).
  const vo = live.vo ?? [];
  const voIn = vo.flatMap((v) => ['-i', at(v.src)]);
  let mix = '[0:a]anull[mix]';
  if (vo.length) {
    const lines = vo.map((v, i) => `[${i + 1}:a]aresample=48000,aformat=channel_layouts=stereo,volume=${v.volume ?? 1.6},adelay=${Math.round((starts[v.shot] + (v.at ?? 0)) * 1000)}:all=1[vo${i}]`);
    const voMix = vo.length > 1 ? `${vo.map((_, i) => `[vo${i}]`).join('')}amix=inputs=${vo.length}:normalize=0[vos]` : '[vo0]anull[vos]';
    mix = `${lines.join(';')};${voMix};[vos]asplit=2[key][say];[0:a][key]sidechaincompress=threshold=0.015:ratio=12:attack=30:release=400[duck];[duck][say]amix=inputs=2:normalize=0:duration=first[mix]`;
  }
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...voIn, '-filter_complex', `[0:v]${vhs}[v];${mix}`, '-map', '[v]', '-map', '[mix]', '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(out);
}

if (cmd === 'sync') {
  const [phone, screen] = rest;
  const a = clapAt(phone), b = clapAt(screen);
  console.log(JSON.stringify({ phoneClap: a, screenClap: b, offset: +(a - b).toFixed(3) }));
} else if (cmd === 'xsync') {
  // No clap: the offset where the two sound tracks' loudness envelopes line up best (both mics hear the same room).
  const [phone, screen] = rest;
  const maxLag = Number(takeOption(rest, 'max', '900'));
  const coarse = xcorr(envelope(phone, 10), envelope(screen, 10), 10, -maxLag, maxLag);
  const fine = xcorr(envelope(phone, 100), envelope(screen, 100), 100, coarse.lag - 1, coarse.lag + 1);
  console.log(JSON.stringify({ offset: +fine.lag.toFixed(3), score: +fine.score.toFixed(3), coarseScore: +coarse.score.toFixed(3) }));
} else if (cmd === 'boards') {
  const out = path.resolve(takeOption(rest, 'out', 'app/demo/footage/live/boards'));
  fs.mkdirSync(out, { recursive: true });
  // `--bg dir`: a still per board (dir/<name>.png), blurred behind its card.
  const bgDir = takeOption(rest, 'bg', '');
  for (const [name, title, sub, kicker] of BOARDS) {
    const bg = bgDir && fs.existsSync(path.join(bgDir, `${name}.png`)) ? path.join(bgDir, `${name}.png`) : undefined;
    await board(title, sub, kicker, path.join(out, `${name}.png`), bg);
  }
  console.log(out);
} else if (cmd === 'cut') {
  await cut(rest[0], path.resolve(rest[1] ?? 'app/demo/out/live.mp4'));
} else throw new Error('usage: live-cut.ts sync <phone> <screen> | boards | cut <live.json> [out.mp4]');
