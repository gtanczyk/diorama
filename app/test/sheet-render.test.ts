import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
let browser: Browser, source: string;
beforeAll(async () => {
  source = (await build({ entryPoints: ['app/web/sheet.ts'], bundle: true, format: 'iife', write: false, plugins: [{ name: 'pose-recorder', setup(build) {
    build.onResolve({ filter: /hero3d\.ts$/ }, () => ({ path: 'pose-recorder', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `export class Figure3D {
      static async load() { return new Figure3D(); } feetAt = 1;
      plain() {} draw(pose) { window.poses.push(pose); const c=document.createElement('canvas'); c.width=100;c.height=100;const x=c.getContext('2d');x.fillStyle='red';x.fillRect(0,0,100,100);return c; }
    }` }));
  } }] })).outputFiles[0].text;
  browser = await chromium.launch();
});
afterAll(async () => browser?.close());
test.each([8, 16, 32])('%i walk poses span one whole cycle and standing does not consume a walk phase', async (frames) => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html>'); await page.addScriptTag({ content: source });
    const poses = await page.evaluate(async (frames) => {
      const w = window as any; w.poses = [];
      await w.renderSheet({ info: {}, base: '', yaw: 1, cols: 4, rows: frames / 4 + 1, width: 400, height: (frames / 4 + 1) * 100, feetAt: 1, px: 100, elevation: 0, frames, stand: true });
      return w.poses;
    }, frames);
    expect(poses).toHaveLength(frames + 1);
    expect(poses.slice(0, frames).map((p: any) => p.phase)).toEqual(Array.from({ length: frames }, (_, i) => i / frames));
    expect(poses.slice(0, frames).every((p: any) => p.walking)).toBe(true);
    expect(poses[frames]).toMatchObject({ phase: 0, walking: false });
  } finally { await page.close(); }
});
test('legacy guides still fill eight cells and talk renders only its gestures', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<!doctype html>'); await page.addScriptTag({ content: source });
    const results = await page.evaluate(async () => {
      const w = window as any, ask = { info: {}, base: '', yaw: 0, cols: 4, rows: 2, width: 400, height: 200, feetAt: 1, px: 100, elevation: 0 };
      w.poses = []; await w.renderSheet(ask); const legacy = w.poses;
      w.poses = []; await w.renderSheet({ ...ask, frames: 16, rows: 5, height: 500, gestures: [0, 2, 7] });
      return { legacy, talk: w.poses };
    });
    expect(results.legacy).toHaveLength(8); expect(results.legacy[7].phase).toBe(7 / 8);
    expect(results.talk.map((p: any) => p.gesture)).toEqual([0, 2, 7]);
    expect(results.talk.every((p: any) => !p.walking)).toBe(true);
  } finally { await page.close(); }
});
