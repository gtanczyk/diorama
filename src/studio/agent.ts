// The Muse Code agent in the Studio: one conversation per world, driven through genaicode's museLive()
// (`muse serve`). It works only through the Studio's MCP tools, so each of its moves shows up in the page
// like a click would. It gets no provider key: its environment is scrubbed and Muse uses its own login.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { museLive, withoutProviderCredentials, type AgentEvent, type AgentRun, type ApprovalDecision, type ApprovalRequest } from 'genaicode/agents';
import { redact, withoutSecrets } from '../secrets.ts';
import type { Events } from './events.ts';

export const AGENT_BRIEF = (slug: string) => `You are the Muse Code agent inside Diorama Studio, working on the world "${slug}" with the person.
Use only the diorama MCP tools: they are the same actions as the Studio's buttons, and the person watches each call live.
Start long work with world_build or run_step and follow it with job_wait. Call ui_focus to show the place you are talking about.
Every place moves as a diorama (the backdrop step: cut-out things over a painted backdrop, far flats, flowing water). When the person says the water runs the wrong way or should stand still, call water_flow (reverse, still, or auto with a hint in their words), then show the place; never edit files by hand.
To fix a place use the fix tools, which are kept across rebuilds: mask_fix (a better SAM phrase, the real box, or the kind of a thing), floor_cells, mask_brush, stand_set, repaint_region (costs a Muse edit); corrections_get shows what is fixed already, corrections_clear takes fixes back. When asked to go through the person's notes, read feedback_pending, fix each one and close it with feedback_done in one sentence. Check budget before a rebuild of many places.
Before a risky change, say what you will do; history_undo can take back a job. Respect locks. Keys are never yours: if a key is missing, ask the person to run \`diorama setup\` in a terminal.
You have no shell and no file tools here: Muse's own bash, read_file and edits are refused. Everything you need to know comes from world_status, place_status, job_wait, corrections_get and feedback_pending.
Answer briefly, in the person's language.`;

type Turn = { role: 'user' | 'agent'; text: string };
type Card = { id: string; kind: ApprovalRequest['kind']; summary?: string; detail?: string };
type Pending = { card: Card; resolve: (d: ApprovalDecision) => void };

const clip = (v: unknown, n: number) => {
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > n ? `${text.slice(0, n)}…` : text;
};

/** What the approval card shows: the summary and the request itself, shortened and with secrets blanked. */
function card(request: ApprovalRequest): Card {
  const detail = request.detail === undefined ? undefined : redact(typeof request.detail === 'string' ? request.detail : JSON.stringify(request.detail, null, 1));
  return { id: request.id, kind: request.kind, ...(request.summary && { summary: redact(request.summary) }), ...(detail && { detail: detail.length > 600 ? `${detail.slice(0, 600)}…` : detail }) };
}

/**
 * A call of one of the Studio's MCP tools: not a shell, process or file access, and named for the diorama
 * server. A path that merely contains "diorama" (every world lives under it) is not enough.
 */
export function studioTool(request: ApprovalRequest): boolean {
  if (request.kind !== 'other') return false;
  const detail = (request.detail ?? {}) as { subject?: { kind?: string } };
  if (['shell', 'process', 'fileAccess'].includes(String(detail.subject?.kind))) return false;
  const text = JSON.stringify(detail);
  return /"mcp__diorama__[a-z_]+"/.test(text) || /"(server|serverName|mcpServer)"\s*:\s*"diorama"/.test(text);
}

class Conversation {
  run: AgentRun | null = null;
  readonly turns: Turn[] = [];
  /** Muse's own session id, to resume the conversation in the next turn. */
  session: string | null = null;
  readonly approvals = new Map<string, Pending>();
  readonly log: string;

  constructor(readonly slug: string, readonly dir: string) {
    const id = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    this.log = path.join(dir, 'studio', 'sessions', `${id}-${randomBytes(2).toString('hex')}.jsonl`);
  }
}

export class AgentHub {
  private readonly talks = new Map<string, Conversation>();

  constructor(
    private readonly events: Events,
    private readonly opts: { root: string; mcpUrl: string; agentToken: string; command?: string },
  ) {}

  state(slug: string) {
    const c = this.talks.get(slug);
    return { seq: this.events.last, running: !!c?.run, turns: c?.turns ?? [], approvals: [...(c?.approvals.values() ?? [])].map((p) => p.card) };
  }

  /** A message from the person: steers the running turn, or starts a new one that carries the conversation so far. */
  async say(slug: string, text: string): Promise<void> {
    const dir = path.join(this.opts.root, slug);
    let c = this.talks.get(slug);
    if (!c) this.talks.set(slug, (c = new Conversation(slug, dir)));
    c.turns.push({ role: 'user', text });
    this.publish(c, { type: 'user', text });
    if (c.run?.steer) {
      try {
        await c.run.steer(text);
        return;
      } catch {
        // The turn ended between the check and the steer: start a new one below.
      }
    }
    this.start(c, text);
  }

  stop(slug: string) {
    this.talks.get(slug)?.run?.abort();
  }

