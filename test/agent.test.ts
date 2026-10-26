import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startStudio, type Studio } from '../src/studio/server.ts';
import type { StudioEvent } from '../src/studio/events.ts';

const MUSE = fileURLToPath(new URL('./fixtures/fake-muse.mjs', import.meta.url));
let studio: Studio;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-agent-'));
  fs.mkdirSync(path.join(root, 'harbour'), { recursive: true });
  process.env.META_API_KEY ??= 'meta-test-key-0123456789';
  studio = await startStudio({ root, muse: MUSE });
});
afterAll(async () => {
  await studio.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const post = (p: string, body: object) => fetch(`${studio.url}${p}`, { method: 'POST', headers: { authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('a message runs Muse with the Studio MCP server, without keys, and its tool calls show as the agent', async () => {
  const seen: StudioEvent[] = [];
  const off = studio.events.subscribe((e) => seen.push(e));
  expect((await post('api/agent/harbour/say', { text: 'what worlds are there?' })).status).toBe(200);
  const deadline = Date.now() + 10_000;
  // The turn has ended once an agent event carries its status.
  while (!seen.some((e) => e.type === 'agent.turn.end') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  off();
  const agent = seen.filter((e) => e.type.startsWith('agent.')).map((e) => e as Record<string, unknown>);
  const message = agent.find((e) => String(e.text ?? '').startsWith('worlds:'));
  expect(message?.text).toBe('worlds:1 no-key heard:what worlds are there?');
  expect(agent.some((e) => e.type === 'agent.tool' && e.name === 'world_list')).toBe(true);
  expect(seen.find((e) => e.type === 'agent.turn.end')).toMatchObject({ status: 'completed' });
  expect(seen.find((e) => e.type === 'action.start')).toMatchObject({ action: 'world_list', by: 'agent' });
  // The session is logged for replay.
  const logs = fs.readdirSync(path.join(root, 'harbour', 'studio', 'sessions'));
  expect(fs.readFileSync(path.join(root, 'harbour', 'studio', 'sessions', logs[0]), 'utf8')).toContain('worlds:1');
  const state = await (await fetch(`${studio.url}api/agent/harbour`, { headers: { authorization: `Bearer ${studio.token}` } })).json();
  expect(state.turns.map((t: { role: string }) => t.role)).toEqual(['user', 'agent']);
});

test('the agent cannot post to its own conversation', async () => {
  const res = await fetch(`${studio.url}api/agent/harbour/say`, { method: 'POST', headers: { authorization: `Bearer ${studio.agentToken}`, 'content-type': 'application/json' }, body: '{"text":"hi"}' });
  expect(res.status).toBe(404);
});
