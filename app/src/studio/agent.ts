// The coding agent in the Studio: one conversation per world, a genaicode AgentSession over Muse Code
// (museLive, `muse serve`, the default), Claude Code or Codex, the drivers that take MCP servers; shown in the page with genaicode's own chat. It works only through the Studio's MCP tools,
// so each of its moves shows up in the page like a click would; Muse's own shell and file tools are refused.
// It gets no provider key: its environment is scrubbed and Muse uses its own login.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { claude, codexLive, createAgentSession, detectAgents, museLive, type CodingAgent, withoutProviderCredentials, type AgentSession, type ApprovalDecision, type ApprovalRequest, type SessionState, type SessionTurn } from 'genaicode/agents';
import { configDir, redact, withoutSecrets } from '../secrets.ts';
import type { Events } from './events.ts';
import { History } from './history.ts';

export const AGENT_BRIEF = (slug: string) => `You are the coding agent inside Diorama Studio, working on the world "${slug}" with the person.
Use only the diorama MCP tools: they are the same actions as the Studio's buttons, and the person watches each call live.
Make a new world from an idea with world_new (it picks the name, places and language). Start long work with world_build or run_step and follow it with job_wait. Call ui_focus to show the place you are talking about.
Every place moves as a diorama (the backdrop step: cut-out things over a painted backdrop, far flats, flowing water). When the person says the water runs the wrong way or should stand still, call water_flow (reverse, still, or auto with a hint in their words), then show the place; never edit files by hand. Still water (the sea, a lake) sways in place by itself; water that does not move at all means SAM found none there: say so and offer a rebuild of that place's backdrop.
The weather step animates what falls on each place (rain or snow, rings on water and puddles, splashes, drops off the eaves). When the person says it should (not) rain or snow there, it rains too hard, or water should drip from something, call weather_set (fall auto/none/rain/snow, strength, a hint in their words), then show the place. Fog painted into the picture (a bank over the land, haze round a far lighthouse) drifts by itself: when the person says it stands still, drifts the wrong way or too fast, call fog_drift (auto with the wind, left, right, still; speed 0.25..3), then show the place; fog that still does not move means SAM found none there: offer a rebuild of that place's backdrop. More mist than the picture has is weather: weather_set with fog 0..1 (0 none, 0.3 haze, 0.7 thick fog).
A place's things are its props, exits, items and people. When the person wants a prop off the list, call thing_remove (paintOut false keeps it in the picture, true has Muse paint it out: ask which when they did not say); when something painted should be a thing of its own, thing_add with what it is in their words. Exits, items and people belong to the story: change those with story_redo.
To fix a place use the fix tools, which are kept across rebuilds: mask_fix (a better SAM phrase, the real box, or the kind of a thing), floor_cells, mask_brush, stand_set, repaint_region (costs a Muse edit), paint_words (how the place, its things and floors are described to the painter); corrections_get shows what is fixed already, corrections_clear takes fixes back. When asked to go through the person's notes, read feedback_pending, fix each one and close it with feedback_done in one sentence. Check budget before a rebuild of many places.
When the person wants the game to look different (more realistic, watercolour, like a picture book, less cartoon), call style_set with the style in a few words (medium, palette, light; scope place or cast for only one place or the characters): first without go, tell them what it repaints and about what it costs, then call it with go true once they agree. It repaints each picture keeping where everything is, so masks and their fixes still fit; children's drawings stay the reference; history_undo takes it back. Never write world.json's style by hand.
Before a risky change, say what you will do; history_undo can take back a job. Respect locks. Keys are never yours: if a key is missing, ask the person to run \`diorama setup\` in a terminal.
Read files freely to find out why something failed, but do not edit world files or run commands that change them: make every change through the diorama MCP tools, so the person sees it live, can undo it, and it survives the next build (a hand edit is overwritten by the next build). If no tool can make a change you need, say so and describe the tool that is missing instead of working around it. Start from world_status, place_status, place_view, job_wait, corrections_get and feedback_pending: place_view shows you a place as a picture (layer walk, masks or painting), which files and the shell cannot. Reach for the shell only when no Studio tool answers the question.
When a build leaves places not playable, repair them one by one: place_status lists each error with its playbook (where to look, the fix tools in order, the last resort), and place_view shows you the walkable floor with the 60 px cells floor_cells takes, the gaps to bridge and the spots off the floor. An unreached patch where nothing is floor (a wall, the sky) is taken back, not bridged: corrections_clear the fix that made it, or mask_brush erase. Try the tools in that order; each fix rebuilds only that place, so read place_status again after its job ends. Stop after three fixes that did not change the error, and tell the person what you tried and what you would do next. Ask before the last resort, except one repaint_region per place.
When paint fails with content_policy_violation, the image safety filter refused a word, not the picture: paint already lets Spark reword the place twice, so call paint_words with calm, plain words for the scene and the looks the brief had (leafless, not bare; a seat that rests, not hangs on chains; no children, blood or weapons), never an edit of world.json. A place that never got past a step is rebuilt from that step: place_fix (the Fix it button on its card) or job_retry does that by itself.
Stairs: derive finds the steps of floors and walk-on things named as stairs (stair, step, schody), and people then step from tread to tread; place_view (layer walk) draws the steps it found in blue. Scale: derive measures how tall a person is at each spot (Spark's people, held against a door on the floor: a person by a door is about 0.8 of its height). When the hero looks far too small or too big next to a door, run_step derive with that place, which rebuilds it through verify; when it stays wrong, the door is not named as a door: give it a door phrase with mask_fix. When people glide up stairs as on a ramp, the stairs thing or floor is not named as stairs: give it a stairs phrase with mask_fix (for example "stone stairs"), which rebuilds the place.
A message that starts with "[Looking at: place / thing]" is about that thing in that place (the person clicked it): "this" or "it" means that thing; look at it with place_view before you change it. A message that starts with "[Pictures: studio/pictures/01.jpg, …]" comes with pictures the person pasted, uploaded or took with the webcam: look at each with picture_view before you answer, and act on what they show. When the person is playing and your change shows in the game, call play_reload yourself rather than asking them to refresh. You cannot watch the game, but place_motion can: after a change to motion (water flow, fog, fire, weather, an animated thing) call it and check the motion shows before you say it works. A message that starts with "[Studio]" is a private note from the Studio, not from the person: follow it, never mention it or reply to it. The story has story_status, story_text (rewording) and story_redo (a wish to Spark); story_status lists unanswerable questions (a question in a "say" or in a line without choices leaves the player stuck): reword it into a statement with story_text, or story_redo when it needs real answers; it also lists unseen story parts (an item thing whose item has another key stays in the painting; a change on a person is never drawn): fix those with story_redo; the cast has cast_status, cast_redo, cast_animate and voice_set; a character with no 3D model the person wants moving (a creature, cast_status body upright false, or an NPC with no lines) gets one with cast_animate, never a cast_redo that makes it stand on two legs: a creature hops, squashes and blinks as one body, then play_reload; a hero painted sitting, lying or with furniture grown into the 3D model (from a photo where they sat or lay) gets cast_redo with looks that describe only the person standing (clothes, trousers, shoes; no pose, bed or "not visible"), then the model again; inventory icons have icons_status, icon_redo (a hint in the person's words, cut or paint, another take) and icon_fix_clear, never a swapped file in items/. Voices are cast from the gender and age Spark sees in each figure: adults get stock voices, children, teens and the old get a voice made for them by ElevenLabs Voice Design (voice "design"). When one sounds wrong, voice_list with slug and key lists the voices that fit that character first; voice_set with voice "design" and a design description in English remakes a designed voice (no word "child" or age in years there: ElevenLabs refuses it). Never give a child an adult's voice or raise an adult voice's pitch to fake one.
When you need the person to decide (yes or no, which of two fixes, go ahead with something that costs calls), ask with ask_person instead of a question in your text: it shows them buttons; then end your turn.
Answer in two or three short sentences, in the language the person wrote their newest message in (not the world's language, not an earlier turn's); the steps already show what you did.`;

