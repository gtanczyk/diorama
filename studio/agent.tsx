// The Muse Code panel: genaicode's own chat (genaicode/react), fed the session state the Studio server keeps
// for this world. The page holds no agent and no key: it sends what the person types and answers approvals.
import { AgentChat, type SessionState } from 'genaicode/react';
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl, token } from './api.ts';

/** What each Studio tool does, as the person would say it. */
const SAYS: Record<string, string> = {
  world_list: 'List worlds', world_status: 'World status', place_status: 'Look at a place', job_list: 'List jobs',
  job_wait: 'Wait for a job', job_cancel: 'Stop a job', job_retry: 'Run a job again', world_build: 'Build', run_step: 'Run a step',
  corrections_get: 'Read fixes', corrections_clear: 'Take fixes back', mask_fix: 'Fix a mask', mask_brush: 'Brush a mask',
  floor_cells: 'Fix floor cells', stand_set: 'Move a stand spot', repaint_region: 'Repaint a region', water_flow: 'Set water flow',
  feedback_pending: 'Read open notes', feedback_list: 'Read notes', feedback_done: 'Close a note', feedback_add: 'Leave a note', feedback_reopen: 'Reopen a note',
  history_list: 'Read history', history_undo: 'Undo a job', lock_set: 'Change a lock', ui_focus: 'Show a place', budget: 'Check budget', setup_status: 'Check Setup',
  cast_status: 'Look at the cast', cast_redo: 'Repaint a character', voice_list: 'List voices', voice_set: 'Change a voice',
  story_status: 'Read the story', story_text: 'Reword a line', story_redo: 'Rewrite the story', place_view: 'Look at the floor', play_reload: 'Reload the game', npc_move: 'Move an NPC',
};

const auth = { authorization: `Bearer ${token}` };

/** Follows the world's conversation: one whole SessionState per change, reconnecting when the line drops. */
function useSession(slug: string): [SessionState | null, boolean] {
  const [state, setState] = useState<SessionState | null>(null);
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!slug) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    (async () => {
      while (!stopped) {
        ctrl = new AbortController();
        try {
          const res = await fetch(`/api/agent/${slug}/live`, { headers: auth, signal: ctrl.signal });
          if (!res.ok || !res.body) throw new Error(String(res.status));
          setLive(true);
          const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
          let buf = '';
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            buf += value;
            let cut;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
              const data = buf.slice(0, cut).split('\n').find((l) => l.startsWith('data: '));
              buf = buf.slice(cut + 2);
              if (data) setState(JSON.parse(data.slice(6)) as SessionState | null);
            }
          }
        } catch {}
        setLive(false);
        if (!stopped) await new Promise((r) => setTimeout(r, 1500));
      }
    })();
    return () => {
      stopped = true;
      ctrl?.abort();
    };
  }, [slug]);
  return [state, live];
}

type Recorded = { at: string; type: string; agent?: string; status?: SessionState['status']; turn?: SessionState['turns'][number] };

/**
 * Plays a recorded conversation back (studio/sessions/<file>), at `speed` times real time, for the film:
 * the chat grows as it did, steps and all. Long pauses are cut to two seconds.
 */
function useReplay(slug: string, file: string | null, speed: number): [SessionState | null, boolean] {
  const [state, setState] = useState<SessionState | null>(null);
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!file) return;
    let stopped = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    fetch(fileUrl(slug, `studio/sessions/${file}`)).then((r) => r.text()).then((text) => {
      const lines = text.split('\n').filter(Boolean).map((l) => JSON.parse(l) as Recorded).filter((l) => l.type === 'state' && l.turn);
      const turns = new Map<number, SessionState['turns'][number]>();
      let clock = 0;
      let last = lines[0] ? Date.parse(lines[0].at) : 0;
      lines.forEach((l, i) => {
        clock += Math.min(2000, Date.parse(l.at) - last) / speed;
        last = Date.parse(l.at);
        timers.push(setTimeout(() => {
          if (stopped) return;
          turns.set(l.turn!.id, l.turn!);
          setState({ agent: l.agent ?? 'muse', cwd: '', status: l.status ?? 'idle', turns: [...turns.values()], queued: [], approvals: [], usage: {}, canSteer: false });
          if (i === lines.length - 1) setDone(true);
        }, 600 + clock));
      });
    }).catch(() => setDone(true));
    return () => {
      stopped = true;
      timers.forEach(clearTimeout);
    };
  }, [slug, file, speed]);
  return [state, done];
}

type Offer = { name: string; label: string; installed: boolean; using: boolean };

type Session = { file: string; started: string | null; agents: string[]; prompts: string[]; turns: number; replayable: boolean };

type JobInfo = { id: string; label: string; state: string; step?: string; by: string };

