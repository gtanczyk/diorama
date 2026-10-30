import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { serveWorld } from '../src/commands/play.ts';
import { exportWorld } from '../src/commands/export.ts';
import { reactionInput } from '../src/commands/reactions.ts';
import { bindReactions, ReactionPlan } from '../src/scene/reactions.ts';
import { WorldFiles } from '../src/world/files.ts';
import { scene } from './fixtures/scene.ts';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

test.each([false, true])('real runtime: movement/entry/interaction without audio; reduced motion=%s', async (reduced) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reactions-browser-'));
  const { put } = await scene(root);
  const files = new WorldFiles('w', root);
  const burst = { kind: 'dust', colour: '#9a764a', strength: .6 };
  const plan = ReactionPlan.parse({ scene: 'test dusty patch', areas: [{ key: 'patch', floor: 'floor', polygon: [[480, 600], [600, 600], [600, 800], [480, 800]], step: burst, enter: burst }], interactions: [{ key: 'take-token', interaction: 0, at: [.5, .5], burst }] });
  put('places/room/reactions.json', bindReactions(plan, reactionInput(files, 'room')));
  const server = await serveWorld(files, 0);
  const page = await browser.newPage({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}/?place=room&capture=1&sound=0`);
    await page.waitForFunction('window.diorama?.place && window.diorama.dark === 0');
    expect(await page.evaluate('window.diorama.place.reactions.counts')).toEqual({ step: 0, enter: 0, interaction: 0 });
    await page.evaluate('window.diorama.walkTo(530, 700)');
    const counts = await page.evaluate<{ step: number; enter: number; interaction: number }>('window.diorama.place.reactions.counts');
    expect(counts.enter).toBe(1); expect(counts.step).toBeGreaterThan(0);
    if (reduced) expect(await page.evaluate('window.diorama.place.reactions.particles.length')).toBe(0);
    await page.evaluate('window.diorama.wait(1000)');
    expect(await page.evaluate('window.diorama.place.reactions.counts')).toEqual(counts);
    expect(await page.evaluate('window.diorama.place.reactions.particles.length')).toBe(0);
    // Looking and a failed use do not replay the take reaction.
    await page.evaluate('window.diorama.use("token", "look")');
    await page.evaluate('window.diorama.use("token", "use")');
    expect(await page.evaluate('window.diorama.place.reactions.counts.interaction')).toBe(0);
    await page.evaluate('window.diorama.use("token", "take")');
    expect(await page.evaluate('window.diorama.place.reactions.counts.interaction')).toBe(1);
    expect(await page.evaluate('window.diorama.state.items')).toContain('token');
    await page.evaluate('window.diorama.enter("room")');
    expect(await page.evaluate('window.diorama.place.reactions.particles.length')).toBe(0);
    expect(errors).toEqual([]);
    const out = path.join(root, 'export');
    await exportWorld(files.dir, out);
    const exported = JSON.parse(fs.readFileSync(path.join(out, 'world-data.json'), 'utf8'));
    expect(exported.places.room.reactions.areas).toHaveLength(1);
    expect(exported.places.room.reactions.interactions).toHaveLength(1);
  } finally {
    await page.close(); await new Promise<void>((r) => server.close(() => r()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
