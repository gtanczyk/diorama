import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { expect, test } from 'vitest';
import { serveWorld } from '../src/commands/play.ts';
import { Story } from '../src/story/schema.ts';
import { WorldFiles } from '../src/world/files.ts';
import { scene } from './fixtures/scene.ts';

test('quick choices interrupt speech and discard stale replies, while goodbye interrupts the current line', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-dialogue-'));
  const { put } = await scene(root, true);
  put('story.json', Story.parse({ intro: 'Start.', items: [], interactions: [], endings: [{ key: 'end', title: 'End', text: 'End.' }], dialogues: [{
    place: 'room', npc: 'guard', start: 'start', lines: [
      { key: 'start', says: 'Old greeting.', choices: [{ text: 'First answer.', next: 'middle' }] },
      { key: 'middle', says: 'Old reply.', choices: [{ text: 'Second answer.', next: 'last' }] },
      { key: 'last', says: 'Current reply.', choices: [] },
    ],
  }] }));
  const server = await serveWorld(new WorldFiles('w', root), 0);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?place=room&capture=1&sound=0`);
    await page.waitForFunction('window.diorama?.place && window.diorama.dark === 0');
    await page.evaluate(() => {
      const w = window as any;
      w.said = [];
      w.diorama.on((event: string, detail: { text: string }) => { if (event === 'say') w.said.push(detail.text); });
      void w.diorama.act({ kind: 'talk', npc: 'guard' });
    });
    await page.waitForFunction('window.diorama.speech?.text === "Old greeting."');
    await page.locator('#talk .answer').click();
    await page.waitForFunction('window.diorama.speech?.text === "First answer."');
    await page.locator('#talk .answer').click();
    await page.waitForFunction('window.diorama.speech?.text === "Second answer."');
    await page.evaluate(() => { (window as any).diorama.time += 100; });
    await page.waitForFunction('window.diorama.speech?.text === "Current reply."');
    await page.locator('#talk .answer').click();
    await page.waitForFunction('window.diorama.speech?.text === "Goodbye."');
    expect(await page.evaluate(() => (window as any).said)).toEqual(['Old greeting.', 'First answer.', 'Second answer.', 'Current reply.', 'Goodbye.']);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
