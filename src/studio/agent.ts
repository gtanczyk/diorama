// The coding agent in the Studio: one conversation per world, a genaicode AgentSession over Muse Code
// (museLive, `muse serve`, the default), Claude Code or Codex, the drivers that take MCP servers; shown in the page with genaicode's own chat. It works only through the Studio's MCP tools,
// so each of its moves shows up in the page like a click would; Muse's own shell and file tools are refused.
// It gets no provider key: its environment is scrubbed and Muse uses its own login.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claude, codexLive, createAgentSession, detectAgents, museLive, type CodingAgent, withoutProviderCredentials, type AgentSession, type ApprovalDecision, type ApprovalRequest, type SessionState } from 'genaicode/agents';
import { redact, withoutSecrets } from '../secrets.ts';
import type { Events } from './events.ts';
import { History } from './history.ts';

export const AGENT_BRIEF = (slug: string) => `You are the coding agent inside Diorama Studio, working on the world "${slug}" with the person.
Use only the diorama MCP tools: they are the same actions as the Studio's buttons, and the person watches each call live.
Start long work with world_build or run_step and follow it with job_wait. Call ui_focus to show the place you are talking about.
Every place moves as a diorama (the backdrop step: cut-out things over a painted backdrop, far flats, flowing water). When the person says the water runs the wrong way or should stand still, call water_flow (reverse, still, or auto with a hint in their words), then show the place; never edit files by hand. Still water (the sea, a lake) sways in place by itself; water that does not move at all means SAM found none there: say so and offer a rebuild of that place's backdrop.
The weather step animates what falls on each place (rain or snow, rings on water and puddles, splashes, drops off the eaves). When the person says it should (not) rain or snow there, it rains too hard, or water should drip from something, call weather_set (fall auto/none/rain/snow, strength, a hint in their words), then show the place. Mist or fog drifting over a place is weather too: weather_set with fog 0..1 (0 none, 0.3 haze, 0.7 thick fog).
To fix a place use the fix tools, which are kept across rebuilds: mask_fix (a better SAM phrase, the real box, or the kind of a thing), floor_cells, mask_brush, stand_set, repaint_region (costs a Muse edit); corrections_get shows what is fixed already, corrections_clear takes fixes back. When asked to go through the person's notes, read feedback_pending, fix each one and close it with feedback_done in one sentence. Check budget before a rebuild of many places.
Before a risky change, say what you will do; history_undo can take back a job. Respect locks. Keys are never yours: if a key is missing, ask the person to run \`diorama setup\` in a terminal.
Read files freely to find out why something failed, but do not edit world files or run commands that change them: make every change through the diorama MCP tools, so the person sees it live, can undo it, and it survives the next build (a hand edit is overwritten by the next build). If no tool can make a change you need, say so and describe the tool that is missing instead of working around it. Start from world_status, place_status, place_view, job_wait, corrections_get and feedback_pending: place_view shows you a place as a picture (layer walk, masks or painting), which files and the shell cannot. Reach for the shell only when no Studio tool answers the question.
When a build leaves places not playable, repair them one by one: place_status lists each error with its playbook (where to look, the fix tools in order, the last resort), and place_view shows you the walkable floor with the 60 px cells floor_cells takes, the gaps to bridge and the spots off the floor. An unreached patch where nothing is floor (a wall, the sky) is taken back, not bridged: corrections_clear the fix that made it, or mask_brush erase. Try the tools in that order; each fix rebuilds only that place, so read place_status again after its job ends. Stop after three fixes that did not change the error, and tell the person what you tried and what you would do next. Ask before the last resort, except one repaint_region per place.
Stairs: derive finds the steps of floors and walk-on things named as stairs (stair, step, schody), and people then step from tread to tread; place_view (layer walk) draws the steps it found in blue. When people glide up stairs as on a ramp, the stairs thing or floor is not named as stairs: give it a stairs phrase with mask_fix (for example "stone stairs"), which rebuilds the place.
When the person is playing and your change shows in the game, call play_reload yourself rather than asking them to refresh. The story has story_status, story_text (rewording) and story_redo (a wish to Spark); story_status lists unanswerable questions (a question in a "say" or in a line without choices leaves the player stuck): reword it into a statement with story_text, or story_redo when it needs real answers; it also lists unseen story parts (an item thing whose item has another key stays in the painting; a change on a person is never drawn): fix those with story_redo; the cast has cast_status, cast_redo and voice_set; inventory icons have icons_status, icon_redo (a hint in the person's words, cut or paint, another take) and icon_fix_clear, never a swapped file in items/. Voices are cast from the gender and age Spark sees in each figure: adults get stock voices, children, teens and the old get a voice made for them by ElevenLabs Voice Design (voice "design"). When one sounds wrong, voice_list with slug and key lists the voices that fit that character first; voice_set with voice "design" and a design description in English remakes a designed voice (no word "child" or age in years there: ElevenLabs refuses it). Never give a child an adult's voice or raise an adult voice's pitch to fake one.
Answer in two or three short sentences, in the language the person wrote their newest message in (not the world's language, not an earlier turn's); the steps already show what you did.`;

