// The Muse Code panel: genaicode's own chat (genaicode/react), fed the session state the Studio server keeps
// for this world. The page holds no agent and no key: it sends what the person types and answers approvals.
import { AgentChat, type ChatNotice, type SessionState, type SessionTurn } from 'genaicode/react';
import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, fileUrl, token } from './api.ts';
import { Camera } from './camera.tsx';
import { pickPrefix, shownPick, type Picked } from './world.tsx';

/** What each Studio tool does, as the person would say it. */
const SAYS: Record<string, string> = {
  world_export: 'Make a zip',
  world_publish: 'Publish a link',
  picture_view: 'Look at your picture',
  world_list: 'List worlds', world_status: 'World status', place_status: 'Look at a place', job_list: 'List jobs',
  job_wait: 'Wait for a job', job_cancel: 'Stop a job', job_retry: 'Run a job again', world_build: 'Build', run_step: 'Run a step',
  corrections_get: 'Read fixes', corrections_clear: 'Take fixes back', mask_fix: 'Fix a mask', thing_remove: 'Remove a thing', thing_add: 'Add a thing', mask_brush: 'Brush a mask',
  floor_cells: 'Fix floor cells', stand_set: 'Move a stand spot', repaint_region: 'Repaint a region', water_flow: 'Set water flow', fog_drift: 'Set fog drift', weather_set: 'Set weather',
  feedback_pending: 'Read open notes', feedback_list: 'Read notes', feedback_done: 'Close a note', feedback_add: 'Leave a note', feedback_reopen: 'Reopen a note',
  history_list: 'Read history', history_undo: 'Undo a job', history_redo: 'Redo', lock_set: 'Change a lock', ui_focus: 'Show a place', ask_person: 'Ask you', budget: 'Check budget', setup_status: 'Check Setup',
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
          // The recording can end inside a turn; once it is played through, nothing is working any more.
          setState({ agent: l.agent ?? 'muse', cwd: '', status: i === lines.length - 1 ? 'idle' : l.status ?? 'idle', turns: [...turns.values()], queued: [], approvals: [], usage: {}, canSteer: false });
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

type Offer = { name: string; label: string; agent?: string; installed: boolean; using: boolean };

type Session = { file: string; started: string | null; agents: string[]; prompts: string[]; turns: number; replayable: boolean };

type JobInfo = { id: string; label: string; state: string; step?: string; by: string; args?: string[]; startedAt?: string };

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
    // An approved Studio call is followed by the call itself, which says the same; only a pending or denied one is news.
    entries: turn.entries.filter((e) => !(e.kind === 'approval' && e.decision === 'approve' && e.request.summary?.includes('mcp__diorama__'))).map((e) => {
      // An approval names the raw tool; say it the way the steps do.
      if (e.kind === 'approval' && e.request.summary?.includes('mcp__diorama__')) {
        return { ...e, request: { ...e.request, summary: e.request.summary.replace(/mcp__diorama__(\w+)/g, (_, name: string) => SAYS[name] ?? name.replace(/_/g, ' ')) } };
      }
      // The agent's own tool, refused or failed with nothing to say: say so, not "No output."
      if (e.kind === 'tool' && e.done && e.isError && !e.output?.trim() && !e.name.startsWith('mcp__diorama__')) return { ...e, output: 'Refused or failed; the agent carries on.' };
      if (e.kind !== 'tool' || !e.name.startsWith('mcp__diorama__') || !e.input || typeof e.input !== 'object') return e;
      const input = e.input as Record<string, unknown>;
      const j = job(input.id);
      const where = [input.slug, input.place, input.thing ?? input.npc ?? input.key ?? input.step, input.path].filter((v) => typeof v === 'string').join(' · ');
      const description = j ? `${j.label}${j.state === 'running' && j.step ? ` · ${j.step}` : ` · ${j.state}`}` : where;
      // A running wait says which job, which step and for how long, live: the person sees what they wait for.
      const took = j?.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(j.startedAt)) / 1000)) : undefined;
      const at = j?.step && j.args ? steps(j.args).indexOf(j.step) : -1;
      const output = !e.done && j && (e.name.endsWith('job_wait') || e.name.endsWith('run_step'))
        ? `${j.label}: ${j.state}${j.step ? `, at ${j.step}${at >= 0 ? ` (${at + 1}/${steps(j.args!).length})` : ''}` : ''}${took !== undefined ? ` · ${clock(took)}` : ''} (started by ${j.by === 'agent' ? 'the agent' : 'you'})`
        : e.output;
      return description ? { ...e, input: { ...input, description }, output } : e;
    }),
  }));
  return { ...state, turns };
}

