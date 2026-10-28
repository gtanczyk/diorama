#!/usr/bin/env node
// Stands in for `muse serve` in studio tests: speaks the JSON-RPC genaicode's museLive() uses, and on each
// turn calls the Studio's MCP tool world_list through the server the -c overrides name, as Muse would.
import readline from 'node:readline';

const args = process.argv.slice(2);
const conf = {};
for (let i = 0; i < args.length; i++) if (args[i] === '-c') {
  const [key, ...rest] = args[++i].split('=');
  conf[key] = JSON.parse(rest.join('=').replace(/\$\{(\w+)\}/g, (_, v) => process.env[v] ?? ''));
}
const url = conf['mcp_servers.diorama.url'];
const auth = conf['mcp_servers.diorama.headers.Authorization'];
let resumed = '';
const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const notify = (method, params) => send({ method, params });

async function turn(sessionId, turnId, text) {
  notify('item/started', { sessionId, item: { kind: 'mcpToolCall', itemId: 'i1', tool: 'mcp__diorama__world_list' } });
  const res = await fetch(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'world_list', arguments: {} } }) });
  const body = await res.json();
  const worlds = body.result?.structuredContent?.result?.length ?? 'error';
  notify('item/completed', { sessionId, item: { kind: 'mcpToolCall', itemId: 'i1', tool: 'mcp__diorama__world_list', status: 'completed' } });
  const keys = process.env.META_API_KEY ? 'has-key' : 'no-key';
  notify('item/completed', { sessionId, item: { kind: 'agentMessage', itemId: 'm1', text: `worlds:${worlds} ${keys} heard:${text.split('Person: ').pop()}${resumed}` } });
  notify('turn/completed', { sessionId, turnId, terminal: 'completed' });
}

for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === 'initialize') send({ id: m.id, result: {} });
  else if (m.method === 'session/resume') {
    resumed = ` resumed:${m.params.sessionId}`;
    send({ id: m.id, result: { session: { sessionId: m.params.sessionId } } });
  } else if (m.method === 'session/start') send({ id: m.id, result: { session: { sessionId: 's1' } } });
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turnId: 't1' } });
    setTimeout(() => turn('s1', 't1', m.params.input[0].text), 50);
  } else if (m.method === 'turn/steer') send({ id: m.id, result: { turnId: 't1' } });
  else if (m.id !== undefined) send({ id: m.id, error: { code: -32601, message: 'no' } });
}
