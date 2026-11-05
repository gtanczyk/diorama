// diorama clip <slug>: a short clip of the world for X, made with no hand editing. Plays the shortest ending route in
// real Chrome (GPU, ~60 fps screencast, a gliding cursor) at 1440x1080 with the camera still, so the whole 4:3
// painting is in every shot, records the last place on its own, picks the shots from the click log, cuts in each
// place orbiting and popping apart into its layers (app/demo/explode-take.ts --style orbit-popout) before its first
// shot and again under the end card, lays the world's own sound files under it (beds, loops, voices, music) and
// writes film/clip.mp4, film/clip-1080x1350.mp4 and film/clip-still-N.jpg. Both show the frame whole, the rest of the
// clip's frame filled with the same scene blurred (fillFrame). --zoom records the old way: 1920x1080 with the camera
// zoomed in and tracking the hero, the tall version a crop round the hero. The page's own recorded audio drops out
// on a loaded machine, so it is never used.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Page } from 'playwright';
import { audioPlan, clipSound, explodeFrame, fillFrame, LEVELS, pickShots, shotSeconds, shotStarts, type Cue, type Shot, type Take, type TakeEvent } from '../film/clip.ts';
import { openRecorder, type Recorder } from '../film/screencast.ts';
import { aimPoint, SETTLED, trackPending } from '../qa/route.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { soundData } from '../sound/data.ts';
import { checkStory } from '../story/check.ts';
import { actions as storyActions, apply, startState, type Action } from '../story/engine.ts';
import type { Story } from '../story/schema.ts';
import { WorldFiles } from '../world/files.ts';
import { serveWorld } from './play.ts';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FPS = 60;
const FONTS = ['/System/Library/Fonts/Supplemental/Arial Black.ttf', '/Library/Fonts/Arial Black.ttf', '/usr/share/fonts/truetype/msttcorefonts/Arial_Black.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'];
/** No words on screen but the game's own: the place name, the hover label, the controls hint and the bag go. */
const QUIET_UI = '#bar, #inventory, .held-cursor .label { display: none !important; }';
/** The recorded page: whole (the camera still, the 4:3 painting in full) or, with --zoom, zoomed in and tracking. */
const GAME_SIZE = { width: 1440, height: 1080 };
const ZOOM_SIZE = { width: 1920, height: 1080 };
const ZOOM_END_SIZE = { width: 1920, height: 1440 };

/** Logs the page's events and where the hero is on the page, in wall-clock seconds. */
const LOGGER = `(() => {
  const g = window.diorama;
  window.__clipLog = [];
  window.__heroLog = [];
  g.on((ev, d) => window.__clipLog.push({ ev, d, wall: Date.now() / 1000 }));
  setInterval(() => {
    if (!g.place || !g.hero) return;
    const c = document.querySelector('canvas');
    const r = c.getBoundingClientRect();
    const W = g.place.g.frame.width;
    const x = r.left + ((g.hero.x - (g.viewX || W / 2)) * g.zoom() + W / 2) * (r.width / c.width);
    window.__heroLog.push({ wall: Date.now() / 1000, x });
  }, 100);
})()`;

/** A page point on open floor between the hero and `target` (or anywhere near the hero), to set them walking. */
const floorPoint = (target: string | undefined) => `(() => {
  const g = window.diorama;
  const c = document.querySelector('canvas');
  const r = c.getBoundingClientRect();
  const { width: W, height: H } = g.place.g.frame;
  const z = g.zoom(), k = r.width / c.width;
  const toPage = (x, y) => [r.left + ((x - (g.viewX || W / 2)) * z + W / 2) * k, r.top + ((y - (g.viewY || H / 2)) * z + H / 2) * k];
  const toFrame = (px, py) => g.unzoom((px - r.left) / r.width * c.width, (py - r.top) / r.height * c.height);
  const hot = ${JSON.stringify(target ?? null)} && g.hots().find((h) => h.thing.key === ${JSON.stringify(target ?? null)});
  const goal = hot ? g.approach(hot) : null;
  const tries = [];
  if (goal) for (const u of [0.45, 0.35, 0.55, 0.25, 0.65, 0.8]) tries.push([g.hero.x + (goal[0] - g.hero.x) * u, g.hero.y + (goal[1] - g.hero.y) * u]);
  for (const d of [0.14, 0.09, 0.2]) for (let a = 0; a < 12; a++) tries.push([g.hero.x + Math.cos(a * Math.PI / 6) * W * d, g.hero.y + Math.sin(a * Math.PI / 6) * W * d * 0.5]);
  for (const [fx, fy] of tries) {
    const [px, py] = toPage(fx, fy);
    if (px < 60 || py < 60 || px > innerWidth - 60 || py > innerHeight - 60) continue;
    if (document.elementFromPoint(px, py) !== c) continue;
    const f = toFrame(px, py);
    if (g.thingAt(...f)) continue;
    const fl = g.floorAt(...f);
    if (!g.place.grid.walkable(...fl) || Math.hypot(fl[0] - g.hero.x, fl[1] - g.hero.y) < W * 0.05) continue;
    return { x: px, y: py };
  }
  return null;
})()`;