const NUDGE_AFTER = 3;
const NUDGE = '[Studio] You are using the shell a lot. Look with the Studio tools instead: place_view shows a place as a picture '
  + '(layer walk: reachable floor, gaps, spots; masks: each thing\'s mask against where it should be; painting: the grid), place_status '
  + 'gives each error with its playbook, corrections_get the fixes so far, place_motion what moves in the game. Change things only with the fix tools. '
  + 'This note is from the Studio, not from the person: do not mention it or answer it in your reply, just carry on with their request.';

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

type Call = { turn?: number; name: string; args: Record<string, unknown>; done: boolean; ok?: boolean; summary?: string };

/** A Studio tool's own name, however the agent spells it (mcp__diorama__job_wait, diorama.job_wait). */
export function toolName(name: string): string | undefined {
  return /^(?:mcp__diorama__|diorama[.:_/]+)(\w+)$/.exec(name)?.[1];
}

/** A tool's result in one line for the panel: a job by its name and state, else the result itself, short. */
export function summarize(result: unknown): string {
  if (result instanceof Error) return result.message;
  if (typeof result === 'string') return result.slice(0, 400);
  if (!result || typeof result !== 'object') return String(result);
  const r = result as Record<string, unknown>;
  if (typeof r.label === 'string' && typeof r.state === 'string') {
    const tail = Array.isArray(r.tail) ? (r.tail as unknown[]).filter((x) => typeof x === 'string').slice(-3).join('\n') : '';
    return `${r.label}: ${r.state}${typeof r.step === 'string' ? `, at ${r.step}` : ''}${typeof r.error === 'string' ? ` (${r.error})` : ''}${tail ? `\n${tail}` : ''}`;
  }
  // The picture a view tool showed goes first, so it survives the cut and the panel can show it.
  const { images: _images, picture, ...rest } = r;
  const text = JSON.stringify(typeof picture === 'string' ? { picture, ...rest } : rest);
  return text.length > 400 ? `${text.slice(0, 400)}…` : text;
}

