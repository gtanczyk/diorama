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
Before a risky change, say what you will do; history_undo can take back a job. Respect locks. Keys are never yours: if a key is missing, ask the person to run \`diorama setup\` in a terminal.
Answer briefly, in the person's language.`;

type Turn = { role: 'user' | 'agent'; text: string };
type Pending = { request: ApprovalRequest; resolve: (d: ApprovalDecision) => void };

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
    return { seq: this.events.last, running: !!c?.run, turns: c?.turns ?? [], approvals: [...(c?.approvals.values() ?? [])].map((p) => p.request) };
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
    // The Studio's own tools are logged and undoable: they run without asking. Anything else asks the person.
    if (JSON.stringify(request.detail ?? '').includes('diorama')) return Promise.resolve('approve');
    return new Promise((resolve) => {
      const done = (d: ApprovalDecision) => {
        c.approvals.delete(request.id);
        this.publish(c, { type: 'approval.resolved', id: request.id, decision: d });
        resolve(d);
      };
      c.approvals.set(request.id, { request, resolve: done });
      signal?.addEventListener('abort', () => done('deny'), { once: true });
      this.publish(c, { type: 'approval', request: { id: request.id, kind: request.kind, summary: request.summary } });
    });
  }

  private relay(c: Conversation, event: AgentEvent) {
    switch (event.type) {
      case 'text-delta': return this.publish(c, { type: 'delta', text: event.text });
      case 'message': return this.publish(c, { type: 'message', text: event.text });
      case 'tool-start': return this.publish(c, { type: 'tool', name: event.name.replace(/^mcp__diorama__/, ''), id: event.id });
      case 'tool-end': return this.publish(c, { type: 'tool.end', name: event.name?.replace(/^mcp__diorama__/, ''), id: event.id, isError: !!event.isError });
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