const targetOf = (a: Action) => (a.kind === 'go' ? a.via : a.kind === 'talk' ? a.npc : a.kind === 'do' ? a.thing : undefined);

type Logged = { ev: string; d: Record<string, unknown>; wall: number };

/** Turns the page's logs and our clicks into a Take on the video's clock. */
async function takeOf(page: Page, first: number, seconds: number, place: string, clicks: Array<{ wall: number; x: number; y: number; place: string; action?: Action }>): Promise<Take> {
  const log = await page.evaluate<Logged[]>('window.__clipLog');
  const hero = await page.evaluate<Array<{ wall: number; x: number }>>('window.__heroLog');
  const t = (wall: number) => Math.round((wall - first) * 1000) / 1000;
  const events: TakeEvent[] = clicks.map((c) => ({ kind: 'click', t: t(c.wall), x: c.x, y: c.y, place: c.place, ...(c.action && { action: c.action }) }));
  for (const e of log) {
    if (e.ev === 'use') events.push({ kind: 'use', t: t(e.wall), thing: String(e.d.thing) });
    else if (e.ev === 'say') events.push({ kind: 'say', t: t(e.wall), text: String(e.d.text), who: String(e.d.who) });
    else if (e.ev === 'exit') events.push({ kind: 'exit', t: t(e.wall), from: String(e.d.from), to: String(e.d.to) });
    else if (e.ev === 'enter') events.push({ kind: 'enter', t: t(e.wall), place: String(e.d.place) });
  }
  events.sort((a, b) => a.t - b.t);
  return { duration: Math.round(seconds * 1000) / 1000, place, events: events.filter((e) => e.t >= 0), hero: hero.map((h) => ({ t: t(h.wall), x: Math.round(h.x) })).filter((h) => h.t >= 0) };
}

/** Opens the page at `query`, waits for the place, quiets the click shot and the UI text, starts the logs. */
async function ready(rec: Recorder, url: string, css: string, log: (s: string) => void) {
  const { page } = rec;
  page.on('pageerror', (e) => log(`  page error: ${e.message}`));
  await page.goto(url);
  await page.waitForFunction('window.diorama && window.diorama.place && window.diorama.dark === 0', undefined, { timeout: 120_000 });
  // The game's own click shot is too harsh in a clip; the soundtrack is laid in the edit anyway.
  await page.evaluate('(() => { const m = window.diorama.sound; if (m && m.sound && m.sound.shots) delete m.sound.shots.click; m && m.ctx && m.ctx.resume(); })()');
  await page.addStyleTag({ content: css });
  await trackPending(page);
  await page.evaluate(LOGGER);
}

const settled = (page: Page) => page.waitForFunction(SETTLED, undefined, { timeout: 120_000 });