class Talk {
  readonly log: string;
  /** Whether the current agent session got the brief; a new agent starts without it. */
  briefed = false;
  /** Whether the agent goes on with its own session from turn to turn; one that does not (Codex) is briefed with the conversation every turn. */
  resumes = true;
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

  /**
   * The Studio's tools as the Studio saw them called (arguments, outcome). Some agents report a tool call by
   * name alone (Muse Code), so the panel showed "Wait for a job · No output."; the calls fill that in.
   */
  private calls: Call[] = [];
  readonly listeners = new Set<() => void>();

  /** The conversation before this session (earlier agents, before the Studio restarted), shown above it. */
  readonly past: SessionTurn[];

  constructor(readonly slug: string, readonly session: AgentSession, private readonly dir: string, private readonly events: Events) {
    this.past = pastTurns(dir);
    const id = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
    this.log = path.join(dir, 'studio', 'sessions', `${id}-${randomBytes(2).toString('hex')}.jsonl`);
    session.subscribe((state) => {
      this.announce(state);
      this.film(this.told(state));
    });
  }

  /** A Studio tool the agent called: kept with the turn it ran in; the returned function settles it. */
  call(name: string, args: Record<string, unknown>): (ok: boolean, result: unknown) => void {
    const c: Call = { turn: this.session.get().turns.at(-1)?.id, name, args, done: false };
    this.calls.push(c);
    if (this.calls.length > 400) this.calls.splice(0, this.calls.length - 400);
    this.changed();
    return (ok, result) => {
      Object.assign(c, { done: true, ok, summary: summarize(result) });
      this.changed();
    };
  }

  private changed() {
    for (const l of this.listeners) l();
    this.film(this.told(this.session.get()));
  }

