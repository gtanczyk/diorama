import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { actions } from '../src/actions/registry.ts';
import { startStudio, type Studio } from '../src/studio/server.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url));
let studio: Studio;
let root: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-studio-'));
  fs.mkdirSync(path.join(root, 'foghorn', 'places', 'rock'), { recursive: true });
  fs.writeFileSync(path.join(root, 'foghorn', 'world.json'), JSON.stringify({
    title: 'Foghorn', pitch: 'The last night of a lighthouse.', style: 'gouache, muted sea colours', start: 'rock',
    hero: { key: 'wren', looks: 'a keeper in a yellow oilskin' },
    places: [{ key: 'rock', shows: 'the lighthouse rock at dusk', mood: 'calm', things: [{ key: 'door', role: 'exit', looks: 'a red door' }], exits: [] }],
  }));
  fs.writeFileSync(path.join(root, 'foghorn', 'places', 'rock', 'painting.png'), 'png');
  fs.mkdirSync(path.join(root, 'foghorn', 'memo'), { recursive: true });
  fs.writeFileSync(path.join(root, 'foghorn', 'memo', 'calls.jsonl'), '');
  process.env.META_API_KEY ??= 'meta-test-key-0123456789';
  studio = await startStudio({ root, bin: FAKE });
});
afterAll(async () => {
  await studio.close();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A raw request, so tests can send the headers a browser on another site would. */
function request(pathname: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: studio.port, path: pathname, method: opts.method ?? 'GET', headers: { host: `127.0.0.1:${studio.port}`, ...opts.headers } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end(opts.body);
  });
}
const auth = () => ({ authorization: `Bearer ${studio.token}`, 'content-type': 'application/json' });
const act = (name: string, input: object = {}, headers: Record<string, string> = {}) => request(`/api/actions/${name}`, { method: 'POST', headers: { ...auth(), ...headers }, body: JSON.stringify(input) });