/** Plays `actions` in real time from the first place; the floor click first, so the hero is mid-stride. */
async function gameTake(port: number, work: string, actions: Action[], zoom: boolean, log: (s: string) => void): Promise<{ take: Take; video: string }> {
  const size = zoom ? ZOOM_SIZE : GAME_SIZE;
  const rec = await openRecorder(size.width, size.height, work, log);
  const { page } = rec;
  try {
    await ready(rec, `http://localhost:${port}/?parallax=1.5&sway=1${zoom ? '&track=1&fill=1' : ''}`, QUIET_UI, log);
    await page.mouse.move(size.width * 0.57, size.height * 0.76);
    await page.waitForTimeout(1500);
    // The narrator's intro is over before the clip starts.
    await settled(page);
    await page.waitForTimeout(300);
    const place = await page.evaluate<string>('window.diorama.place.key');
    const clicks: Array<{ wall: number; x: number; y: number; place: string; action?: Action }> = [];
    await rec.start();
    await page.waitForTimeout(400);
    const floor = await page.evaluate<{ x: number; y: number } | null>(floorPoint(actions[0] && targetOf(actions[0])));
    if (floor) {
      clicks.push({ wall: await rec.click(floor.x, floor.y, { ms: 250, dwell: 60 }), ...floor, place });
      await page.waitForTimeout(650);
    } else log('  no open floor to walk to first; the clip opens on the first story click');
    for (const [i, a] of actions.entries()) {
      if (i > 0) {
        await settled(page);
        await page.waitForTimeout(250);
      }
      const here = await page.evaluate<string>('window.diorama.place.key');
      log(`  ${i + 1}/${actions.length} ${JSON.stringify(a)}`);
      if (a.kind === 'choose' || a.kind === 'leave') {
        const button = page.locator(`#talk button[data-action=${JSON.stringify(a.kind === 'choose' ? `choose:${a.index}` : 'leave')}]`);
        await button.scrollIntoViewIfNeeded().catch(() => {});
        const b = await button.boundingBox();
        if (!b) throw new Error(`no answer button for ${JSON.stringify(a)}`);
        const at = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
        clicks.push({ wall: await rec.click(at.x, at.y, { ms: 450, dwell: 150 }), ...at, place: here, action: a });
        continue;
      }
      if (a.kind === 'go' && a.to) {
        // A car's destination is picked on the board the page shows over it.
        const at = await page.evaluate(`window.diorama.destinationPoint(${JSON.stringify(a.to)})`) as { x: number; y: number } | null;
        if (!at) throw new Error(`no destination ${a.to} on the board`);
        clicks.push({ wall: await rec.click(at.x, at.y, { ms: 650 }), ...at, place: here, action: a });
        continue;
      }
      const step: { use: string; verb?: string; with?: string } = a.kind === 'go' ? { use: a.via } : a.kind === 'talk' ? { use: a.npc } : { use: a.thing, verb: a.verb, ...(a.with ? { with: a.with } : {}) };
      // The bag is hidden in the clip: the item is lifted from it unseen and rides the cursor to its target.
      const pick = async () => {
        if (!step.with) return;
        const slot = page.locator(`#inventory button[data-item=${JSON.stringify(step.with)}]`);
        if (!(await slot.count())) throw new Error(`${step.with} is not in the bag`);
        await slot.dispatchEvent('click');
        await page.waitForTimeout(250);
      };
      await pick();
      // A step the slow machine left half done (an item still in hand): drop what is held, settle, aim again.
      let p = await aimPoint(page, step).catch(() => null);
      if (!p) {
        log(`  retry ${step.use}`);
        await page.keyboard.press('Escape');
        await settled(page).catch(() => {});
        await page.waitForTimeout(500);
        await pick();
        p = await aimPoint(page, step);
      }
      if (!p) throw new Error(`no clickable pixel for ${step.use}`);
      clicks.push({ wall: await rec.click(p.x, p.y, { ms: 650, button: step.verb === 'look' ? 'right' : 'left' }), ...p, place: here, action: a });
    }
    await settled(page).catch(() => {});
    await page.waitForTimeout(2500);
    const video = path.join(work, 'video.mp4');
    const v = await rec.stop(video, FPS);
    return { take: await takeOf(page, v.first, v.seconds, place, clicks), video };
  } finally {
    await rec.close();
  }
}

/**
 * The last place on its own, whole (no fill; 1440x1080, or 1920x1440 with --zoom so a tall thing stays in view), the
 * hero setting off for the next thing the route does there: really, when the fresh place allows it (a talk), else a
 * walk to it.
 */
