import { build } from 'esbuild';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';

test('hover and mouse focus do not speak an answer, but keyboard navigation can read it', async () => {
  const source = (await build({ entryPoints: ['app/web/ui.ts'], bundle: true, format: 'iife', globalName: 'GameUI', write: false })).outputFiles[0].text;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent('<div id="talk"></div>');
    await page.addScriptTag({ content: source });
    await page.evaluate(() => {
      const w = window as any;
      w.heard = [];
      w.picked = 0;
      w.answers = new w.GameUI.Answers();
      w.answers.hear = (text: string) => w.heard.push(text);
      w.answers.show([{ text: 'Hello!', pick: () => w.picked++ }]);
    });
    const card = page.locator('#talk .answer');
    await card.hover();
    await page.mouse.move(0, 0);
    await card.hover();
    await card.focus();
    expect(await page.evaluate(() => (window as any).heard)).toEqual([]);
    await page.evaluate(() => (window as any).answers.move(1, true));
    expect(await page.evaluate(() => (window as any).heard)).toEqual(['Hello!']);
    await card.click();
    expect(await page.evaluate(() => (window as any).picked)).toBe(1);
  } finally { await browser.close(); }
}, 30_000);