test('listens on loopback only', () => {
  expect(studio.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test('refuses calls without the token, from another host, or from another site', async () => {
  expect((await request('/api/actions')).status).toBe(401);
  expect((await request('/api/actions', { headers: { authorization: 'Bearer nope' } })).status).toBe(401);
  expect((await request('/api/actions', { headers: { ...auth(), host: 'evil.example:80' } })).status).toBe(421);
  expect((await request('/api/actions', { headers: { ...auth(), origin: 'https://evil.example' } })).status).toBe(403);
  expect((await request('/api/actions', { headers: { ...auth(), 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  expect((await request('/api/actions/world_list', { method: 'POST', headers: { authorization: `Bearer ${studio.token}`, 'content-type': 'text/plain' }, body: '{}' })).status).toBe(415);
  const ok = await request('/api/actions', { headers: { ...auth(), origin: `http://127.0.0.1:${studio.port}`, 'sec-fetch-site': 'same-origin' } });
  expect(ok.status).toBe(200);
  expect(ok.headers['access-control-allow-origin']).toBeUndefined();
});

test('the page ships a strict CSP and cannot be framed', async () => {
  const page = await request('/w/foghorn');
  expect(page.status).toBe(200);
  expect(page.headers['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(page.headers['content-security-policy']).toContain("script-src 'self'");
  expect(page.body).not.toContain(studio.token);
});

test('world files need the session cookie and stay inside the world', async () => {
  expect((await request('/files/foghorn/world.json')).status).toBe(401);
  const session = await request('/api/session', { method: 'POST', headers: auth(), body: '{}' });
  const cookie = String(session.headers['set-cookie']).split(';')[0];
  expect(String(session.headers['set-cookie'])).toMatch(/HttpOnly; SameSite=Strict/);
  expect((await request('/files/foghorn/world.json', { headers: { cookie } })).status).toBe(200);
  // A literal ../ is folded by URL parsing before routing: it lands on the page, never on the file.
  expect((await request('/files/foghorn/../../etc/passwd', { headers: { cookie } })).body).not.toContain('root:');
  expect((await request('/files/foghorn/%2e%2e/%2e%2e/etc/passwd', { headers: { cookie } })).body).not.toContain('root:');
  expect((await request('/files/foghorn/places%2F..%2F..%2F..%2Fworld.json', { headers: { cookie } })).status).toBe(404);
  expect((await request('/files/foghorn/memo/calls.jsonl', { headers: { cookie } })).status).toBe(404);
});

test('every action is served over HTTP with its input schema (parity with the CLI and MCP)', async () => {
  const listed = JSON.parse((await request('/api/actions', { headers: auth() })).body) as Array<{ name: string; input: { type: string } }>;
  expect(listed.map((a) => a.name).sort()).toEqual([...actions.keys()].sort());
  for (const a of listed) expect(a.input.type).toBe('object');
  // Keys are typed in a terminal only: no action may take one.
  for (const name of actions.keys()) expect(name).not.toMatch(/key|secret|token/);
});

test('actions validate input and report errors without leaking keys', async () => {
  expect((await act('world_status', { slug: '../etc' })).status).toBe(400);
  expect((await act('nope')).status).toBe(404);
  const status = JSON.parse((await act('world_status', { slug: 'foghorn' })).body).result;
  expect(status.title).toBe('Foghorn');
  expect(status.placeDetail[0].image.file).toBe('places/rock/painting.png');
  const setup = JSON.parse((await act('setup_status')).body).result as Array<{ id: string; detail: string }>;
  expect(JSON.stringify(setup)).not.toContain(process.env.META_API_KEY);
});

test('a job streams step events and redacted output to the live feed, tagged with who asked', async () => {
  const seen: Array<{ type: string; [k: string]: unknown }> = [];
  const off = studio.events.subscribe((e) => seen.push(e));
  const res = await act('run_step', { slug: 'foghorn', step: 'layout' }, { authorization: `Bearer ${studio.agentToken}` });
  expect(res.status).toBe(200);
  const job = JSON.parse(res.body).result;
  const done = await studio.jobs.wait(job.id);
  off();
  expect(done.state).toBe('done');
  expect(seen.find((e) => e.type === 'action.start')).toMatchObject({ action: 'run_step', by: 'agent', world: 'foghorn' });
  expect(seen.map((e) => e.type)).toEqual(expect.arrayContaining(['job.start', 'step.start', 'step.end', 'job.end']));
  const log = seen.filter((e) => e.type === 'log').map((e) => e.line).join('\n');
  expect(log).toContain('laying out foghorn with key [redacted]');
  expect(log).not.toContain(process.env.META_API_KEY);
});

test('the event stream replays what a client missed and carries file changes', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${studio.url}api/events?world=foghorn&since=0`, { headers: { authorization: `Bearer ${studio.token}` }, signal: ctrl.signal });
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let text = '';
  const until = async (needle: string) => {
    const deadline = Date.now() + 4000;
    while (!text.includes(needle) && Date.now() < deadline) text += (await reader.read()).value ?? '';
    return text.includes(needle);
  };
  expect(await until(': ready')).toBe(true);
  expect(text).toContain('"type":"job.end"');
  setTimeout(() => fs.writeFileSync(path.join(root, 'foghorn', 'places', 'rock', 'layout.json'), '{}'), 100);
  expect(await until('places/rock/layout.json')).toBe(true);
  setTimeout(() => fs.appendFileSync(path.join(root, 'foghorn', 'memo', 'calls.jsonl'), '{"model":"muse","label":"paint rock","ms":900,"hit":false}\n'), 100);
  expect(await until('"type":"call"')).toBe(true);
  ctrl.abort();
});

test('one job per world at a time; the next waits and can be cancelled', async () => {
  const first = studio.jobs.start('foghorn', ['sleep', 'foghorn'], 'slow', 'user');
  const second = studio.jobs.start('foghorn', ['build', 'foghorn'], 'next', 'user');
  expect(studio.jobs.get(second.id)!.state).toBe('queued');
  expect(studio.jobs.cancel(second.id).state).toBe('cancelled');
  studio.jobs.cancel(first.id);
  expect((await studio.jobs.wait(first.id)).state).toBe('cancelled');
});

const mcp = (body: unknown, token = studio.agentToken) => request('/mcp', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('MCP over HTTP: the agent token only, every action a tool, calls tagged as the agent', async () => {
  expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, studio.token)).status).toBe(401);
  const init = JSON.parse((await mcp({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).body);
  expect(init.result.serverInfo.name).toBe('diorama');
  expect((await mcp({ jsonrpc: '2.0', method: 'notifications/initialized' })).status).toBe(202);
  const tools = JSON.parse((await mcp({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).body).result.tools as Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }>;
  expect(tools.map((t) => t.name).sort()).toEqual([...actions.keys()].sort());
  expect(tools.find((t) => t.name === 'world_status')!.annotations.readOnlyHint).toBe(true);
  expect(tools.find((t) => t.name === 'world_build')!.annotations.readOnlyHint).toBe(false);
  const seen: Array<{ type: string; by?: unknown }> = [];
  const off = studio.events.subscribe((e) => seen.push(e));
  const call = JSON.parse((await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'world_status', arguments: { slug: 'foghorn' } } })).body);
  off();
  expect(call.result.isError).toBe(false);
  expect(call.result.structuredContent.title).toBe('Foghorn');
  expect(seen.find((e) => e.type === 'action.start')?.by).toBe('agent');
  const bad = JSON.parse((await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'world_status', arguments: { slug: 'Nope!' } } })).body);
  expect(bad.result.isError).toBe(true);
});

test('job_wait answers when the job ends, with its last lines', async () => {
  const job = studio.jobs.start('foghorn', ['build', 'foghorn'], 'quick', 'agent');
  const call = JSON.parse((await mcp({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'job_wait', arguments: { id: job.id, timeoutSeconds: 20 } } })).body);
  expect(call.result.structuredContent.state).toBe('done');
  expect(call.result.structuredContent.tail.join('\n')).toContain('laying out foghorn');
});