const NUDGE_AFTER = 3;
const NUDGE = '[Studio] You are using the shell a lot. Look with the Studio tools instead: place_view shows a place as a picture '
  + '(layer walk: reachable floor, gaps, spots; masks: each thing\'s mask against where it should be; painting: the grid), place_status '
  + 'gives each error with its playbook, corrections_get the fixes so far. Change things only with the fix tools.';

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

/**
 * A shell call in a turn's transcript (Muse's shell or bash, Codex's exec, a REPL). Counted from the transcript,
 * not from approvals: Muse runs a read-only command without asking, so most shell calls never reach autoApprove.
 */
export const shellTool = (name: string) => /(^|[/_.])(shell|bash|sh|exec|exec_command|repl|js)$/i.test(name);

/** Turns a session snapshot into what the page may see: secrets blanked. */
const safe = (state: SessionState): SessionState => JSON.parse(redact(JSON.stringify(state))) as SessionState;

/** Muse reading a file: harmless, and it helps the agent find out why something failed. */
export function readsOnly(request: ApprovalRequest): boolean {
  const subject = ((request.detail ?? {}) as { subject?: { kind?: string; access?: string } }).subject;
  return request.kind === 'other' && subject?.kind === 'fileAccess' && subject.access === 'read';
}

class Talk {
  readonly log: string;
  /** Whether the current agent session got the brief; a new agent starts without it. */
  briefed = false;
  rebrief() {
    this.briefed = false;
  }
  /** Shell calls in the current turn. */
  shell = 0;
  /** How far each turn's transcript has been announced on the event feed. */
  private seen = new Map<number, number>();
  /** Tools announced already: a running tool is announced when it starts and must not be again once it settles. */
  private tools = new Set<string>();
  private ended = new Set<number>();

  constructor(readonly slug: string, readonly session: AgentSession, dir: string, private readonly events: Events) {
    const id = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    this.log = path.join(dir, 'studio', 'sessions', `${id}-${randomBytes(2).toString('hex')}.jsonl`);
    session.subscribe((state) => {
      this.announce(state);
      this.film(state);
    });
  }

  private filmTimer: NodeJS.Timeout | undefined;
  private filmLatest: SessionState | null = null;
  private filmed = new Map<number, SessionState['turns'][number]>();

  /**
   * For replay in the film: the running turn as it grows, at most four times a second. Each line holds that
   * turn whole (turns are small), so a replay rebuilds the chat from the lines alone.
   */
  private film(state: SessionState) {
    this.filmLatest = state;
    this.filmTimer ??= setTimeout(() => {
      this.filmTimer = undefined;
      const s = this.filmLatest!;
      // Every turn that changed since the last line: a turn can end and the next begin within one beat.
      for (const turn of s.turns) {
        if (this.filmed.get(turn.id) === turn) continue;
        this.filmed.set(turn.id, turn);
        this.record({ type: 'state', agent: s.agent, status: turn === s.turns.at(-1) ? s.status : 'idle', turn });
      }
    }, 250);
  }

