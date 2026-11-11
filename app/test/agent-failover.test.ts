import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { agentFallback, withModel } from '../src/studio/agent.ts';
import { startStudio, type Studio } from '../src/studio/server.ts';
import type { StudioEvent } from '../src/studio/events.ts';

const MUSE = fileURLToPath(new URL('./fixtures/fake-muse.mjs', import.meta.url));
let studio: Studio;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-failover-'));
  fs.mkdirSync(path.join(root, 'harbour'), { recursive: true });
  process.env.META_API_KEY ??= 'meta-test-key-0123456789';
  // The world talks with Antigravity, whose CLI is not there: its turn fails as `unavailable`.
  vi.stubEnv('DIORAMA_AGENT', 'antigravity');
  vi.stubEnv('DIORAMA_AGY_COMMAND', path.join(root, 'no-agy'));
  studio = await startStudio({ root, muse: MUSE });
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await studio.close();
  fs.rmSync(root, { recursive: true, force: true });
});

const auth = () => ({ authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' });
const post = (p: string, body: object) => fetch(`${studio.url}${p}`, { method: 'POST', headers: auth(), body: JSON.stringify(body) });

test('agentFallback: the env list first, else the saved one; unknown names and repeats dropped', () => {
  expect(agentFallback(['claude'], { DIORAMA_AGENT_FALLBACK: 'codex, muse,gemini,codex' })).toEqual(['codex', 'muse']);
  expect(agentFallback(['claude', 'nope', 'muse'], {})).toEqual(['claude', 'muse']);
  expect(agentFallback(undefined, { DIORAMA_AGENT_FALLBACK: ' ' })).toEqual([]);
  expect(agentFallback('claude', {})).toEqual([]);
});

test('withModel: a turn that names no model gets the agent\'s own', () => {
  const seen: unknown[] = [];
  const agent = withModel({ name: 'claude', command: 'claude', capabilities: {}, run: (task: { model?: string }) => (seen.push(task.model), {} as never) } as never, 'opus');
  agent.run({ prompt: 'hi', cwd: '.' } as never);
  agent.run({ prompt: 'hi', cwd: '.', model: 'sonnet' } as never);
  expect(seen).toEqual(['opus', 'sonnet']);
});

test('Setup picks the failover agents; an agent that is out hands the request to the next, briefed', async () => {
  const defaults = async () => (await (await fetch(`${studio.url}api/agent-default`, { headers: auth() })).json()) as { fallback: string[]; fallbackEnv: string | null };
  expect((await defaults()).fallback).toEqual([]);
  expect((await post('api/agent-default', { fallback: ['gemini'] })).status).toBe(400);
  expect((await post('api/agent-default', { fallback: 'muse' })).status).toBe(400);
  expect((await post('api/agent-default', { fallback: ['muse'] })).status).toBe(200);
  expect(await defaults()).toMatchObject({ fallback: ['muse'], fallbackEnv: null });

  const seen: StudioEvent[] = [];
  const off = studio.events.subscribe((e) => seen.push(e));
  expect((await post('api/agent/harbour/say', { text: 'what worlds are there?' })).status).toBe(200);
  const deadline = Date.now() + 15_000;
  while (!seen.some((e) => e.type === 'agent.message') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 100));
  off();
  const failover = seen.find((e) => e.type === 'agent.failover') as Record<string, unknown> | undefined;
  expect(failover).toMatchObject({ world: 'harbour', to: 'muse', kind: 'unavailable' });
  // Muse took the request over with the brief, so it heard the person's words.
  expect((seen.find((e) => e.type === 'agent.message') as Record<string, unknown>).text).toMatch(/^worlds:1 no-key heard:what worlds are there\?/);
  // The world stays with Muse, and the conversation file says who took over.
  const offers = (await (await fetch(`${studio.url}api/agent/harbour/agents`, { headers: auth() })).json()) as Array<{ name: string; using: boolean }>;
  expect(offers.find((o) => o.using)?.name).toBe('muse');
  expect(fs.readFileSync(path.join(root, 'harbour', 'studio', 'conversation.md'), 'utf8')).toContain('handed over from Antigravity to Muse Code');
});
