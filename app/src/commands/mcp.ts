// diorama mcp: the Studio's actions as an MCP server over stdio, for Muse Code (or any MCP client) started
// by hand. With a Studio running for this folder it forwards every call there, so the page shows the agent's
// work live; without one it runs the actions itself.
import path from 'node:path';
import readline from 'node:readline';
import '../actions/index.ts';
import { defineCommand } from '../registry.ts';
import { Events } from '../studio/events.ts';
import { Jobs } from '../studio/jobs.ts';
import { handleMcp, type Reply } from '../studio/mcp.ts';
import { readStudioFile } from '../studio/discovery.ts';

defineCommand({
  name: 'mcp',
  usage: 'mcp                     serve the Studio actions as MCP tools on stdio (forwards to a running diorama studio)',
  async run() {
    const studio = readStudioFile(process.cwd());
    const events = new Events();
    const ctx = { by: 'agent' as const, root: path.resolve('worlds'), events, jobs: new Jobs(events) };
    const out = (reply: Reply | Reply[] | null) => reply && process.stdout.write(`${JSON.stringify(reply)}\n`);
    // Logs go to stderr: stdout carries only protocol messages.
    console.error(studio ? `diorama mcp: forwarding to the Studio at ${studio.url}` : 'diorama mcp: no Studio running here, running actions in this process');
    const lines = readline.createInterface({ input: process.stdin });
    for await (const line of lines) {
      if (!line.trim()) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
        continue;
      }
      if (studio) {
        const res = await fetch(`${studio.url}mcp`, {
          method: 'POST',
          headers: { authorization: `Bearer ${studio.agentToken}`, 'content-type': 'application/json' },
          body: line,
        }).catch((error: Error) => ({ ok: false, status: 0, text: async () => error.message }));
        if (res.status === 202) continue;
        const text = await res.text();
        if (res.ok) process.stdout.write(`${text}\n`);
        else out({ jsonrpc: '2.0', id: (message as { id?: string | number }).id ?? null, error: { code: -32603, message: `the Studio answered ${res.status}: ${text.slice(0, 200)}` } });
        continue;
      }
      if (Array.isArray(message)) out((await Promise.all(message.map((m) => handleMcp(m, ctx)))).filter((r): r is Reply => !!r));
      else out(await handleMcp(message as Parameters<typeof handleMcp>[0], ctx));
    }
    ctx.jobs.stopAll();
  },
});