  /** The feed (Activity, the terminal) gets the gist: what was said, each tool, refusals, how a turn ended. */
  private announce(state: SessionState) {
    for (const turn of state.turns) {
      if (!this.seen.has(turn.id)) {
        this.seen.set(turn.id, 0);
        this.shell = 0;
        this.publish('turn.start', { turn: turn.id });
      }
      const from = this.seen.get(turn.id)!;
      for (const [i, entry] of turn.entries.entries()) {
        if (i < from) continue;
        // A turn's entries only grow, so a turn and a place in it name an entry.
        if (entry.kind === 'tool' && !this.tools.has(`${turn.id}:${i}`)) {
          this.tools.add(`${turn.id}:${i}`);
          this.publish('tool', { name: entry.name.replace(/^mcp__diorama__/, '') });
          // The shell sees files, not the pictures the Studio's tools show: after a few shell calls in a turn,
          // the agent is reminded once which tools look for it. It is still let through.
          if (shellTool(entry.name) && ++this.shell === NUDGE_AFTER) {
            this.publish('nudge', { text: NUDGE });
            setTimeout(() => this.session.send(NUDGE), 0);
          }
        }
        if (entry.kind === 'approval' && entry.decision === 'deny') this.publish('blocked', { kind: entry.request.kind, summary: entry.request.summary ?? entry.request.kind });
        if (entry.kind === 'error') this.publish('error', { text: entry.message });
      }
      // Entries still streaming are announced once they settle.
      const settled = turn.entries.findIndex((e, i) => i >= from && ((e.kind === 'text' && e.streaming) || (e.kind === 'tool' && !e.done) || (e.kind === 'approval' && !e.decision)));
      this.seen.set(turn.id, settled < 0 ? turn.entries.length : settled);
      if (turn.result && !this.ended.has(turn.id)) {
        this.ended.add(turn.id);
        const said = turn.entries.filter((e) => e.kind === 'text').map((e) => (e as { text: string }).text).at(-1);
        if (said) this.publish('message', { text: said });
        this.publish('turn.end', { status: turn.result.status, ...(turn.result.error && { error: String(turn.result.error) }) });
      }
    }
  }

  publish(type: string, data: Record<string, unknown>) {
    const clean = JSON.parse(redact(JSON.stringify(data))) as Record<string, unknown>;
    this.record({ type, ...clean });
    this.events.publish(`agent.${type}`, { world: this.slug, ...clean });
  }

  /** The session log (studio/sessions/*.jsonl), for replay in the film. */
  record(data: Record<string, unknown>) {
    try {
      fs.mkdirSync(path.dirname(this.log), { recursive: true });
      fs.appendFileSync(this.log, `${redact(JSON.stringify({ at: new Date().toISOString(), ...data }))}\n`);
    } catch {}
  }
}

/**
 * Codex asks before each MCP tool call through a request the app server's approval routing does not carry,
 * so the call was refused before the panel could show it. The Studio's own tools are approved anyway (as for
 * Muse and Claude): tell Codex so for the diorama server. Shell and file approvals still come to the panel.
 */
export function preapproved(agent: CodingAgent): CodingAgent {
  return { ...agent, run: (task) => agent.run({ ...task, extraArgs: [...(task.extraArgs ?? []), '-c', 'mcp_servers.diorama.default_tools_approval_mode="approve"'] }) };
}

/** The agents the Studio offers: those genaicode can hand the Studio's MCP server to. Muse Code first, the default. */
export const AGENTS = {
  muse: { label: 'Muse Code', make: (command?: string) => museLive({ command: command ?? process.env.DIORAMA_MUSE_COMMAND ?? 'muse' }) },
  claude: { label: 'Claude Code', make: () => claude() },
  codex: { label: 'Codex', make: () => preapproved(codexLive()) },
} satisfies Record<string, { label: string; make(command?: string): CodingAgent }>;
export type AgentName = keyof typeof AGENTS;
export const isAgentName = (name: string): name is AgentName => Object.hasOwn(AGENTS, name);

export class AgentHub {
  private readonly talks = new Map<string, Talk>();

  constructor(
    private readonly events: Events,
    private readonly opts: { root: string; mcpUrl: string; agentToken: string; command?: string },
  ) {}

