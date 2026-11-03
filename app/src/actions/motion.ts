// place_motion: what moves in a place as the game plays it (water, fog, flames, an NPC breathing), for an agent
// that cannot watch the game: a few frames from the real play page, and the pixels that changed between them.
import fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import sharp from 'sharp';
import { z } from 'zod';
import { chromium } from '../commands/explore.ts';
import { serveWorld } from '../commands/play.ts';
import { svgLabel } from '../image/overlay.ts';
import { Geometry } from '../play/geometry.ts';
import { WorldFiles } from '../world/files.ts';
import { Slug } from '../world/schema.ts';
import { ActionError, defineAction } from './registry.ts';

const FRAMES = 6;
const EVERY_MS = 400;
/** A pixel moved when its brightness changed by more than this between two frames (0-255): above noise, below a slow ripple. */
const MOVED = 6;

type Shot = { screenshot(o?: object): Promise<Buffer>; goto(url: string): Promise<unknown>; waitForFunction(js: string, arg?: unknown, o?: object): Promise<unknown>; waitForTimeout(ms: number): Promise<void>; evaluate<T>(js: string): Promise<T> };

defineAction({
  name: 'place_motion',
  reads: true,
  description: 'Watch a place in the real game for a few seconds and see what moves, since you cannot play it: '
    + `${FRAMES} frames ${EVERY_MS} ms apart from the play page. You get a picture of the place with every pixel that moved tinted magenta, `
    + 'a strip of three frames, and in words how much of the picture moved and, per thing, how much of its box moved. '
    + 'Use it after a change to motion (water flow, fog, fire, weather, an animated thing) to check it shows, before telling the person it works. Free: no model calls.',
  input: z.object({ slug: Slug, place: z.string().min(1) }),
  async run({ slug, place }, ctx) {
    const files = new WorldFiles(slug, ctx.root);
    if (!fs.existsSync(files.path('places', place, 'geometry.json'))) throw new ActionError(404, `${slug}/${place} is not playable yet: build it to the derive step first`);
    const g = Geometry.parse(files.readJson(files.path('places', place, 'geometry.json')));
    const server = await serveWorld(files, 0);
    const browser = await (await chromium()).launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
    const frames: Buffer[] = [];
    let shows: Record<string, unknown> = {};
    try {
      const page = (await browser.newPage({ viewport: { width: 1200, height: 896 } })) as unknown as Shot;
      await page.goto(`http://localhost:${(server.address() as AddressInfo).port}/?place=${encodeURIComponent(place)}&capture=1&cursor=0&sound=0&parallax=1`);
      await page.waitForFunction('window.diorama && window.diorama.place', undefined, { timeout: 30000 });
      // parallax=1: the game as played. Capture mode leaves parallax off by default, and without it the page loads no
      // backdrop, so no water or mist layer either: every place then read "mist: none" however its fog was painted.
      // The place fades in and the hero lands: let it settle first.
      await page.waitForTimeout(1500);
      // What the game loaded to move here: a 0% with no layer means the layer never reached the game.
      shows = await page.evaluate<Record<string, unknown>>('(() => { const p = window.diorama.place; return { water: p.water ? `flowing ${p.water.flow.join(",") === "0,0" ? "still (swells)" : p.water.flow.join(",")}` : "none", mist: p.mist ? "drifting" : "none", clouds: p.clouds ? "drifting" : "none", waterfalls: (p.falls || []).length ? `${p.falls.length} pouring` : "none", animals: (p.critters || []).length ? `${p.critters.length} swimming or flying` : "none", weather: (() => { const w = window.diorama.data && window.diorama.data.places[p.key] && window.diorama.data.places[p.key].weather; return w ? `${w.fall}${w.fall !== "none" ? ` ${w.strength}` : ""}, fog ${w.fog}` : "none"; })() }; })()');
      // Frames EVERY_MS of game time apart, not wall time: a headless browser draws ~12 frames a second, and capture
      // mode steps 1/60 s per frame, so 2 s of waiting showed 0.4 s of the game and slow swells or drifting mist
      // looked still.
      for (let i = 0; i < FRAMES; i++) {
        if (i) {
          const t = await page.evaluate<number>('window.diorama.time');
          await page.waitForFunction(`window.diorama.time >= ${t + EVERY_MS / 1000}`, undefined, { timeout: 30000 });
        }
        frames.push(await page.screenshot({ type: 'png' }));
      }
    } finally {
      await browser.close();
      server.close();
    }

    const raw = await Promise.all(frames.map((f) => sharp(f).greyscale().raw().toBuffer({ resolveWithObject: true })));
    const { width: W, height: H } = raw[0].info;
    const moved = new Uint8Array(W * H);
    for (let k = 1; k < raw.length; k++) {
      const [a, b] = [raw[k - 1].data, raw[k].data];
      for (let i = 0; i < moved.length; i++) if (Math.abs(a[i] - b[i]) > MOVED) moved[i] = 1;
    }
    const share = (x0: number, y0: number, x1: number, y1: number) => {
      // Boxes are in the painting's frame (1200 x 896), the screenshot may differ a little.
      const [sx, sy] = [W / 1200, H / 896];
      let n = 0;
      let on = 0;
      for (let y = Math.max(0, Math.floor(y0 * sy)); y < Math.min(H, Math.ceil(y1 * sy)); y++) {
        for (let x = Math.max(0, Math.floor(x0 * sx)); x < Math.min(W, Math.ceil(x1 * sx)); x++) (n++, (on += moved[y * W + x]));
      }
      return n ? Math.round((on / n) * 100) : 0;
    };
    const total = share(0, 0, 1200, 896);
    const things = Object.fromEntries(g.things.filter((t) => t.role !== 'npc').map((t) => [t.key, `${share(...t.box)}% of its box moved`]));

    // The first frame, dimmed, with what moved in magenta; then three frames side by side.
    const base = await sharp(frames[0]).removeAlpha().raw().toBuffer();
    const tint = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      const m = moved[i];
      tint[i * 3] = m ? 255 : base[i * 3] * 0.55;
      tint[i * 3 + 1] = m ? 40 : base[i * 3 + 1] * 0.55;
      tint[i * 3 + 2] = m ? 220 : base[i * 3 + 2] * 0.55;
    }
    const label = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${svgLabel(12, 28, `moved in ${(FRAMES - 1) * EVERY_MS / 1000} s: ${total}% of the picture`, [255, 255, 255])}</svg>`);
    const whatMoved = await sharp(tint, { raw: { width: W, height: H, channels: 3 } }).composite([{ input: label }]).jpeg({ quality: 75 }).toBuffer();
    const tile = 400;
    const tileH = Math.round((tile * H) / W);
    const picks = [0, Math.floor(FRAMES / 2), FRAMES - 1];
    const strip = await sharp({ create: { width: tile * 3, height: tileH, channels: 3, background: '#111' } })
      .composite(await Promise.all(picks.map(async (k, i) => ({ input: await sharp(frames[k]).resize(tile, tileH).png().toBuffer(), left: i * tile, top: 0 }))))
      .jpeg({ quality: 72 }).toBuffer();
    fs.writeFileSync(files.path('places', place, 'view-motion.jpg'), whatMoved);
    // What the game loaded to move by itself: only then is a still frame a fault.
    const expected = [
      ...(shows.water && shows.water !== 'none' ? [`water (${shows.water})`] : []),
      ...(shows.mist && shows.mist !== 'none' ? ['drifting mist'] : []),
      ...(typeof shows.weather === 'string' && shows.weather !== 'none' && !/^none, fog 0$/.test(shows.weather) ? [`weather (${shows.weather})`] : []),
    ];
    return {
      place,
      inTheGame: shows,
      moved: `${total}% of the picture changed over ${(FRAMES - 1) * EVERY_MS / 1000} s`,
      ...(total < 1 && { note: expected.length
        ? `almost nothing moves, though the game loaded ${expected.join(', ')}: that motion is not showing`
        : 'nothing here is set to move by itself (no water, mist, weather or fog): a still frame while the hero stands is expected, not a fault. The place still moves with the camera and the hero as it is played.' }),
      things,
      picture: `places/${place}/view-motion.jpg`,
      images: [{ mimeType: 'image/jpeg', data: whatMoved.toString('base64') }, { mimeType: 'image/jpeg', data: strip.toString('base64') }],
    };
  },
});