async function endTake(port: number, work: string, place: string, next: Action | undefined, valid: boolean, zoom: boolean, log: (s: string) => void): Promise<{ take: Take; video: string }> {
  const size = zoom ? ZOOM_END_SIZE : GAME_SIZE;
  const rec = await openRecorder(size.width, size.height, work, log);
  const { page } = rec;
  try {
    await ready(rec, `http://localhost:${port}/?place=${encodeURIComponent(place)}&parallax=1.5&sway=1`, `${QUIET_UI} #talk { display: none !important; }`, log);
    await page.waitForFunction('!window.diorama.busy && !window.diorama.speech', undefined, { timeout: 60_000 }).catch(() => {});
    await page.mouse.move(size.width / 2, size.height * 0.62);
    await page.waitForTimeout(1200);
    const clicks: Array<{ wall: number; x: number; y: number; place: string; action?: Action }> = [];
    await rec.start();
    await page.waitForTimeout(300);
    const target = next && targetOf(next);
    const step = next && target ? (next.kind === 'do' ? { use: target, verb: next.verb } : { use: target }) : undefined;
    const aimed = valid && step ? await aimPoint(page, step).catch(() => null) : null;
    if (aimed && next) {
      log(`  end: ${JSON.stringify(next)}`);
      clicks.push({ wall: await rec.click(aimed.x, aimed.y, { ms: 400, dwell: 150 }), ...aimed, place, action: next });
    } else {
      // Not something the fresh place allows: the hero only walks to it.
      const rect = target ? await page.evaluate<{ x: number; y: number } | null>(`(() => { const r = window.diorama.pageRect(${JSON.stringify(target)}); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`) : null;
      const goal = rect && await page.evaluate<boolean>(`(() => { const g = window.diorama; const hot = g.hots().find((h) => h.thing.key === ${JSON.stringify(target)}); if (!hot) return false; void g.walkTo(...g.approach(hot)); return true; })()`).then(() => rect);
      const at = goal ?? (await page.evaluate<{ x: number; y: number } | null>(floorPoint(undefined)));
      if (at && goal) clicks.push({ wall: await rec.tap(at.x, at.y, { ms: 400, dwell: 150 }), ...at, place });
      else if (at) clicks.push({ wall: await rec.click(at.x, at.y, { ms: 400, dwell: 150 }), ...at, place });
      log(`  end: walk ${goal ? `to ${target}` : at ? 'across the floor' : '(nowhere to walk)'}`);
    }
    await page.waitForTimeout(10_000);
    const video = path.join(work, 'video.mp4');
    const v = await rec.stop(video, FPS);
    return { take: await takeOf(page, v.first, v.seconds, place, clicks), video };
  } finally {
    await rec.close();
  }
}

/** The place orbiting and popping apart into its layers (a 4 s take, app/demo/explode-take.ts); undefined when that is not there. */
function explodeTake(slug: string, place: string, out: string, log: (s: string) => void): string | undefined {
  const script = path.join(ROOT, 'app/demo/explode-take.ts');
  const tsx = path.join(ROOT, 'node_modules/.bin/tsx');
  if (!fs.existsSync(script) || !fs.existsSync(tsx)) {
    log('  no app/demo/explode-take.ts in this install: no layer explode');
    return undefined;
  }
  try {
    execFileSync(tsx, [script, slug, place, '--style', 'orbit-popout', '--seconds', '4', '--out', out], { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'inherit'] });
  } catch (error) {
    log(`  explode of ${place} failed (${(error as Error).message.split('\n')[0]}); going on without it`);
    return undefined;
  }
  const mp4 = path.join(out, `${slug}--${place}.mp4`);
  return fs.existsSync(mp4) ? mp4 : undefined;
}

const ff = (args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'inherit'] });
export const duration = (f: string) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());

