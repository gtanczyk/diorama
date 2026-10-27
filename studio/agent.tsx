// The Muse Code panel: the conversation, and under each answer the steps the agent took, in words, with
// what it asked each tool and what came back. Its steps are Studio actions, so they also show in Activity.
import { useEffect, useRef, useState } from 'preact/hooks';
import { follow, token } from './api.ts';

type Ask = { id: string; kind: string; summary?: string; detail?: string };
type Step = { id?: string; name: string; input?: string; output?: string; ok?: boolean; studio: boolean; blocked?: boolean };
type Item =
  | { key: number; kind: 'user' | 'agent' | 'error'; text: string }
  | { key: number; kind: 'steps'; steps: Step[] };

const ASK_TITLE: Record<string, string> = { command: 'The agent wants to run a command on your computer', 'file-change': 'The agent wants to change files directly' };

/** What each Studio tool does, as the person would say it. */
const SAYS: Record<string, string> = {
  world_list: 'Listed the worlds', world_status: 'Read the world\'s status', place_status: 'Looked at a place up close', job_list: 'Listed the jobs',
  job_wait: 'Waited for a job', job_cancel: 'Stopped a job', job_retry: 'Ran a job again', world_build: 'Started a build', run_step: 'Ran a build step',
  corrections_get: 'Read the fixes made so far', corrections_clear: 'Took fixes back', mask_fix: 'Fixed how a thing is found', mask_brush: 'Brushed a mask',
  floor_cells: 'Fixed the floor cells', stand_set: 'Moved a stand spot', repaint_region: 'Repainted a region', water_flow: 'Set the water\'s flow',
  feedback_pending: 'Read your open notes', feedback_list: 'Read the notes', feedback_done: 'Closed a note', feedback_add: 'Left a note', feedback_reopen: 'Reopened a note',
  history_list: 'Read the history', history_undo: 'Undid a job', lock_set: 'Changed a lock', ui_focus: 'Showed you a place', budget: 'Checked the budget',
  setup_status: 'Checked Setup',
};

/** The arguments worth a glance (place, thing, step…) in one short line. */
function gist(input?: string): string {
  if (!input) return '';
  try {
    const v = JSON.parse(input) as Record<string, unknown>;
    return Object.entries(v)
      .filter(([k, x]) => k !== 'slug' && x !== undefined && typeof x !== 'object')
      .map(([k, x]) => (['place', 'thing', 'step', 'key', 'floor', 'kind', 'phrase', 'flow'].includes(k) ? String(x) : `${k} ${String(x)}`))
      .join(' · ');
  } catch {
    return input.length > 60 ? `${input.slice(0, 60)}…` : input;
  }
}