  /** The state with each Studio tool's arguments and outcome filled in where the agent left them out. */
  told(state: SessionState): SessionState {
    if (!this.calls.length) return state;
    const turns = state.turns.map((turn) => {
      const mine = this.calls.filter((c) => c.turn === turn.id);
      if (!mine.length) return turn;
      const seen = new Map<string, number>();
      let changed = false;
      const entries = turn.entries.map((e) => {
        if (e.kind !== 'tool') return e;
        const name = toolName(e.name);
        if (!name) return e;
        const n = seen.get(name) ?? 0;
        seen.set(name, n + 1);
        const c = mine.filter((x) => x.name === name)[n];
        if (!c) return e;
        const bare = e.input === undefined || e.input === null || (typeof e.input === 'object' && !Object.keys(e.input).length);
        const silent = !e.output || /^no output\.?$/i.test(e.output.trim());
        if (!bare && !(silent && c.done)) return e;
        changed = true;
        return { ...e, ...(bare && { input: c.args }), ...(silent && c.done && { output: c.summary, isError: e.isError || !c.ok }) };
      });
      return changed ? { ...turn, entries } : turn;
    });
    return { ...state, turns };
  }

  /** What the page shows: the earlier turns, then this session's. */
  shown(state: SessionState): SessionState {
    const now = this.told(state);
    return this.past.length ? { ...now, turns: [...this.past, ...now.turns] } : now;
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
    // Persist completed turns immediately: a restart can follow the answer before the throttle fires.
    if (state.turns.at(-1)?.result) this.flushFilm();
    else this.filmTimer ??= setTimeout(() => this.flushFilm(), 250);
  }

  private flushFilm() {
    clearTimeout(this.filmTimer);
    this.filmTimer = undefined;
    const s = this.filmLatest;
    if (!s) return;
    for (const turn of s.turns) {
      if (this.filmed.get(turn.id) === turn) continue;
      this.filmed.set(turn.id, turn);
      this.record({ type: 'state', agent: turn.agent ?? s.agent, status: turn === s.turns.at(-1) ? s.status : 'idle', turn });
    }
  }

