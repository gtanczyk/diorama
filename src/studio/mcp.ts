// The Studio's actions as MCP tools: one tool per action, same name, same input schema. The studio serves
// this over streamable HTTP at /mcp (Muse Code connects there) and `diorama mcp` over stdio.
import { actions, describeActions, runAction, type ActionContext } from '../actions/registry.ts';
import { redact } from '../secrets.ts';

type Message = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };
export type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const PROTOCOL = '2025-06-18';

export const INSTRUCTIONS = 'Diorama builds painted point-and-click worlds. Every tool here is a Diorama Studio action; the person sees each call '
  + 'in the Studio at once. Long work (world_build, run_step) starts a job: follow it with job_wait. Use ui_focus to show the person the '
  + 'world or place you are talking about. Keys are never available to you: if setup_status says one is missing, ask the person to run diorama setup.';

export function mcpTools() {
  return describeActions().map((a) => ({
    name: a.name,
    description: a.description,
    inputSchema: a.input,
    annotations: { readOnlyHint: a.reads, openWorldHint: false },
  }));
}

/** Answers one JSON-RPC message; null for a notification. */
export async function handleMcp(message: Message, ctx: ActionContext): Promise<Reply | null> {
  if (message.id === undefined || message.id === null) return null;
  const id = message.id;
  const ok = (result: unknown): Reply => ({ jsonrpc: '2.0', id, result });
  switch (message.method) {
    case 'initialize':
      return ok({
        protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'diorama', version: '0.1.0' },
        instructions: INSTRUCTIONS,
      });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: mcpTools() });
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      if (!actions.has(name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `no tool ${name}` } };
      try {
        const result = await runAction(name, message.params?.arguments ?? {}, ctx);
        return ok({ content: [{ type: 'text', text: redact(JSON.stringify(result, null, 1)) }], structuredContent: wrap(result), isError: false });
      } catch (error) {
        return ok({ content: [{ type: 'text', text: redact(error instanceof Error ? error.message : String(error)) }], isError: true });
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${message.method}` } };
  }
}

/** structuredContent must be an object. */
const wrap = (result: unknown) => (result && typeof result === 'object' && !Array.isArray(result) ? result : { result });
