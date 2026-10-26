// One definition per action: name, what it does, its input (zod) and run(). From that single entry come the
// studio's POST /api/actions/<name>, the Muse Code tool of the same name (diorama mcp) and
// `diorama action <name> '<json>'`, so nothing the GUI can do is out of reach of a prompt.
import { z } from 'zod';
import type { Events } from '../studio/events.ts';
import type { Jobs } from '../studio/jobs.ts';

export type ActionContext = {
  /** Who asked: the person in the GUI, the agent through MCP, or someone at a terminal. */
  by: 'user' | 'agent' | 'cli';
  /** Where worlds live (worlds/ under the working directory). */
  root: string;
  jobs: Jobs;
  events: Events;
};

export type Action<I extends z.ZodTypeAny = z.ZodTypeAny> = {
  name: string;
  description: string;
  input: I;
  /** Starts work that outlives the call (a job), rather than answering right away. */
  job?: boolean;
  /** Only reads: the activity log leaves it out, since the page itself polls these. */
  reads?: boolean;
  run(input: z.infer<I>, ctx: ActionContext): Promise<unknown>;
};

export const actions = new Map<string, Action>();

export function defineAction<I extends z.ZodTypeAny>(action: Action<I>) {
  if (!/^[a-z][a-z0-9_]*$/.test(action.name)) throw new Error(`action names are snake_case: ${action.name}`);
  actions.set(action.name, action as Action);
}

/** Validates, runs and announces an action; every caller goes through here, so the feed sees all of them. */
export async function runAction(name: string, raw: unknown, ctx: ActionContext): Promise<unknown> {
  const action = actions.get(name);
  if (!action) throw new ActionError(404, `no action ${name}; try one of ${[...actions.keys()].join(', ')}`);
  const parsed = action.input.safeParse(raw ?? {});
  if (!parsed.success) throw new ActionError(400, `${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
  const world = (parsed.data as { slug?: string }).slug;
  ctx.events.publish('action.start', { action: name, by: ctx.by, world, input: parsed.data });
  try {
    const result = await action.run(parsed.data, ctx);
    ctx.events.publish('action.end', { action: name, by: ctx.by, world, ok: true });
    return result;
  } catch (error) {
    ctx.events.publish('action.end', { action: name, by: ctx.by, world, ok: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export class ActionError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** The JSON schema of an action's input, for MCP tool listings and the GUI. */
export function describeActions() {
  return [...actions.values()].map((a) => ({ name: a.name, description: a.description, job: !!a.job, reads: !!a.reads, input: zodToJson(a.input) }));
}

/** Enough of JSON Schema for flat action inputs: objects of strings, numbers, booleans, enums and arrays. */
export function zodToJson(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName: string; description?: string };
  const withDesc = (out: Record<string, unknown>) => (schema.description ? { ...out, description: schema.description } : out);
  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const required = Object.entries(shape).filter(([, v]) => !(v as z.ZodTypeAny).isOptional()).map(([k]) => k);
      return withDesc({ type: 'object', properties: Object.fromEntries(Object.entries(shape).map(([k, v]) => [k, zodToJson(v as z.ZodTypeAny)])), required, additionalProperties: false });
    }
    case 'ZodString': return withDesc({ type: 'string' });
    case 'ZodNumber': return withDesc({ type: 'number' });
    case 'ZodBoolean': return withDesc({ type: 'boolean' });
    case 'ZodEnum': return withDesc({ type: 'string', enum: (schema as z.ZodEnum<[string]>).options });
    case 'ZodArray': return withDesc({ type: 'array', items: zodToJson((schema as z.ZodArray<z.ZodTypeAny>).element) });
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = def.typeName === 'ZodOptional' ? (schema as z.ZodOptional<z.ZodTypeAny>).unwrap() : (schema as z.ZodDefault<z.ZodTypeAny>).removeDefault();
      return { ...zodToJson(inner), ...(schema.description && { description: schema.description }) };
    }
    default: return withDesc({});
  }
}