  close() {
    this.session.close();
    this.flushFilm();
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
        this.remember(state.agent, turn, said);
        this.publish('turn.end', { status: turn.result.status, ...(turn.result.error && { error: String(turn.result.error) }) });
      }
    }
  }

  /**
   * The world's conversation in words, across Studio restarts and agents: studio/conversation.md. A fresh agent
   * session is told to read it, so switching agents or restarting the Studio does not lose what was agreed.
   */
  private remember(agent: string, turn: SessionState['turns'][number], said: string | undefined) {
    const tools = [...new Set(turn.entries.flatMap((e) => (e.kind === 'tool' ? [toolName(e.name) ?? e.name] : [])))];
    const who = turn.prompt.startsWith('[Studio]') ? 'Studio' : 'Person';
    const lines = [`## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · ${agent}`, '', `**${who}:** ${turn.prompt.trim()}`, ''];
    if (tools.length) lines.push(`**Tools:** ${tools.join(', ')}`, '');
    lines.push(`**Agent:** ${said?.trim() || (turn.result?.status === 'completed' ? '(no words)' : `(turn ${turn.result?.status ?? 'ended'})`)}`, '', '');
    try {
      fs.mkdirSync(path.dirname(conversationFile(this.dir)), { recursive: true });
      fs.appendFileSync(conversationFile(this.dir), redact(lines.join('\n')));
    } catch {}
  }

  /** A handover in the conversation file, so the next agent reads who it took over from. */
  handedOver(from: string, to: string) {
    try {
      fs.mkdirSync(path.dirname(conversationFile(this.dir)), { recursive: true });
      fs.appendFileSync(conversationFile(this.dir), `## ${new Date().toISOString().slice(0, 16).replace('T', ' ')} · handed over from ${from} to ${to}\n\n`);
    } catch {}
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

/**
 * The world's earlier turns from its session logs (studio/sessions/*.jsonl, one per Studio session), oldest first,
 * the last `limit` of them. Each keeps its last recorded state; one cut off by a restart shows as ended. Their ids
 * are negative, so they never meet a live turn's.
 */
export function pastTurns(dir: string, limit = 60): SessionTurn[] {
  const logs = path.join(dir, 'studio', 'sessions');
  let files: string[] = [];
  try {
    files = fs.readdirSync(logs).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const turns: SessionTurn[] = [];
  for (const file of files) {
    const last = new Map<number, SessionTurn>();
    for (const line of fs.readFileSync(path.join(logs, file), 'utf8').split('\n')) {
      if (!/"type":\s*"state"/.test(line)) continue;
      try {
        const turn = (JSON.parse(line) as { turn?: SessionTurn }).turn;
        if (turn && typeof turn.id === 'number' && Array.isArray(turn.entries)) last.set(turn.id, turn);
      } catch {}
    }
    turns.push(...[...last.values()].sort((a, b) => a.id - b.id));
  }
  const kept = turns.sort((a, b) => a.startedAt - b.startedAt).slice(-limit);
  return kept.map((turn, i) => ({
    ...turn,
    id: i - kept.length,
    endedAt: turn.endedAt ?? turn.startedAt,
    // A turn the restart cut off ended there: without a result the chat would show it still working.
    result: turn.result ?? { status: 'aborted' as const, ok: false, exitCode: null, signal: null },
    entries: turn.entries.map((e) => (e.kind === 'text' ? { ...e, streaming: false } : e.kind === 'tool' ? { ...e, done: true } : e.kind === 'approval' && !e.decision ? { ...e, decision: 'deny' as const } : e)),
  }));
}

const conversationFile = (dir: string) => path.join(dir, 'studio', 'conversation.md');

/** How much of the conversation a fresh session is handed in its brief: the last turns, about this many bytes. */
const HANDED = 8000;

/**
 * For a fresh agent session: the conversation so far, when there is one. Its last turns are in the brief itself,
 * since an agent that keeps to the Studio's tools (Codex) does not open files; the whole of it stays in the file.
 */
export function earlier(dir: string): string {
  let text = '';
  try {
    text = fs.readFileSync(conversationFile(dir), 'utf8');
  } catch {
    return '';
  }
  if (!text.trim()) return '';
  // Whole turns only: cut at a turn's heading.
  let tail = text.slice(-HANDED);
  if (tail.length < text.length) tail = tail.slice(Math.max(0, tail.indexOf('\n## ') + 1));
  return `\nYou are joining a conversation about this world that started before this session (another agent, or before the Studio restarted). `
    + 'The person sees the same conversation on screen, so carry on from it: what they asked, what was changed and what is still open. '
    + `${tail.length < text.length ? `Its last turns (all of it, ${Math.round(text.length / 1024)} KB, is in studio/conversation.md):` : 'Here it is (also in studio/conversation.md):'}\n\n<conversation>\n${tail.trim()}\n</conversation>\n`;
}

export class AgentHub {
  private readonly talks = new Map<string, Talk>();

  constructor(
    private readonly events: Events,
    private readonly opts: { root: string; mcpUrl: string; agentToken: string; command?: string },
  ) {}

  /** The agent last picked in the Studio, for new conversations (~/.config/diorama/studio.json). */
  private static prefs = () => path.join(configDir(), 'studio.json');
  private saved(): string | undefined {
    try {
      return (JSON.parse(fs.readFileSync(AgentHub.prefs(), 'utf8')) as { agent?: string }).agent;
    } catch {
      return undefined;
    }
  }
  private save(name: AgentName) {
    try {
      fs.mkdirSync(path.dirname(AgentHub.prefs()), { recursive: true });
      const old = fs.existsSync(AgentHub.prefs()) ? JSON.parse(fs.readFileSync(AgentHub.prefs(), 'utf8')) : {};
      fs.writeFileSync(AgentHub.prefs(), `${JSON.stringify({ ...old, agent: name }, null, 2)}\n`);
    } catch {}
  }

  private talk(slug: string): Talk {
    let t = this.talks.get(slug);
    if (t) return t;
    const dir = path.join(this.opts.root, slug);
    const cwd = fs.existsSync(dir) ? dir : this.opts.root;
    fs.mkdirSync(cwd, { recursive: true });
    const ask = process.env.DIORAMA_AGENT_TOOLS === 'ask';
    const agent = this.make(this.defaultAgent(slug));
    const session = createAgentSession({
      agent,
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
        if (t?.briefed && t.resumes && session.get().sessionId) return prompt;
        if (t) t.briefed = true;
        return `${AGENT_BRIEF(slug)}${earlier(dir)}\n\nPerson: ${prompt}`;
      },
    });
    t = new Talk(slug, session, dir, this.events);
    t.resumes = !!agent.capabilities.resume;
    this.talks.set(slug, t);
    return t;
  }

  private make(name: AgentName): CodingAgent {
    return name === 'muse' ? AGENTS.muse.make(this.opts.command) : AGENTS[name].make();
  }

  /**
   * DIORAMA_AGENT when set; else the agent this world's conversation was last with, so a restart carries on with
   * it; else the one last picked in the Studio; else Muse Code, or the first agent this machine has.
   */
  private defaultAgent(slug?: string): AgentName {
    const wanted = process.env.DIORAMA_AGENT;
    if (wanted && isAgentName(wanted)) return wanted;
    const names = Object.keys(AGENTS) as AgentName[];
    const found = detectAgents(names.map((n) => this.make(n)));
    const installed = (n: string | undefined) => names.find((name, i) => found[i]?.path && (name === n || found[i]?.agent.name === n));
    const last = slug ? pastTurns(path.join(this.opts.root, slug), 1)[0]?.agent : undefined;
    return installed(last) ?? installed(this.saved()) ?? names.find((_, i) => found[i]?.path) ?? 'muse';
  }

  /** The agents on offer, which are installed, and which one this world's conversation uses. */
  agents(slug: string) {
    const found = detectAgents((Object.keys(AGENTS) as AgentName[]).map((n) => this.make(n)));
    const using = this.talks.get(slug)?.session.get().agent ?? this.make(this.defaultAgent(slug)).name;
    return (Object.keys(AGENTS) as AgentName[]).map((name, i) => ({ name, label: AGENTS[name].label, agent: found[i]?.agent.name ?? name, installed: !!found[i]?.path, using: found[i]?.agent.name === using }));
  }

  /** For Setup: the agents, which are installed, and the one new worlds start with. */
  defaults() {
    const names = Object.keys(AGENTS) as AgentName[];
    const found = detectAgents(names.map((n) => this.make(n)));
    const pick = this.defaultAgent();
    return { env: process.env.DIORAMA_AGENT ?? null, agents: names.map((name, i) => ({ name, label: AGENTS[name].label, installed: !!found[i]?.path, default: name === pick })) };
  }

  /** Setup's choice of the agent new worlds start with. */
  setDefault(name: AgentName) {
    this.save(name);
  }

  /** Switches this world's conversation to another agent; it starts a fresh session, the transcript stays. */
  use(slug: string, name: AgentName) {
    const t = this.talk(slug);
    if (t.session.get().status === 'running') throw new Error('the agent is working: stop it or wait before switching');
    const from = this.agents(slug).find((a) => a.using)?.label;
    const agent = this.make(name);
    t.session.setAgent(agent);
    t.resumes = !!agent.capabilities.resume;
    t.rebrief();
    this.save(name);
    if (from && from !== AGENTS[name].label && (t.past.length || t.session.get().turns.length)) t.handedOver(from, AGENTS[name].label);
    t.publish('agent', { name, label: AGENTS[name].label });
  }

  /** What the page shows: genaicode's session state, secrets blanked; null before the first message. */
  state(slug: string): SessionState | null {
    const t = this.talks.get(slug) ?? (pastTurns(path.join(this.opts.root, slug), 1).length ? this.talk(slug) : undefined);
    return t ? safe(t.shown(t.session.get())) : null;
  }

  /** Every change of a world's conversation, for the page's live view. */
  watch(slug: string, listener: (state: SessionState) => void): () => void {
    const t = this.talk(slug);
    const send = () => listener(safe(t.shown(t.session.get())));
    const off = t.session.subscribe(send);
    t.listeners.add(send);
    return () => {
      off();
      t.listeners.delete(send);
    };
  }

  /** For the MCP endpoint: a Studio tool the agent of this world called, settled by the returned function. */
  called(slug: string, name: string, args: Record<string, unknown>): (ok: boolean, result: unknown) => void {
    return this.talks.get(slug)?.call(name, args) ?? (() => {});
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
    for (const t of this.talks.values()) t.close();
  }
}

export type { ApprovalRequest };