  answer(slug: string, id: string, decision: ApprovalDecision) {
    const pending = this.talks.get(slug)?.approvals.get(id);
    if (!pending) throw new Error('that question is no longer open');
    pending.resolve(decision);
  }

  stopAll() {
    for (const c of this.talks.values()) c.run?.abort();
  }

  private start(c: Conversation, text: string) {
    const agent = museLive({ command: this.opts.command ?? process.env.DIORAMA_MUSE_COMMAND ?? 'muse' });
    // The next turn continues Muse's own session; only the first (or one after a lost session) carries the brief.
    const resume = agent.capabilities.resume && c.session ? c.session : undefined;
    const earlier = c.turns.slice(0, -1).slice(-12).map((t) => `${t.role === 'user' ? 'Person' : 'You'}: ${t.text}`).join('\n');
    const prompt = resume ? text : `${AGENT_BRIEF(c.slug)}\n\n${earlier ? `The conversation so far:\n${earlier}\n\n` : ''}Person: ${text}`;
    const cwd = fs.existsSync(c.dir) ? c.dir : this.opts.root;
    fs.mkdirSync(cwd, { recursive: true });
    const env = withoutProviderCredentials(withoutSecrets(process.env)) as Record<string, string>;
    const run = agent.run({
      prompt,
      ...(resume && { resume }),
      cwd,
      env,
      // genaicode hands the server to Muse as -c overrides, the token through an environment variable, never argv.
      mcpServers: [{ name: 'diorama', url: this.opts.mcpUrl, headers: { Authorization: `Bearer ${this.opts.agentToken}` } }],
      permissions: { approval: 'ask' },
      onApproval: (request, signal) => this.ask(c, request, signal),
    });
    c.run = run;
    this.publish(c, { type: 'turn.start' });
    void (async () => {
      let said = '';
      try {
        for await (const event of run) {
          if (event.type === 'message') said = event.text;
          if (event.type === 'session') c.session = event.sessionId;
          this.relay(c, event);
        }
        const result = await run.result;
        if (said) c.turns.push({ role: 'agent', text: said });
        this.publish(c, { type: 'turn.end', status: result.status, ...(result.error && { error: redact(String(result.error)) }) });
      } catch (error) {
        this.publish(c, { type: 'turn.end', status: 'failed', error: redact(error instanceof Error ? error.message : String(error)) });
      } finally {
        if (c.run === run) c.run = null;
      }
    })();
  }

  private ask(c: Conversation, request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> {
    // The Studio's own tools are logged and undoable: they run without asking. The agent works only through
    // them, so Muse's own shell and file tools are refused (DIORAMA_AGENT_TOOLS=ask puts them to the person).
    if (studioTool(request)) return Promise.resolve('approve');
    this.record(c, { type: 'refused', kind: request.kind, detail: request.detail });
    if (process.env.DIORAMA_AGENT_TOOLS !== 'ask') {
      this.publish(c, { type: 'blocked', kind: request.kind, summary: card(request).summary ?? request.kind });
      return Promise.resolve('deny');
    }
    return new Promise((resolve) => {
      const done = (d: ApprovalDecision) => {
        c.approvals.delete(request.id);
        this.publish(c, { type: 'approval.resolved', id: request.id, decision: d });
        resolve(d);
      };
      const shown = card(request);
      c.approvals.set(request.id, { card: shown, resolve: done });
      signal?.addEventListener('abort', () => done('deny'), { once: true });
      this.publish(c, { type: 'approval', request: shown });
    });
  }

  private relay(c: Conversation, event: AgentEvent) {
    switch (event.type) {
      case 'text-delta': return this.publish(c, { type: 'delta', text: event.text });
      case 'message': return this.publish(c, { type: 'message', text: event.text });
      case 'tool-start': return this.publish(c, { type: 'tool', name: event.name.replace(/^mcp__diorama__/, ''), id: event.id, studio: event.name.startsWith('mcp__diorama__'), ...(event.input !== undefined && { input: clip(event.input, 600) }) });
      case 'tool-end': return this.publish(c, { type: 'tool.end', name: event.name?.replace(/^mcp__diorama__/, ''), id: event.id, isError: !!event.isError, ...(event.output && { output: clip(event.output, 1200) }) });
      case 'error': return this.publish(c, { type: 'error', text: event.message });
      case 'stderr': return void this.record(c, { type: 'stderr', text: redact(event.text) });
      default: return;
    }
  }

  private publish(c: Conversation, data: Record<string, unknown>) {
    const safe = JSON.parse(redact(JSON.stringify(data))) as Record<string, unknown>;
    this.record(c, safe);
    const { type, ...rest } = safe;
    this.events.publish(`agent.${type}`, { world: c.slug, ...rest });
  }

  /** The session log (studio/sessions/*.jsonl), for replay in the film. */
  private record(c: Conversation, data: Record<string, unknown>) {
    try {
      fs.mkdirSync(path.dirname(c.log), { recursive: true });
      fs.appendFileSync(c.log, `${JSON.stringify({ at: new Date().toISOString(), ...data })}\n`);
    } catch {}
  }
}
