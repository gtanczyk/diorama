// A terminal shot for the film, rendered from a real command's output: the command is typed, then its log
// scrolls past, compressed to fit the shot. Same look on every render, no screen recording.
// npx tsx demo/term.ts <log.txt> "<command>" <out.mp4> [--seconds 8] [--type 2]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import sharp from 'sharp';

const W = 1920, H = 1080, FPS = 30;
const FONT = 30, LINE = 42, LEFT = 90, TOP = 120;
const ROWS = Math.floor((H - TOP - 80) / LINE);
const COLS = Math.floor((W - LEFT * 2) / (FONT * 0.6));

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Colour by what a line says, so a viewer can follow the steps without reading them. */
function colour(line: string): string {
  if (line.startsWith('# ')) return '#7fb4ff';
  if (/error|NOT playable/i.test(line)) return '#ff7a6b';
  if (/playable|ok\b|done/i.test(line)) return '#7ee08f';
  if (/^\s+flag/.test(line)) return '#c9b46a';
  return '#d6d6de';
}

function frameSvg(command: string, typed: number, lines: string[], cursor: boolean): string {
  const prompt = `<tspan fill="#7ee08f">~/diorama</tspan><tspan fill="#9a9aa8"> $ </tspan>`;
  // A long command wraps under itself, as a terminal would, instead of running off the window.
  const shown = `${command.slice(0, typed)}${typed < command.length && cursor ? '█' : ''}`;
  const width = COLS - '~/diorama $ '.length;
  const wrapped = shown.match(new RegExp(`.{1,${width}}(?:\\s|$)|.{1,${width}}`, 'g')) ?? [''];
  const typedRows = wrapped.map((part, i) => `${i ? ' '.repeat(12) : prompt}<tspan fill="#f2f2f6">${esc(part)}</tspan>`);
  const rows = [...typedRows,
    ...lines.map((l) => `<tspan fill="${colour(l)}">${esc(l.length > COLS ? `${l.slice(0, COLS - 1)}…` : l)}</tspan>`)].slice(-ROWS);
  const text = rows.map((r, i) => `<text x="${LEFT}" y="${TOP + i * LINE}" xml:space="preserve">${r}</text>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">
<rect width="100%" height="100%" fill="#0d0e12"/>
<rect x="40" y="30" width="${W - 80}" height="${H - 60}" rx="18" fill="#15161c" stroke="#2a2c36" stroke-width="2"/>
<circle cx="80" cy="64" r="9" fill="#ff5f57"/><circle cx="108" cy="64" r="9" fill="#febc2e"/><circle cx="136" cy="64" r="9" fill="#28c840"/>
<g font-family="DejaVu Sans Mono, monospace" font-size="${FONT}">${text}</g></svg>`;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name: string, fallback: number) => {
    const at = args.indexOf(`--${name}`);
    return at < 0 ? fallback : Number(args.splice(at, 2)[1]);
  };
  const seconds = opt('seconds', 8);
  const typing = opt('type', 2);
  const [logFile, command, out] = args;
  if (!logFile || !command || !out) throw new Error('usage: npx tsx demo/term.ts <log.txt> "<command>" <out.mp4> [--seconds 8] [--type 2]');
  const log = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.trim() !== '');

  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-',
    '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuv420p', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const frames = Math.round(seconds * FPS);
  const typeFrames = Math.round(typing * FPS);
  // The log runs from the end of typing to half a second before the shot ends, then holds on its last lines.
  const runFrames = Math.max(1, frames - typeFrames - FPS / 2);
  for (let f = 0; f < frames; f++) {
    const typed = Math.min(command.length, Math.floor((f / typeFrames) * command.length));
    const shown = f < typeFrames ? 0 : Math.min(log.length, Math.ceil(((f - typeFrames) / runFrames) * log.length));
    const png = await sharp(Buffer.from(frameSvg(command, typed, log.slice(0, shown), Math.floor(f / 15) % 2 === 0))).png().toBuffer();
    if (!ff.stdin.write(png)) await new Promise((r) => ff.stdin.once('drain', r));
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log(`${out}: ${seconds}s, ${log.length} log lines`);
}

await main();