const BUILD_STEPS = ['world', 'story', 'layout', 'paint', 'masks', 'plates', 'icons', 'derive', 'backdrop', 'weather', 'cast', 'model', 'sprites', 'sound', 'voices', 'verify'];
/** The steps a job runs, from its command: one step, a range (--from/--to) or a whole build. */
function steps(args: readonly string[]): string[] {
  if (args[0] !== 'build') return BUILD_STEPS.includes(args[0]) ? [args[0]] : [];
  const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const from = BUILD_STEPS.indexOf(flag('--from') ?? 'world');
  const to = BUILD_STEPS.indexOf(flag('--to') ?? 'verify');
  return BUILD_STEPS.slice(Math.max(0, from), to < 0 ? undefined : to + 1);
}
const clock = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`);

/** In the atelier the panel is the world's conversation: cards before and between turns, and the thing picked on the stage. */
type Atelier = { pinned?: ComponentChildren; notices?: readonly ChatNotice[]; afterTurn?: (turn: SessionTurn, index: number, last: boolean) => ComponentChildren; footer?: (agentBusy: boolean) => ComponentChildren; picked?: Picked | null; onUnpick?: () => void; empty?: ComponentChildren };

export function AgentPanel({ slug, replay, speed = 1, jobs = [], notices, afterTurn, footer, picked, onUnpick, empty, pinned }: { slug: string; replay?: string | null; speed?: number; jobs?: readonly JobInfo[] } & Atelier) {
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
  // Before the first message the agent is a choice; after it, the conversation is handed over instead.
  const talked = (state?.turns.length ?? 0) > 0;
  const others = offers.filter((o) => o.installed && !o.using);
  const labelOf = (agent: string) => offers.find((o) => o.agent === agent || o.name === agent)?.label ?? agent;
  const post = async (verb: string, body: object = {}) => {
    setError('');
    const res = await fetch(`/api/agent/${slug}/${verb}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not send (${res.status})`);
    return res.ok;
  };
  // Pictures for the next message: pasted, dropped, picked or taken with the webcam, kept with the world.
  const [pics, setPics] = useState<string[]>([]);
  const [adding, setAdding] = useState(0);
  const [camera, setCamera] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const keep = async (name: string, data: string) => {
    setAdding((n) => n + 1);
    try {
      const { file } = await call<{ file: string }>('picture_add', { slug, name, data });
      setPics((p) => [...p, file]);
    } catch (e) {
      setError((e as Error).message);
    }
    setAdding((n) => n - 1);
  };
  const addFiles = (files: Iterable<File>) => {
    for (const f of files) if (f.type.startsWith('image/')) void dataUrl(f).then((d) => keep(f.name || 'pasted.png', d));
  };
  const images = (list: DataTransfer | null) => [...(list?.files ?? [])].filter((f) => f.type.startsWith('image/'));
  const send = (text: string) => {
    const looked = picked ? pickPrefix(picked) + text : text;
    const said = pics.length ? `[Pictures: ${pics.join(', ')}]\n${looked}` : looked;
    setPics([]);
    onUnpick?.();
    void post('say', { text: said });
  };
  const choose = async (name: string) => {
    if (await post('use', { name })) void loadOffers();
  };
  // A view tool's step shows the picture it looked at, as a thumbnail that opens big. genaicode renders the steps,
  // so the thumbnails are laid on after each render: a step whose output names a picture gets one in its line.
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    const lay = () => {
      for (const pre of root.querySelectorAll<HTMLElement>('details.gc-tool > pre')) {
        const file = /^\{"picture":"([^"]+)"/.exec(pre.textContent ?? '')?.[1];
        const summary = pre.parentElement?.querySelector('summary');
        if (!file || !summary || summary.querySelector('.tool-pic')) continue;
        const url = fileUrl(slug, file, Date.now());
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'tool-pic';
        b.dataset.lightbox = url;
        b.title = 'What the agent looked at. Click to see it big';
        b.innerHTML = `<img alt="" src="${url}">`;
        summary.appendChild(b);
      }
    };
    lay();
    const watch = new MutationObserver(lay);
    watch.observe(root, { childList: true, subtree: true, characterData: true });
    return () => watch.disconnect();
  }, [slug]);
  // The world's opening cards scrolled out of sight in a long talk: pin the world strip under the header.
  const [away, setAway] = useState(false);
  useEffect(() => {
    const scroller = panel.current?.querySelector<HTMLElement>('.gc-scroll');
    if (!scroller || !pinned) return;
    const check = () => {
      const cards = scroller.querySelectorAll('[data-opening]');
      const top = scroller.getBoundingClientRect().top;
      setAway(cards.length > 0 && [...cards].every((c) => c.getBoundingClientRect().bottom < top + 8));
    };
    check();
    scroller.addEventListener('scroll', check, { passive: true });
    const watch = new MutationObserver(check);
    watch.observe(scroller, { childList: true, subtree: true });
    return () => (scroller.removeEventListener('scroll', check), watch.disconnect());
  }, [slug, !!pinned, !!state]);
  return (
    <section
      ref={panel}
      class="agent"
      onPaste={(e) => {
        const found = images(e.clipboardData);
        if (found.length && !replay) (e.preventDefault(), addFiles(found));
      }}
      onDragOver={(e) => images(e.dataTransfer).length || e.dataTransfer?.types.includes('Files') ? e.preventDefault() : undefined}
      onDrop={(e) => {
        const found = images(e.dataTransfer);
        if (found.length && !replay) (e.preventDefault(), addFiles(found));
      }}
    >
      <AgentChat
        state={state}
        onSend={send}
        onStop={() => void post('stop')}
        onApprove={(id, decision) => void post('approval', { id, decision })}
        formatToolName={(name) => (name.startsWith('mcp__diorama__') ? SAYS[name.slice(14)] ?? name.slice(14).replace(/_/g, ' ') : name)}
        foldSteps
        renderPrompt={(text) => shownPrompt(text, slug)}
        notices={notices}
        renderAfterTurn={(turn: SessionTurn, index: number) => {
          const next = state?.turns[index + 1];
          const handover = next && next.agent !== turn.agent ? <p class="handover">{labelOf(turn.agent)} handed over to {labelOf(next.agent)}</p> : null;
          const after = afterTurn?.(turn, index, index === (state?.turns.length ?? 0) - 1);
          return (handover || after ? <>{after}{handover}</> : null) as never;
        }}
        renderFooter={footer && (() => footer(running) as never)}
        placeholder={running ? undefined : picked ? `What about the ${picked.name}?` : `Ask for a change, or click something in the picture…`}
        theme="light"
        disabled={!!replay || !live}
        header={
          <>
          <div class="row">
            {offers.length > 1 && !talked
              ? <select class="agent-pick" aria-label="Agent" title="Who to talk to. Your pick is remembered for new worlds; once you have talked, you can hand the conversation over to another agent" disabled={running} value={current?.name} onChange={(e) => void choose(e.currentTarget.value)}>
                  {offers.map((o) => <option value={o.name} disabled={!o.installed}>{o.label}{o.installed ? '' : ' (not installed)'}</option>)}
                </select>
              : <h2>{current?.label ?? 'Muse Code'}</h2>}
            {talked && !replay && others.length > 0 && (
              <select class="agent-hand" aria-label="Hand over to another agent" title={running ? 'Stop the agent or wait to hand over' : 'Another agent takes over this conversation: it reads everything said so far first'} disabled={running} value="" onChange={(e) => void choose(e.currentTarget.value)}>
                <option value="" disabled>Hand over…</option>
                {others.map((o) => <option value={o.name}>to {o.label}</option>)}
              </select>
            )}
            <span class="grow" />
            {replay
              ? <span class="live on">{replayDone ? 'replay done' : 'replay'}</span>
              : <span class={`live ${live ? 'on' : ''}`}>{running ? 'working…' : live ? 'ready' : 'reconnecting'}</span>}
          </div>
          {away && pinned}
          </>
        }
        emptyState={empty ?? <p class="note">Ask for a world, a fix or a check. Each step shows here and in Activity, and Undo takes back everything the agent did in its last turn.</p>}
        hint={replay ? null : (
          <div class="pics">
            {picked && <span class="pick-chip" title="Goes with your next message: the agent knows what you mean by this">📍 {picked.name}<button type="button" class="ghost bare" aria-label="Forget it" onClick={onUnpick}>×</button></span>}
            {pics.map((f) => (
              <span class="pic">
                <img src={fileUrl(slug, f)} alt="" />
                <button type="button" class="ghost small" aria-label="Take this picture out" title="Take this picture out" onClick={() => setPics((p) => p.filter((x) => x !== f))}>×</button>
              </span>
            ))}
            {adding > 0 && <span class="detail">adding…</span>}
            <button type="button" class="ghost small" title="Show the agent a picture with your message: a drawing, a photo, a reference. Or paste one (Cmd+V) or drop it here" onClick={() => picker.current?.click()}>＋ Picture</button>
            <button type="button" class="ghost small" title={camera ? 'Close the camera' : 'Take a webcam photo (a drawing held up works) to send the agent with your message'} onClick={() => setCamera(!camera)}>{camera ? 'Close the camera' : 'Camera'}</button>
            <input ref={picker} type="file" accept="image/*" multiple hidden onChange={(e) => (addFiles(e.currentTarget.files ?? []), (e.currentTarget.value = ''))} />
            {error && <span class="error">{error}</span>}
          </div>
        )}
      />
      {camera && <Camera tip="Show the agent what you mean." onSnap={(d) => (void keep('photo.jpg', d), setCamera(false))} onClose={() => setCamera(false)} />}
      {!replay && (
        <details class="replays" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && call<Session[]>('agent_sessions', { slug }).then(setSessions).catch(() => {})}>
          <summary title="Every conversation with the agent is recorded; play one back as it happened (for the film)">Recorded sessions</summary>
          {sessions && sessions.filter((x) => x.replayable).length === 0 && <p class="note">None yet: every conversation is recorded from now on.</p>}
          <ul>{sessions?.filter((x) => x.replayable).map((x) => (
            <li><a title="Play this session back as it happened. Free, nothing is run again" href={`/w/${slug}?replay=${encodeURIComponent(x.file)}`}>{x.started?.slice(0, 16).replace('T', ' ')}</a> <span class="detail">{x.agents.join(', ')} · {x.turns} turn{x.turns === 1 ? '' : 's'}{x.prompts[0] ? ` · ${x.prompts[0]}` : ''}</span></li>
          ))}</ul>
        </details>
      )}
    </section>
  );
}

const dataUrl = (f: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(f);
});

/** A sent prompt as the person sees it: the pictures it carried as thumbnails, then their words. */
function shownPrompt(text: string, slug: string) {
  // A Studio button's ask (Fix it, Ask the agent): its gist, and the whole wording folded under it.
  const asked = /^\[Ask: ([^\]\n]+)\]\n/.exec(text);
  if (asked) return <details class="ask-note"><summary>{asked[1]}</summary><p>{text.slice(asked[0].length)}</p></details>;
  const m = /^\[Pictures: ([^\]]+)\]\n?/.exec(text);
  const { pick, rest } = shownPick(m ? text.slice(m[0].length) : text);
  if (!m && !pick) return studioNote(text);
  return (
    <>
      {m && <span class="pics sent">{m[1].split(', ').map((f) => <button type="button" class="pic-open" data-lightbox={fileUrl(slug, f)} title="See it big"><img src={fileUrl(slug, f)} alt="" /></button>)}</span>}
      {pick && <span class="pick-chip sent">📍 {pick}</span>}
      {rest}
    </>
  );
}

// The Studio's own words to the agent (a nudge, a repair wake) are not the person's: show them as a quiet note.
function studioNote(text: string) {
  if (!text.startsWith('[Studio]')) return text;
  const body = text.slice(8).trim();
  const gist = body.startsWith('You are using the shell')
    ? 'Studio reminded the agent to look and fix with the Studio tools, not the shell.'
    : body.startsWith('The build')
      ? 'Studio asked the agent to repair the places a build left unplayable.'
      : 'Studio told the agent:';
  return <details class="studio-note"><summary>{gist}</summary>{body}</details>;
}
