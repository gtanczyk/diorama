// The Studio's actions as MCP tools: one tool per action, same name, same input schema. The studio serves
// this over streamable HTTP at /mcp (Muse Code connects there) and `diorama mcp` over stdio.
import { actions, describeActions, runAction, type ActionContext } from '../actions/registry.ts';
import { redact } from '../secrets.ts';
import { cli } from '../cli.ts';

type Message = { jsonrpc: '2.0'; id?: string | number | null; method?: string; params?: Record<string, unknown> };
export type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string } };

const PROTOCOL = '2025-06-18';

export const INSTRUCTIONS = 'Diorama builds painted point-and-click worlds. Every tool here is a Diorama Studio action; the person sees each call '
  + 'in the Studio at once. Long work (world_build, run_step) starts a job: follow it with job_wait. Use ui_focus to show the person the '
  + 'world or place you are talking about. Keys are never available to you: if setup_status says one is missing, ask the person to run ' + cli('setup') + '.';

export function mcpTools() {
  return describeActions().map((a) => ({
    name: a.name,
    description: a.description,
    inputSchema: a.input,
    annotations: { readOnlyHint: a.reads, openWorldHint: false },
  }));
}

/** A tool that is not a Studio action (genaicode's publish_artifact): listed and called beside them. */
export type ExtraTool = { name: string; description: string; inputSchema: Record<string, unknown>; call(args: Record<string, unknown>): Promise<unknown> };

/** Answers one JSON-RPC message; null for a notification. */
/** `world`: the world the calling agent session is about; a tool call that leaves out `slug` gets it. */
/** `seen`: told of each tool call (name, arguments) and, through the function it returns, of how it ended. */
export async function handleMcp(message: Message, ctx: ActionContext, world?: string, seen?: (name: string, args: Record<string, unknown>) => (ok: boolean, result: unknown) => void, extra: readonly ExtraTool[] = []): Promise<Reply | null> {
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
      return ok({ tools: [...mcpTools(), ...extra.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))] });
    case 'tools/call': {
      const name = String(message.params?.name ?? '');
      const other = extra.find((tool) => tool.name === name);
      if (other) {
        try {
          return ok({ content: [{ type: 'text', text: String(await other.call({ ...((message.params?.arguments ?? {}) as Record<string, unknown>) })) }], isError: false });
        } catch (error) {
          return ok({ content: [{ type: 'text', text: redact(error instanceof Error ? error.message : String(error)) }], isError: true });
        }
      }
      if (!actions.has(name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `no tool ${name}` } };
      try {
        const args = { ...((message.params?.arguments ?? {}) as Record<string, unknown>) };
        if (world && args.slug === undefined && takesSlug(name)) args.slug = world;
        const settle = seen?.(name, args);
        let ran: unknown;
        try {
          ran = await runAction(name, args, ctx);
        } catch (error) {
          settle?.(false, error);
          throw error;
        }
        settle?.(true, ran);
        const { result, images } = withoutImages(ran);
        const content = [{ type: 'text', text: redact(JSON.stringify(result, null, 1)) }, ...images.map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }))];
        return ok({ content, structuredContent: wrap(result), isError: false });
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

type Image = { mimeType: string; data: string };

/** An action that shows a picture returns it as `images`: the agent gets it as image content, not as text. */
function withoutImages(result: unknown): { result: unknown; images: Image[] } {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { images?: unknown }).images)) return { result, images: [] };
  const { images, ...rest } = result as { images: Image[] };
  return { result: rest, images };
}

/** Whether a tool's input has a top-level `slug`. */
function takesSlug(name: string): boolean {
  const input = actions.get(name)?.input;
  return !!input && 'shape' in input && typeof input.shape === 'object' && input.shape !== null && 'slug' in input.shape;
}
