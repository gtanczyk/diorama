import { build } from 'esbuild';
import sharp from 'sharp';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, expect, test } from 'vitest';
import type { Figure3D, ModelInfo } from '../web/hero3d.ts';
import { boxGlb } from './fixtures/model-box.ts';

let browser: Browser, source: string, png: Buffer;
beforeAll(async () => {
  source = (await build({ entryPoints: ['app/web/hero3d.ts'], bundle: true, format: 'iife', globalName: 'Figures', write: false })).outputFiles[0].text;
  png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#dddddd' } }).png().toBuffer();
  browser = await chromium.launch();
}, 30_000);
afterAll(async () => browser?.close());

async function open(glb: Buffer): Promise<Page> {
  const page = await browser.newPage();
  await page.route('http://model.test/**', (r) => {
    const name = new URL(r.request().url()).pathname;
    return r.fulfill(name === '/model.glb' ? { body: glb, contentType: 'model/gltf-binary' }
      : name.endsWith('.png') ? { body: png, contentType: 'image/png' }
      : { body: '<!doctype html><body></body>', contentType: 'text/html' });
  });
  await page.goto('http://model.test/');
  await page.addScriptTag({ content: source });
  return page;
}

declare global {
  interface Window { Figures: { Figure3D: typeof Figure3D } }
}
const info: ModelInfo = {
  glb: 'model.glb', creature: true,
  views: Object.fromEntries(['front', 'back', 'left', 'right'].map((name) => [name, { image: `${name}.png`, u: [1, 0.5], v: [-1, 1], iou: 1 }])) as ModelInfo['views'],
};

test('a creature uses the same frame regardless of source mesh scale and offset', async () => {
  const frames: number[][] = [];
  for (const glb of [boxGlb([1.2, 1, 0.4]), boxGlb([1.2, 1, 0.4], 0.01, [0.2, 0.4, -0.3])]) {
    const page = await open(glb);
    try {
      const result = await page.evaluate(async (info) => {
        const fig = await window.Figures.Figure3D.load(info, (f) => '/' + f);
        fig.plain();
        const canvas = fig.draw({ phase: 0, walking: false, yaw: 0.6, px: 320 });
        const copy = document.createElement('canvas'); copy.width = canvas.width; copy.height = canvas.height;
        const ctx = copy.getContext('2d')!; ctx.drawImage(canvas, 0, 0);
        const pixels = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let visible = 0, clear = 0;
        for (let i = 3; i < pixels.length; i += 4) { if (pixels[i]) visible++; else clear++; }
        const out = { frame: [canvas.width, canvas.height], visible, clear, error: canvas.getContext('webgl2')!.getError() };
        fig.dispose(); return out;
      }, info);
      expect(result.error).toBe(0);
      expect(result.visible).toBeGreaterThan(100);
      expect(result.clear).toBeGreaterThan(100);
      expect(result.frame[0]).toBeLessThan(600);
      frames.push(result.frame);
    } finally { await page.close(); }
  }
  expect(Math.abs(frames[0][0] - frames[1][0])).toBeLessThanOrEqual(1);
  expect(frames[0][1]).toBe(frames[1][1]);
}, 30_000);

test('the browser rejects an old horizontal card before allocating its oversized render target', async () => {
  const page = await open(boxGlb([1, 0.043, 1]));
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  try {
    const message = await page.evaluate(async (info) => {
      try { const fig = await window.Figures.Figure3D.load(info, (f) => '/' + f); fig.dispose(); return 'accepted'; }
      catch (e) { return (e as Error).message; }
    }, info);
    expect(message).toContain('flat:');
    expect(errors.filter((s) => /INVALID_VALUE|out of range/.test(s))).toEqual([]);
  } finally { await page.close(); }
}, 30_000);

test('an oversized draw fails before changing the canvas or producing a WebGL error', async () => {
  const page = await open(boxGlb([1.2, 1, 0.4]));
  try {
    const result = await page.evaluate(async (info) => {
      const fig = await window.Figures.Figure3D.load(info, (f) => '/' + f);
      fig.plain();
      const c = fig.draw({ phase: 0, walking: false, yaw: 0, px: 100 });
      const before = [c.width, c.height];
      let message = '';
      try { fig.draw({ phase: 0, walking: false, yaw: 0, px: 1_000_000 }); } catch (e) { message = (e as Error).message; }
      const out = { before, after: [c.width, c.height], message, error: c.getContext('webgl2')!.getError() };
      fig.dispose(); return out;
    }, info);
    expect(result.message).toContain('cannot be rendered safely');
    expect(result.after).toEqual(result.before);
    expect(result.error).toBe(0);
  } finally { await page.close(); }
}, 30_000);
