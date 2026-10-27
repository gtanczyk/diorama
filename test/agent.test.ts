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
  // genaicode's session state: the turn keeps what was typed, the tool and the answer.
  expect(state.turns[0].prompt).toBe('what worlds are there?');
  expect(state.turns[0].entries.some((e: { kind: string; name?: string }) => e.kind === 'tool' && e.name === 'mcp__diorama__world_list')).toBe(true);
  expect(JSON.stringify(state)).not.toContain(process.env.META_API_KEY!);
});

test('the next message resumes the same Muse session and sends only the new text', async () => {
  const seen: StudioEvent[] = [];
  const off = studio.events.subscribe((e) => seen.push(e));
  await post('api/agent/harbour/say', { text: 'and the first one?' });
  const deadline = Date.now() + 10_000;
  while (!seen.some((e) => e.type === 'agent.turn.end') && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  off();
  const message = seen.find((e) => e.type === 'agent.message') as Record<string, unknown> | undefined;
  expect(message?.text).toBe('worlds:1 no-key heard:and the first one? resumed:s1');
});

test('the agent cannot post to its own conversation', async () => {
  const res = await fetch(`${studio.url}api/agent/harbour/say`, { method: 'POST', headers: { authorization: `Bearer ${studio.agentToken}`, 'content-type': 'application/json' }, body: '{"text":"hi"}' });
  expect(res.status).toBe(404);
});

test('only the Studio\'s own MCP tools run without asking: a path with "diorama" in it is not one', async () => {
  const { readsOnly, studioTool } = await import('../src/studio/agent.ts');
  const mcp = { id: '1', kind: 'other' as const, detail: { toolName: 'mcp__diorama__world_status', subject: { kind: 'mcpTool' } } };
  const bash = { id: '2', kind: 'command' as const, summary: 'ls /Users/g/src/diorama/worlds', detail: { subject: { kind: 'shell', command: 'ls /Users/g/src/diorama/worlds' } } };
  const read = { id: '3', kind: 'other' as const, summary: '/Users/g/src/diorama/worlds/w/build.json', detail: { subject: { kind: 'fileAccess', access: 'read', path: '/Users/g/src/diorama/worlds/w/build.json' } } };
  const other = { id: '4', kind: 'other' as const, detail: { toolName: 'mcp__github__search', note: 'mcp__diorama__ mentioned in passing' } };
  expect(studioTool(mcp)).toBe(true);
  expect(studioTool(bash)).toBe(false);
  expect(studioTool(read)).toBe(false);
  expect(studioTool(other)).toBe(false);
  // Reading is let through on its own terms; the shell never is.
  expect(readsOnly(read)).toBe(true);
  expect(readsOnly(bash)).toBe(false);
  expect(readsOnly({ id: '5', kind: 'file-change', detail: { subject: { kind: 'fileAccess', access: 'write', path: 'x' } } })).toBe(false);
});

test('the agent can be switched between turns; Muse Code is the default', async () => {
  const get = async () => (await (await fetch(`${studio.url}api/agent/harbour/agents`, { headers: { authorization: `Bearer ${studio.token}` } })).json()) as Array<{ name: string; using: boolean }>;
  const offers = await get();
  expect(offers.map((o) => o.name)).toEqual(['muse', 'claude', 'codex']);
  expect(offers.find((o) => o.using)?.name).toBe('muse');
  expect((await post('api/agent/harbour/use', { name: 'codex' })).status).toBe(200);
  expect((await get()).find((o) => o.using)?.name).toBe('codex');
  expect((await post('api/agent/harbour/use', { name: 'gemini' })).status).toBe(400);
  expect((await post('api/agent/harbour/use', { name: 'muse' })).status).toBe(200);
});

test('each conversation is recorded turn by turn, so the film can replay it', async () => {
  await new Promise((r) => setTimeout(r, 400));
  const { runAction } = await import('../src/actions/registry.ts');
  await import('../src/actions/index.ts');
  const list = (await runAction('agent_sessions', { slug: 'harbour' }, { by: 'user', root, events: studio.events, jobs: studio.jobs })) as Array<{ replayable: boolean; turns: number; prompts: string[]; agents: string[] }>;
  expect(list[0]).toMatchObject({ replayable: true, agents: ['muse'] });
  expect(list[0].turns).toBeGreaterThanOrEqual(2);
  expect(list[0].prompts).toContain('what worlds are there?');
});

test('Codex gets the Studio\'s tools pre-approved, on top of whatever else the task passes', async () => {
  const { preapproved } = await import('../src/studio/agent.ts');
  const seen: unknown[] = [];
  const agent = preapproved({ name: 'codex', command: 'codex', capabilities: {}, run: (task) => (seen.push(task.extraArgs), {} as never) } as never);
  agent.run({ prompt: 'hi', cwd: '.', extraArgs: ['--x'] } as never);
  expect(seen[0]).toEqual(['--x', '-c', 'mcp_servers.diorama.default_tools_approval_mode="approve"']);
});
