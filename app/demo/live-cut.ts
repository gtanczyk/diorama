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

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
const FONT = "'Arial Black', 'DejaVu Sans', sans-serif";

/** A title board in the look of 90s TVP: a dark blue gradient, a thin white rule, plain white title, sub in yellow. */
async function board(title: string, sub: string, file: string) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}"><defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b1a4a"/><stop offset="1" stop-color="#020617"/></linearGradient></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<rect x="260" y="${H / 2 + 46}" width="${W - 520}" height="4" fill="#ffffff" opacity="0.85"/>
<text x="${W / 2}" y="${H / 2 + 10}" text-anchor="middle" font-family="${FONT}" font-size="128" fill="#ffffff" letter-spacing="6">${esc(title)}</text>
<text x="${W / 2}" y="${H / 2 + 130}" text-anchor="middle" font-family="${FONT}" font-size="54" fill="#ffd84a">${esc(sub)}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

/** A 90s TV caption: a dark translucent band from the left, the model in yellow, then what happens in white. */
async function lowerThird(caption: string, by: string | undefined, file: string) {
  const y = Math.round(H * 0.84) - 96;
  const text = by ? `<tspan fill="#ffd84a">${esc(by)}</tspan><tspan fill="#ffffff">  ·  ${esc(caption)}</tspan>` : `<tspan fill="#ffffff">${esc(caption)}</tspan>`;
  const len = (by ? by.length + 5 : 0) + caption.length;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect x="0" y="${y}" width="${Math.min(W, 200 + len * 27)}" height="96" fill="#05103a" fill-opacity="0.82"/>
<rect x="0" y="${y + 92}" width="${Math.min(W, 200 + len * 27)}" height="4" fill="#ffd84a"/>
<text x="120" y="${y + 64}" font-family="${FONT}" font-size="46">${text}</text></svg>`;
  await sharp(Buffer.from(svg)).png().toFile(file);
}

/** The show's boards, edit here: one per round. */
const BOARDS: Array<[string, string, string]> = [
  ['intro', 'DIORAMA', 'Grzegorz Tańczyk plays a game he just made'],
  ['idea', 'THE IDEA', 'one sentence'],
  ['build', 'THE BUILD', 'Muse Spark, Muse Image, SAM 3.1'],
  ['play', 'THE GAME', 'let us play'],
  ['change', 'ONE MORE THING', 'change it by asking'],
  ['end', 'DIORAMA', 'github.com/gtanczyk/diorama'],
];

type Shot = { from?: number; to?: number; dur?: number; view: 'phone' | 'screen' | 'tv' | 'board'; speed?: number; caption?: string; by?: string; board?: string };
type Live = { phone: string; screen: string; offset: number; boards?: string; vhs?: boolean; shots: Shot[] };

async function cut(file: string, out: string) {
  const live = JSON.parse(fs.readFileSync(file, 'utf8')) as Live;
  const base = path.dirname(path.resolve(file));
  const at = (p: string) => path.resolve(base, p);
  const boards = at(live.boards ?? 'footage/live/boards');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const fit = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,fps=${FPS},format=yuv420p,setsar=1`;
  const parts: string[] = [];
  for (const [i, s] of live.shots.entries()) {
    const seg = path.join(tmp, `${String(i).padStart(3, '0')}.mp4`);
    const speed = s.speed ?? 1;
    const len = s.view === 'board' ? s.dur ?? 2 : ((s.to ?? 0) - (s.from ?? 0)) / speed;
    const args: string[] = ['-y', '-loglevel', 'error'];
    let video: string;
    let audio: string;
    if (s.view === 'board') {
      args.push('-loop', '1', '-t', String(len), '-i', path.join(boards, `${s.board}.png`), '-f', 'lavfi', '-t', String(len), '-i', 'anullsrc=r=48000:cl=stereo');
      video = `[0:v]${fit},fade=in:d=0.2,fade=out:st=${Math.max(0, len - 0.2)}:d=0.2[v0]`;
      audio = '[1:a]anull[a]';
    } else {
      const pf = s.from ?? 0, sf = pf - live.offset;
      const dur = (s.to ?? 0) - pf;
      args.push('-ss', String(pf), '-t', String(dur), '-i', at(live.phone), '-ss', String(Math.max(0, sf)), '-t', String(dur), '-i', at(live.screen));
      const pts = speed === 1 ? '' : `setpts=PTS/${speed},`;
      const atempo = speed === 1 ? 'anull' : Array.from({ length: Math.ceil(Math.log2(speed)) }, () => `atempo=${Math.min(2, speed ** (1 / Math.ceil(Math.log2(speed))))}`).join(',');
      if (s.view === 'phone') video = `[0:v]${pts}${fit}[v0]`;
      else if (s.view === 'screen') video = `[1:v]${pts}${fit}[v0]`;
      // The screen inside a TV: a blurred, darkened phone shot behind a bezelled 16:9 picture.
      else video = `[0:v]${pts}scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=20,eq=brightness=-0.25,fps=${FPS}[bg];[1:v]${pts}scale=1500:-2,pad=iw+60:ih+60:30:30:color=#1a1a1a,fps=${FPS}[tv];[bg][tv]overlay=(W-w)/2:(H-h)/2-20,format=yuv420p,setsar=1[v0]`;
      // Sped up, the voice would chirp: speeded shots keep only the game, low; normal ones the voice over the game.
      audio = speed === 1
        ? (s.view === 'phone' ? '[0:a]anull[a]' : '[0:a]volume=1[va];[1:a]volume=0.35[ga];[va][ga]amix=inputs=2:normalize=0[a]')
        : `[1:a]${atempo},volume=0.25[a]`;
    }
    let chain = `${video};${audio}`;
    if (s.caption || s.by) {
      const png = path.join(tmp, `${i}-lt.png`);
      await lowerThird(s.caption ?? '', s.by, png);
      args.push('-loop', '1', '-t', String(len), '-i', png);
      const k = s.view === 'board' ? 2 : 2;
      chain = `${video.replace('[v0]', '[vb]')};[${k}:v]format=rgba,fade=in:st=0.2:d=0.3:alpha=1,fade=out:st=${Math.max(0.5, len - 0.4)}:d=0.3:alpha=1[lt];[vb][lt]overlay=0:0,format=yuv420p[v0];${audio}`;
    }
    execFileSync('ffmpeg', [...args, '-filter_complex', chain, '-map', '[v0]', '-map', '[a]', '-t', String(len), '-c:v', 'libx264', '-crf', '18', '-c:a', 'aac', '-ar', '48000', '-ac', '2', seg]);
    parts.push(seg);
  }
  const list = path.join(tmp, 'list.txt');
  fs.writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  // A light 90s TV tape look over everything: soft, a little grain, faint scanlines, colour bleeding sideways.
  const vhs = live.vhs === false ? [] : ['-vf', `gblur=sigma=0.6,noise=alls=7:allf=t,rgbashift=rh=2:bh=-2,drawgrid=w=${W}:h=3:t=1:c=black@0.12,eq=saturation=1.08:contrast=1.04`];
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', list, ...vhs, '-c:v', 'libx264', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(out);
}

if (cmd === 'sync') {
  const [phone, screen] = rest;
  const a = clapAt(phone), b = clapAt(screen);
  console.log(JSON.stringify({ phoneClap: a, screenClap: b, offset: +(a - b).toFixed(3) }));
} else if (cmd === 'boards') {
  const out = path.resolve(takeOption(rest, 'out', 'app/demo/footage/live/boards'));
  fs.mkdirSync(out, { recursive: true });
  for (const [name, title, sub] of BOARDS) await board(title, sub, path.join(out, `${name}.png`));
  console.log(out);
} else if (cmd === 'cut') {
  await cut(rest[0], path.resolve(rest[1] ?? 'app/demo/out/live.mp4'));
} else throw new Error('usage: live-cut.ts sync <phone> <screen> | boards | cut <live.json> [out.mp4]');