function caption(text: string | undefined, size: number, y: number): string {
  if (!text) return '';
  const font = FONTS.find((f) => fs.existsSync(f));
  const t = text.replace(/\\/g, '').replace(/'/g, '\u2019').replace(/:/g, '\\:').replace(/%/g, '\\%');
  return `,drawtext=${font ? `fontfile='${font}':` : ''}text='${t}':fontsize=${size}:fontcolor=white:box=1:boxcolor=0x141a2e@0.88:boxborderw=${Math.round(size / 3)}:x=(w-tw)/2:y=h-th-${y}`;
}

type Sources = { game: string; end: string; explode: Record<string, string>; frames: Record<string, { width: number; height: number }> };

/**
 * How a shot sits in a w x h clip frame: a game or end frame whole with the blurred fill round it, an explode cut
 * round its flat painting; with --zoom the old way (the end take's middle 16:9 band, the tall one a crop round the hero).
 */
function shotFrame(s: Shot, frames: Sources['frames'], w: number, h: number, zoom: boolean): string {
  if (s.source === 'explode') return explodeFrame(frames[s.place], w, h);
  if (!zoom) return fillFrame(GAME_SIZE, w, h);
  const fit = s.source === 'end' ? `crop=${ZOOM_SIZE.width}:${ZOOM_SIZE.height}:0:${(ZOOM_END_SIZE.height - ZOOM_SIZE.height) / 2}` : `scale=${ZOOM_SIZE.width}:${ZOOM_SIZE.height}`;
  return w >= h ? fit : `${fit},scale=2400:1350:flags=lanczos,crop=1080:1350:${s.cropX}:0`;
}

/** Each shot to a 16:9 and a 1080x1350 segment, then each list joined with a re-encode (a stream-copy join of mixed encodes shows colour garbage). */
function renderVideo(shots: Shot[], sources: Sources, work: string, zoom: boolean): { wide: string; tall: string } {
  const wide: string[] = [], tall: string[] = [];
  shots.forEach((s, i) => {
    const src = s.source === 'explode' ? sources.explode[s.place] : sources[s.source];
    if (!src) throw new Error(`no ${s.source} take for ${s.place}`);
    const d = (s.to - s.from) / s.speed, hold = s.hold ?? 0;
    const pts = s.speed !== 1 ? `setpts=(PTS-STARTPTS)/${s.speed},` : '';
    const tail = hold ? `,tpad=stop_mode=clone:stop_duration=${hold}` : '';
    const input = ['-ss', String(s.from), '-t', String(s.to - s.from), '-i', src, '-an'];
    // The caption sits low in 16:9 and in the bar under the frame in 1080x1350.
    for (const [w, h, size, y, crf, list, name] of [[1920, 1080, 76, 110, '16', wide, 'w'], [1080, 1350, 62, zoom ? 160 : 170, '17', tall, 'v']] as const) {
      const out = path.join(work, `${name}${i}.mp4`);
      ff([...input, '-filter_complex', `[0:v]${shotFrame(s, sources.frames, w, h, zoom)},${pts}fps=${FPS},format=yuv420p${caption(s.caption, size, y)}${tail}[v]`, '-map', '[v]',
        '-t', (d + hold).toFixed(3), '-c:v', 'libx264', '-crf', crf, out]);
      list.push(out);
    }
  });
  const join = (name: string, parts: string[]) => {
    const list = path.join(work, `${name}.txt`);
    fs.writeFileSync(list, parts.map((p) => `file '${p}'\n`).join(''));
    const out = path.join(work, `${name}.mp4`);
    ff(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-crf', '16', '-preset', 'medium', out]);
    return out;
  };
  return { wide: join('wide', wide), tall: join('tall', tall) };
}

/** The cues mixed to one wav: each normalised and placed, then the whole to -14 LUFS. */
export function renderAudio(cues: Cue[], total: number, out: string, dir: string) {
  const inputs: string[] = [], chains: string[] = [], labels: string[] = [];
  for (const [n, c] of cues.entries()) {
    inputs.push(...(c.loop ? ['-stream_loop', '-1'] : []), '-i', path.join(dir, c.file));
    const ms = Math.round(c.at * 1000);
    chains.push(`[${n}:a]atrim=0:${c.seconds.toFixed(3)},asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,loudnorm=I=${c.lufs}:TP=${c.kind === 'voice' ? -3 : c.kind === 'music' ? -4 : -6},aresample=48000,asetpts=N/SR/TB,volume=${c.gain},`
      + `afade=t=in:d=${c.fadeIn},afade=t=out:st=${Math.max(0, c.seconds - c.fadeOut).toFixed(3)}:d=${c.fadeOut},adelay=${ms}|${ms},asetpts=N/SR/TB,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[x${n}]`);
    labels.push(`[x${n}]`);
  }
  // Silence the length of the clip under it all; each cue is padded to that length too (amix with delayed,
  // shorter inputs ends early).
  inputs.push('-f', 'lavfi', '-t', total.toFixed(3), '-i', 'anullsrc=r=48000:cl=stereo');
  labels.push(`[${cues.length}:a]`);
  // The whole is normalised in a second pass: loudnorm right after this amix ends the track early.
  const raw = out.replace(/(\.wav)?$/, '.raw.wav');
  ff([...inputs, '-filter_complex', `${chains.join(';')}${chains.length ? ';' : ''}${labels.join('')}amix=inputs=${labels.length}:duration=longest:normalize=0,apad=whole_dur=${total.toFixed(3)},atrim=0:${total.toFixed(3)}[a]`,
    '-map', '[a]', '-ar', '48000', '-c:a', 'pcm_s24le', raw]);
  ff(['-i', raw, '-af', `apad=pad_dur=4,loudnorm=I=${LEVELS.final}:TP=-1.5:LRA=11,aresample=48000,atrim=0:${total.toFixed(3)}`, '-ar', '48000', out]);
  fs.rmSync(raw, { force: true });
}

defineCommand({
  name: 'clip',
  usage: 'clip <slug>  a short clip for X: plays the shortest ending, cuts it round the clicks with each place coming apart and the world\'s own sound (film/clip.mp4, film/clip-1080x1350.mp4, film/clip-still-N.jpg) [--seconds 38] [--music file] [--no-explode] [--zoom] [--caption "Send me your sketch."] [--port 4198] [--keep]',
  async run(args) {
    // The whole clip, explodes and end card included; the story shots get what those leave (never less than ~2.4 s a place).
    const seconds = Number(takeOption(args, 'seconds', '38'));
    const musicArg = takeOption(args, 'music', '');
    const port = Number(takeOption(args, 'port', '4198'));
    const text = takeOption(args, 'caption', 'Send me your sketch.');
    const explode = !args.includes('--no-explode');
    const zoom = args.includes('--zoom');
    const keep = args.includes('--keep');
    const [slug] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama clip <slug> [--seconds 38] [--music file] [--no-explode] [--zoom] [--port N]');
    if (!(seconds > 5)) throw new Error('--seconds must be more than 5');
    const files = new WorldFiles(slug);
    const world = files.world();
    const report = checkStory(world, files.readJson(files.path('story.json')));
    if (report.issues.length || !report.story) throw new Error(`story.json does not check out:\n- ${report.issues.join('\n- ')}`);
    const story: Story = report.story;
    const route = [...report.routes].sort((a, b) => a.actions.length - b.actions.length)[0];
    if (!route) throw new Error(`${slug} has no route to an ending`);
    const log = (s: string) => console.log(s);

    // The game take runs to the last change of place; the last place is recorded on its own.
    let state = startState(world);
    const placeBefore: string[] = [];
    for (const a of route.actions) {
      placeBefore.push(state.place);
      state = apply(world, story, state, a).state;
    }
    const lastGo = route.actions.map((a) => a.kind).lastIndexOf('go');
    const played = lastGo >= 0 ? route.actions.slice(0, lastGo + 1) : route.actions.slice(0, -1);
    const firstPlace = startState(world).place;
    const lastPlace = lastGo >= 0 ? (placeBefore[lastGo + 1] ?? state.place) : firstPlace;
    const next = route.actions.slice(played.length).find((a) => a.kind === 'talk' || a.kind === 'do');
    const fresh = { ...startState(world), place: lastPlace };
    const valid = !!next && storyActions(world, story, fresh).some((a) => JSON.stringify(a) === JSON.stringify(next));
    log(`clip ${slug}: ${route.ending} in ${route.actions.length} clicks, ${played.length} played through, ending on ${lastPlace}`);

    const work = path.join(os.tmpdir(), `diorama-clip-${slug}`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    // An explode for every place the clip shows: the places the played route passes through, and the last one.
    const explodes: Record<string, string> = {};
    if (explode) {
      log('explode takes (each place orbits and pops apart into its layers)');
      for (const place of new Set([...placeBefore.slice(0, played.length), lastPlace])) {
        const mp4 = explodeTake(slug, place, path.join(work, 'explode'), log);
        if (mp4) explodes[place] = mp4;
      }
    }
    const frames = Object.fromEntries(Object.keys(explodes).map((p) => [p, (files.readJson(files.path('places', p, 'geometry.json')) as { frame: { width: number; height: number } }).frame]));
    const server = await serveWorld(files, port);
    let game: Awaited<ReturnType<typeof gameTake>>, end: Awaited<ReturnType<typeof endTake>>;
    try {
      log(`game take at http://localhost:${port}`);
      game = await gameTake(port, path.join(work, 'game'), played, zoom, log);
      log(`end take in ${lastPlace}`);
      end = await endTake(port, path.join(work, 'end'), lastPlace, next, valid, zoom, log);
    } finally {
      server.close();
    }
    const sources: Sources = { game: game.video, end: end.video, explode: explodes, frames };

    const shots = pickShots({
      game: game.take, end: end.take, seconds, firstPlace, lastPlace, caption: text,
      explodes: Object.fromEntries(Object.entries(explodes).map(([p, f]) => [p, duration(f)])),
    });
    const total = shots.reduce((n, s) => n + shotSeconds(s), 0);
    // What was made, even where the page now leaves a stale file out; only files that are there.
    const madeFile = files.path('sound', 'sounds.json');
    const made = fs.existsSync(madeFile) ? Object.fromEntries(Object.entries((files.readJson(madeFile) as { sounds: Record<string, { file: string; kind: string; level: number }> }).sounds ?? {}).filter(([, s]) => fs.existsSync(files.path(s.file)))) : {};
    const sound = clipSound(soundData(files), made, world.places.map((p) => p.key));
    const music = musicArg ? path.resolve(musicArg) : sound?.music ? files.path(sound.files[sound.music].file) : undefined;
    // Cue files are relative to the world (an outside --music file as a ../ path).
    const cues = audioPlan(shots, { game: game.take, end: end.take }, sound, music && path.relative(files.dir, music));
    const starts = shotStarts(shots);
    shots.forEach((s, i) => log(`  ${starts[i].toFixed(2).padStart(6)}s  ${s.source.padEnd(8)} ${s.from.toFixed(2)}-${s.to.toFixed(2)}${s.speed !== 1 ? ` x${s.speed}` : ''}  ${s.why}`));
    log(`${shots.length} shots, ${total.toFixed(1)} s; ${cues.filter((c) => c.kind === 'voice').length} voiced line(s)`);

    log('rendering');
    const cut = path.join(work, 'cut');
    fs.mkdirSync(cut, { recursive: true });
    const video = renderVideo(shots, sources, cut, zoom);
    const mix = path.join(cut, 'mix.wav');
    renderAudio(cues, total, mix, files.dir);
    const film = files.path('film');
    fs.mkdirSync(film, { recursive: true });
    const outWide = path.join(film, 'clip.mp4'), outTall = path.join(film, 'clip-1080x1350.mp4');
    for (const [src, out] of [[video.wide, outWide], [video.tall, outTall]]) {
      ff(['-i', src, '-i', mix, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', out]);
    }
    // Stills: the first place apart, a few story shots, the last place, the end card.
    for (const f of fs.readdirSync(film).filter((f) => /^clip-still-\d+\.jpg$/.test(f))) fs.rmSync(path.join(film, f));
    const picks = stillShots(shots);
    const stills = picks.map((i, n) => {
      const file = path.join(film, `clip-still-${n + 1}.jpg`);
      const at = starts[i] + shotSeconds(shots[i]) * (shots[i].caption ? 0.85 : 0.6);
      ff(['-ss', at.toFixed(3), '-i', outWide, '-frames:v', '1', '-q:v', '2', file]);
      return file;
    });
    files.write(path.join(film, 'clip.json'), { slug, ending: route.ending, seconds: Math.round(total * 100) / 100, shots: shots.map((s, i) => ({ at: Math.round(starts[i] * 100) / 100, ...s })), cues, takes: { game: game.take, end: end.take } });
    if (!keep) fs.rmSync(work, { recursive: true, force: true });
    log(`${outWide} (${duration(outWide).toFixed(1)} s)\n${outTall}\n${stills.join('\n')}${keep ? `\nworking files in ${work}` : ''}`);
  },
});

/** Up to six shots to take a still from: the first explode, story shots spread over the clip, the end, the last one. */
function stillShots(shots: Shot[]): number[] {
  const story = shots.map((s, i) => (s.source === 'game' && i > 0 ? i : -1)).filter((i) => i >= 0);
  const spread = [0, 1, 2].map((k) => story[Math.round((k * (story.length - 1)) / 2)]).filter((i) => i !== undefined);
  const out = [shots.findIndex((s) => s.source === 'explode'), ...spread, shots.findIndex((s) => s.source === 'end'), shots.length - 1];
  return [...new Set(out.filter((i) => i >= 0))].slice(0, 6);
}