/**
 * genaicode's chat shows a tool's argument only for the usual keys (command, path, description...), so a
 * Studio tool would show as a bare name ("Wait for a job"). Each Studio call gets a description: the job's
 * name and step for the job tools, the world, place and thing for the rest; a running job_wait says where it is.
 */
export function describeCalls(state: SessionState | null, jobs: readonly JobInfo[]): SessionState | null {
  if (!state) return state;
  const job = (id: unknown) => jobs.find((j) => j.id === id);
  const turns = state.turns.map((turn) => ({
    ...turn,
    entries: turn.entries.map((e) => {
      if (e.kind !== 'tool' || !e.name.startsWith('mcp__diorama__') || !e.input || typeof e.input !== 'object') return e;
      const input = e.input as Record<string, unknown>;
      const j = job(input.id);
      const where = [input.slug, input.place, input.thing ?? input.npc ?? input.key ?? input.step, input.path].filter((v) => typeof v === 'string').join(' · ');
      const description = j ? `${j.label}${j.state === 'running' && j.step ? ` · ${j.step}` : ` · ${j.state}`}` : where;
      const output = !e.done && j && e.name.endsWith('job_wait') ? `${j.label}: ${j.state}${j.step ? `, at ${j.step}` : ''} (started by ${j.by === 'agent' ? 'the agent' : 'you'})` : e.output;
      return description ? { ...e, input: { ...input, description }, output } : e;
    }),
  }));
  return { ...state, turns };
}

export function AgentPanel({ slug, replay, speed = 1, jobs = [] }: { slug: string; replay?: string | null; speed?: number; jobs?: readonly JobInfo[] }) {
  const [liveState, live] = useSession(replay ? '' : slug);
  const [replayed, replayDone] = useReplay(slug, replay ?? null, speed);
  const state = describeCalls(replay ? replayed : liveState, jobs);
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [error, setError] = useState('');
  const [offers, setOffers] = useState<Offer[]>([]);
  const loadOffers = () => fetch(`/api/agent/${slug}/agents`, { headers: auth }).then((r) => r.json()).then(setOffers).catch(() => {});
  useEffect(() => void (replay || loadOffers()), [slug]);
  const current = offers.find((o) => o.using);
  const running = state?.status === 'running';
  const post = async (verb: string, body: object = {}) => {
    setError('');
    const res = await fetch(`/api/agent/${slug}/${verb}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not send (${res.status})`);
    return res.ok;
  };
  const choose = async (name: string) => {
    if (await post('use', { name })) void loadOffers();
  };
  return (
    <section class="agent">
      <AgentChat
        state={state}
        onSend={(text) => void post('say', { text })}
        onStop={() => void post('stop')}
        onApprove={(id, decision) => void post('approval', { id, decision })}
        formatToolName={(name) => (name.startsWith('mcp__diorama__') ? SAYS[name.slice(14)] ?? name.slice(14).replace(/_/g, ' ') : name)}
        foldSteps
        theme="dark"
        disabled={!!replay || !live}
        header={
          <div class="row">
            {offers.length > 1
              ? <select class="agent-pick" aria-label="Agent" title={running ? 'Stop the agent or wait to switch' : 'A new agent starts a fresh session; the conversation stays on screen'} disabled={running} value={current?.name} onChange={(e) => void choose(e.currentTarget.value)}>
                  {offers.map((o) => <option value={o.name} disabled={!o.installed}>{o.label}{o.installed ? '' : ' (not installed)'}</option>)}
                </select>
              : <h2>{current?.label ?? 'Muse Code'}</h2>}
            <span class="grow" />
            {replay
              ? <span class="live on">{replayDone ? 'replay done' : 'replay'}</span>
              : <span class={`live ${live ? 'on' : ''}`}>{running ? 'working…' : live ? 'ready' : 'reconnecting'}</span>}
          </div>
        }
        emptyState={<p class="note">Ask for a world, a fix or a check. Each step shows here and in Activity, and Undo takes back everything the agent did in its last turn.</p>}
        hint={error ? <span class="error">{error}</span> : null}
      />
      {!replay && (
        <details class="replays" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && call<Session[]>('agent_sessions', { slug }).then(setSessions).catch(() => {})}>
          <summary>Recorded sessions</summary>
          {sessions && sessions.filter((x) => x.replayable).length === 0 && <p class="note">None yet: every conversation is recorded from now on.</p>}
          <ul>{sessions?.filter((x) => x.replayable).map((x) => (
            <li><a href={`/w/${slug}?replay=${encodeURIComponent(x.file)}`}>{x.started?.slice(0, 16).replace('T', ' ')}</a> <span class="detail">{x.agents.join(', ')} · {x.turns} turn{x.turns === 1 ? '' : 's'}{x.prompts[0] ? ` · ${x.prompts[0]}` : ''}</span></li>
          ))}</ul>
        </details>
      )}
    </section>
  );
}