function pretty(text?: string): string {
  if (!text) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function StepLine({ s }: { s: Step }) {
  const state = s.blocked ? 'fail' : s.ok === undefined ? 'run' : s.ok ? 'ok' : 'fail';
  const label = s.blocked ? `Refused: ${s.name}` : s.studio ? SAYS[s.name] ?? s.name.replace(/_/g, ' ') : s.name;
  const sub = s.blocked ? 'only Studio tools are allowed' : gist(s.input);
  const more = !!(s.input || s.output);
  return (
    <li class={`step ${state}`}>
      <details>
        <summary class={more ? '' : 'plain'}>
          <span class={`mark ${state}`}>{state === 'run' ? '◌' : state === 'ok' ? '✓' : '✕'}</span>
          <span class="what">{label}</span>
          {sub && <span class="args">{sub}</span>}
        </summary>
        {more && (
          <div class="io">
            {s.input && <><span class="detail">asked</span><pre>{pretty(s.input)}</pre></>}
            {s.output && <><span class="detail">{s.ok === false ? 'error' : 'got'}</span><pre>{pretty(s.output)}</pre></>}
          </div>
        )}
      </details>
    </li>
  );
}

function Steps({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const shown = live || open || steps.length <= 4 ? steps : steps.slice(-2);
  const failed = steps.filter((s) => s.ok === false || s.blocked).length;
  return (
    <li class="steps-card">
      {!live && steps.length > 4 && (
        <button type="button" class="link" onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `${steps.length} steps${failed ? `, ${failed} refused or failed` : ''} · show all`}
        </button>
      )}
      <ol>{shown.map((s) => <StepLine s={s} />)}</ol>
    </li>
  );
}

function since(start: number | null): string {
  if (!start) return '';
  const s = Math.round((Date.now() - start) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

export function AgentPanel({ slug }: { slug: string }) {
  const [items, setItems] = useState<Item[]>([]);
  const [stream, setStream] = useState('');
  const [started, setStarted] = useState<number | null>(null);
  const [, tick] = useState(0);
  const [asks, setAsks] = useState<Ask[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    let n = 0;
    let after: number | null = null;
    const push = (kind: 'user' | 'agent' | 'error', body: string) => setItems((l) => [...l.slice(-200), { key: n++, kind, text: body }]);
    const step = (s: Step) => setItems((l) => {
      const last = l.at(-1);
      if (last?.kind === 'steps') return [...l.slice(0, -1), { ...last, steps: [...last.steps, s] }];
      return [...l.slice(-200), { key: n++, kind: 'steps', steps: [s] }];
    });
    const end = (id: string | undefined, name: string | undefined, patch: Partial<Step>) => setItems((l) => l.map((it) => (it.kind !== 'steps' ? it : {
      ...it,
      steps: it.steps.map((s) => (s.ok === undefined && !s.blocked && (id ? s.id === id : s.name === name) ? { ...s, ...patch } : s)),
    })));
    fetch(`/api/agent/${slug}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((s: { seq: number; running: boolean; turns: Array<{ role: 'user' | 'agent'; text: string }>; approvals: Ask[] }) => {
        s.turns.forEach((t) => push(t.role, t.text));
        after = s.seq;
        if (s.running) setStarted(Date.now());
        setAsks(s.approvals);
      })
      .catch(() => {});
    const stop = follow(slug, (e) => {
      // The feed replays from the start on connect; the conversation up to `after` came from the state call above.
      if (!e.type.startsWith('agent.') || after === null || e.seq <= after) return;
      const v = e as unknown as Record<string, string | boolean | undefined>;
      switch (e.type) {
        case 'agent.user': return push('user', String(v.text));
        case 'agent.turn.start': setStarted(Date.now()); return setStream('');
        case 'agent.delta': return setStream((t) => t + String(v.text));
        case 'agent.message': setStream(''); return push('agent', String(v.text));
        case 'agent.tool': return step({ id: v.id as string | undefined, name: String(v.name), input: v.input as string | undefined, studio: v.studio !== false });
        case 'agent.tool.end': return end(v.id as string | undefined, v.name as string | undefined, { ok: !v.isError, output: v.output as string | undefined });
        case 'agent.blocked': return step({ name: String(v.summary ?? v.kind), studio: false, blocked: true });
        case 'agent.error': return push('error', String(v.text));
        case 'agent.approval': return setAsks((a) => [...a, (e as unknown as { request: Ask }).request]);
        case 'agent.approval.resolved': return setAsks((a) => a.filter((x) => x.id !== v.id));
        case 'agent.turn.end':
          setStarted(null);
          setStream('');
          if (v.status !== 'completed' && v.status !== 'aborted') push('error', /ENOENT|spawn|not found/i.test(String(v.error)) ? 'Muse Code is not installed or not on PATH: see Setup.' : `The agent stopped: ${v.error ?? v.status}`);
          return;
      }
    });
    const timer = setInterval(() => tick((t) => t + 1), 1000);
    return () => (stop(), clearInterval(timer));
  }, [slug]);

  useEffect(() => {
    const el = list.current;
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
  }, [items, stream]);

  const post = (verb: string, body: object = {}) => fetch(`/api/agent/${slug}/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const send = async (e?: Event) => {
    e?.preventDefault();
    const say = text.trim();
    if (!say) return;
    setText('');
    setError('');
    const res = await post('say', { text: say });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not send (${res.status})`);
  };
  const running = started !== null;
  const lastSteps = items.at(-1)?.kind === 'steps';
  return (
    <section class="agent">
      <div class="row"><h2>Muse Code</h2><span class="grow" /><span class={`live ${running ? 'on' : ''}`}>{running ? `working · ${since(started)}` : 'ready'}</span></div>
      <ol class="chat" ref={list}>
        {items.length === 0 && <li class="note">Ask for a world, a fix or a check. The agent works only through the Studio's own tools, the same as the buttons, and you can undo its jobs.</li>}
        {items.map((it, i) => (it.kind === 'steps'
          ? <Steps key={it.key} steps={it.steps} live={running && i === items.length - 1} />
          : <li key={it.key} class={it.kind}>{it.text}</li>))}
        {stream && <li class="agent streaming">{stream}</li>}
        {running && !stream && !lastSteps && <li class="thinking">Thinking…</li>}
      </ol>
      {asks.map((a) => (
        <div class="ask" key={a.id} role="alert">
          <strong>{ASK_TITLE[a.kind] ?? 'The agent asks to do something outside the Studio'}</strong>
          {a.summary && <code>{a.summary}</code>}
          {a.detail && a.detail !== a.summary && <details><summary>Exactly what it asked</summary><pre>{a.detail}</pre></details>}
          <span class="detail">Studio tools never ask: they are logged and undoable. This one is not, so it is your call.</span>
          <div class="row"><button type="button" class="primary small" onClick={() => post('approval', { id: a.id, decision: 'approve' })}>Allow once</button><button type="button" class="ghost small" onClick={() => post('approval', { id: a.id, decision: 'deny' })}>Deny</button></div>
        </div>
      ))}
      <form class="say" onSubmit={send}>
        <textarea id="agent-say" rows={2} placeholder={running ? 'Add to what it is doing…' : 'Ask Muse Code…'} value={text} onInput={(e) => setText(e.currentTarget.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }} />
        <div class="row">
          {error && <span class="error">{error}</span>}
          <span class="grow" />
          {running && <button type="button" class="ghost small" onClick={() => post('stop')}>Stop</button>}
          <button type="submit" class="primary small" disabled={!text.trim()}>Send</button>
        </div>
      </form>
    </section>
  );
}