  private talk(slug: string): Talk {
    let t = this.talks.get(slug);
    if (t) return t;
    const dir = path.join(this.opts.root, slug);
    const cwd = fs.existsSync(dir) ? dir : this.opts.root;
    fs.mkdirSync(cwd, { recursive: true });
    const ask = process.env.DIORAMA_AGENT_TOOLS === 'ask';
    const session = createAgentSession({
      agent: this.make(this.defaultAgent()),
      cwd,
      task: {
        env: withoutProviderCredentials(withoutSecrets(process.env)) as Record<string, string>,
        // genaicode hands the server to Muse as -c overrides, the token through an environment variable, never argv.
        // The URL names the world this session is about, so a call that leaves out `slug` means this world.
        mcpServers: [{ name: 'diorama', url: `${this.opts.mcpUrl}?world=${slug}`, headers: { Authorization: `Bearer ${this.opts.agentToken}` } }],
        permissions: { approval: 'ask' },
      },
      // The agent may use any tool; the brief steers it to the Studio's. Each turn starts from a snapshot, so
      // Undo takes back a shell command or a file edit too, and the file watcher shows such changes live.
      // DIORAMA_AGENT_TOOLS=ask puts everything but the Studio's tools and reading to the person instead.
      autoApprove: (request) => {
        if (studioTool(request) || readsOnly(request)) return 'approve';
        t?.record({ type: 'outside', kind: request.kind, detail: request.detail });
        return ask ? undefined : 'approve';
      },
      // The first prompt carries the brief; later ones resume Muse's own session and go as typed.
      transformPrompt: (prompt) => {
        if (t?.briefed && session.get().sessionId) return prompt;
        if (t) t.briefed = true;
        return `${AGENT_BRIEF(slug)}\n\nPerson: ${prompt}`;
      },
    });
    t = new Talk(slug, session, dir, this.events);
    this.talks.set(slug, t);
    return t;
  }

  private make(name: AgentName): CodingAgent {
    return name === 'muse' ? AGENTS.muse.make(this.opts.command) : AGENTS[name].make();
  }

  /** DIORAMA_AGENT when set; otherwise Muse Code, or the first agent this machine has when Muse Code is not installed. */
  private defaultAgent(): AgentName {
    const wanted = process.env.DIORAMA_AGENT;
    if (wanted && isAgentName(wanted)) return wanted;
    const names = Object.keys(AGENTS) as AgentName[];
    const found = detectAgents(names.map((n) => this.make(n)));
    return names.find((_, i) => found[i]?.path) ?? 'muse';
  }

  /** The agents on offer, which are installed, and which one this world's conversation uses. */
  agents(slug: string) {
    const found = detectAgents((Object.keys(AGENTS) as AgentName[]).map((n) => this.make(n)));
    const using = this.talks.get(slug)?.session.get().agent ?? this.make(this.defaultAgent()).name;
    return (Object.keys(AGENTS) as AgentName[]).map((name, i) => ({ name, label: AGENTS[name].label, installed: !!found[i]?.path, using: found[i]?.agent.name === using }));
  }

  /** Switches this world's conversation to another agent; it starts a fresh session, the transcript stays. */
  use(slug: string, name: AgentName) {
    const t = this.talk(slug);
    if (t.session.get().status === 'running') throw new Error('the agent is working: stop it or wait before switching');
    t.session.setAgent(this.make(name));
    t.rebrief();
    t.publish('agent', { name, label: AGENTS[name].label });
  }

  /** What the page shows: genaicode's session state, secrets blanked; null before the first message. */
  state(slug: string): SessionState | null {
    const t = this.talks.get(slug);
    return t ? safe(t.session.get()) : null;
  }

  /** Every change of a world's conversation, for the page's live view. */
  watch(slug: string, listener: (state: SessionState) => void): () => void {
    return this.talk(slug).session.subscribe((s) => listener(safe(s)));
  }

  /** A message from the person: steers the running turn, or starts a new one that resumes the conversation. */
  async say(slug: string, text: string, from: 'person' | 'studio' = 'person'): Promise<void> {
    const t = this.talk(slug);
    // The Studio's own wake-ups (a repair after a build) show as such, not as the person speaking.
    t.publish(from === 'studio' ? 'wake' : 'user', { text });
    // A new turn starts from a snapshot of the world, whatever tools the agent then uses.
    const dir = path.join(this.opts.root, slug);
    if (t.session.get().status === 'idle' && fs.existsSync(dir)) {
      try {
        new History(dir).snapshot(`agent: ${text.slice(0, 60)}`, 'agent');
      } catch {}
    }
    // The Studio's own messages go as host notes: never steered into a running turn, they run after it.
    t.session.send(text, from === 'studio' ? { note: true } : undefined);
  }

  stop(slug: string) {
    this.talks.get(slug)?.session.stop();
  }

  answer(slug: string, id: string, decision: ApprovalDecision) {
    if (!this.talks.get(slug)?.session.approve(id, decision)) throw new Error('that question is no longer open');
  }

  stopAll() {
    for (const t of this.talks.values()) t.session.close();
  }
}

export type { ApprovalRequest };
