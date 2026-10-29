import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { earlier, pastTurns } from '../src/studio/agent.ts';

test('a fresh agent session is pointed at the conversation so far, and only when there is one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-convo-'));
  try {
    expect(earlier(dir)).toBe('');
    fs.mkdirSync(path.join(dir, 'studio'));
    fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), '');
    expect(earlier(dir)).toBe('');
    fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), '## 2026-10-28 09:00 · muse\n\n**Person:** the hero walks into the table\n');
    expect(earlier(dir)).toContain('studio/conversation.md');
    // The turns themselves are in the brief: an agent that keeps to the Studio's tools never opens the file.
    expect(earlier(dir)).toContain('the hero walks into the table');
    const turns = Array.from({ length: 80 }, (_, i) => `## 2026-10-28 09:${String(i % 60).padStart(2, '0')} · muse\n\n**Person:** ask number ${i} ${'x'.repeat(150)}\n\n`).join('');
    fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), turns);
    const brief = earlier(dir);
    expect(brief).toContain('ask number 79');
    expect(brief).not.toContain('ask number 0 ');
    expect(brief).toMatch(/<conversation>\n## /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('after a restart the page gets the earlier turns back from the session logs, cut-off ones ended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-past-'));
  const turn = (id: number, text: string, extra = {}) => ({ id, agent: 'muse', prompt: `ask ${id}`, startedAt: id, entries: [{ kind: 'text', text, streaming: true }, { kind: 'tool', name: 'x', done: false }], ...extra });
  const line = (t: object) => JSON.stringify({ at: 'now', type: 'state', agent: 'muse', status: 'idle', turn: t });
  try {
    expect(pastTurns(dir)).toEqual([]);
    fs.mkdirSync(path.join(dir, 'studio', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'studio', 'sessions', '20261028T0900-aa.jsonl'), [line(turn(1, 'th')), line(turn(1, 'the end', { endedAt: 5 })), JSON.stringify({ type: 'user', text: 'x' }), 'not json'].join('\n'));
    fs.writeFileSync(path.join(dir, 'studio', 'sessions', '20261028T0900-00.jsonl'), line(turn(1, 'cut off', { startedAt: 10 })));
    const past = pastTurns(dir);
    expect(past.map((t) => t.prompt)).toEqual(['ask 1', 'ask 1']);
    expect(past.map((t) => t.id)).toEqual([-2, -1]);
    expect(past[0].entries[0]).toMatchObject({ text: 'the end', streaming: false });
    expect(past[1].endedAt).toBe(10);
    expect(past[1].result?.status).toBe('aborted');
    expect(past[1].entries[1]).toMatchObject({ done: true });
    expect(pastTurns(dir, 1).map((t) => (t.entries[0] as { text: string }).text)).toEqual(['cut off']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the visible conversation survives a server restart and continues without losing or duplicating turns', async () => {
  const { chromium } = await import('playwright');
  const { startStudio } = await import('../src/studio/server.ts');
  const { scene } = await import('./fixtures/scene.ts');
  const { fileURLToPath } = await import('node:url');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-conversation-restart-'));
  const { dir } = await scene(root);
  const muse = fileURLToPath(new URL('./fixtures/fake-muse.mjs', import.meta.url));
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let studio = await startStudio({ root, muse });
  const open = async () => {
    await page.goto(`${studio.url}w/w#${studio.token}`);
    await page.locator('section.agent textarea').waitFor();
  };
  const send = async (text: string) => {
    await page.locator('section.agent textarea').fill(text);
    await page.locator('section.agent textarea').press('Enter');
    await expect.poll(async () => {
      const res = await fetch(`${studio.url}api/agent/w`, { headers: { authorization: `Bearer ${studio.token}` } });
      const turn = (await res.json())?.turns.at(-1);
      return turn?.prompt === text ? turn.result?.status : undefined;
    }, { timeout: 10_000 }).toBe('completed');
  };
  try {
    await open(); await send('Remember cobalt blue.');
    // No throttle sleep: an answered turn must already be durable.
    expect(pastTurns(dir).map((t) => t.prompt)).toEqual(['Remember cobalt blue.']);
    await page.goto('about:blank'); await studio.close();
    studio = await startStudio({ root, muse });
    await open();
    await expect.poll(() => page.locator('section.agent').innerText()).toContain('heard:Remember cobalt blue.');
    await send('Continue with that colour.');
    await expect.poll(() => page.locator('section.agent').innerText()).toContain('heard:Continue with that colour. with-history');
    await page.goto('about:blank'); await studio.close();
    studio = await startStudio({ root, muse });
    await open();
    await expect.poll(() => page.locator('section.agent').innerText()).toContain('heard:Continue with that colour.');
    const state = await (await fetch(`${studio.url}api/agent/w`, { headers: { authorization: `Bearer ${studio.token}` } })).json();
    expect(state.turns.map((t: { prompt: string }) => t.prompt)).toEqual(['Remember cobalt blue.', 'Continue with that colour.']);
    expect(new Set(state.turns.map((t: { id: number }) => t.id)).size).toBe(2);
  } finally { await browser.close(); await studio.close(); fs.rmSync(root, { recursive: true, force: true }); }
}, 60_000);
