// Diorama Studio: Start (worlds and a new idea), Setup (what this machine needs) and the Workshop (a world
// building live). Everything here goes through actions, the same ones `diorama action` and the agent use.
import { render } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { call, fileUrl, follow, listActions, openSession, token, type StudioEvent } from './api.ts';

type Check = { id: string; label: string; state: 'ok' | 'missing' | 'optional' | 'fail'; detail: string; fix?: string[] };
type Summary = { slug: string; title: string; pitch: string | null; issue: string | null; places: number; playable: number; verified: number; steps: string[]; cover: { file: string; v: number | null } | null };
type Finding = { code: string; key?: string; detail: string };
type PlaceDetail = {
  key: string;
  shows: string;
  things: Array<{ key: string; role: string }>;
  stages: Record<string, number | null>;
  image: { file: string; v: number | null } | null;
  verdict: { ok: boolean; errors: Finding[]; flags: Finding[] } | null;
};
type Job = { id: string; label: string; state: string; by: string; step?: string; error?: string; startedAt?: string; endedAt?: string };
type Status = Summary & { placeDetail: PlaceDetail[]; build: Record<string, { seconds: number }>; calls: Record<string, number>; jobs: Job[] };

const route = signal(location.pathname);
const followAgent = signal(true);
let steps: string[] = [];
let quiet = new Set<string>();

function go(path: string) {
  if (path === route.value) return;
  history.pushState(null, '', path);
  route.value = path;
}
addEventListener('popstate', () => (route.value = location.pathname));

const slugify = (text: string) => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').split('-').slice(0, 4).join('-').replace(/^(\d)/, 'w-$1') || 'world';

function Mark({ state }: { state: Check['state'] | 'run' | 'todo' }) {
  const glyph = { ok: '✓', missing: '!', optional: '·', fail: '✕', run: '◌', todo: '' }[state];
  return <span class={`mark ${state}`} aria-label={state}>{glyph}</span>;
}

function Header({ world, live }: { world?: string; live?: boolean }) {
  return (
    <header class="top">
      <a href="/" class="brand" onClick={(e) => (e.preventDefault(), go('/'))}>
        <svg width="22" height="22" viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 21 L14 6 L25 21 Z" /><path d="M3 21 H25" /><path d="M9 21 L14 14 L19 21" /></svg>
        Diorama Studio
      </a>
      {world && <><span class="sep">/</span><span class="crumb">{world}</span></>}
      <span class="grow" />
      {live !== undefined && <span class={`live ${live ? 'on' : ''}`}>{live ? 'live' : 'reconnecting'}</span>}
      <label class="follow"><input type="checkbox" checked={followAgent.value} onChange={(e) => (followAgent.value = e.currentTarget.checked)} /> Follow agent</label>
      <a href="/setup" class="navlink" onClick={(e) => (e.preventDefault(), go('/setup'))}>Setup</a>
    </header>
  );
}

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" class="ghost small" onClick={() => navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}>{done ? 'Copied' : 'Copy'}</button>;
}

function Setup() {
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const run = async (name: 'setup_status' | 'setup_check') => {
    setBusy(name);
    setError('');
    try {
      setChecks(await call<Check[]>(name));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy('');
  };
  useEffect(() => void run('setup_status'), []);
  const ok = checks?.filter((c) => c.state === 'ok').length ?? 0;
  const blocking = checks?.filter((c) => c.state === 'missing' || c.state === 'fail') ?? [];
  return (
    <>
      <Header />
      <main class="narrow">
        <h1>Setup</h1>
        <p class="lead">{!checks ? 'Checking this machine…' : blocking.length ? `${ok} of ${checks.length} checks pass. ${blocking.map((c) => c.label).join(' and ')} still ${blocking.length > 1 ? 'need' : 'needs'} you.` : 'Everything diorama needs is here.'}</p>
        <p class="note">Keys are typed only in your terminal with <code>diorama setup</code>, hidden, and kept in your system keychain. This page never sees them.</p>
        {error && <p class="error">{error}</p>}
        <ol class="checks">
          {checks?.map((c) => (
            <li class={c.state}>
              <Mark state={c.state} />
              <div class="body">
                <strong>{c.label}</strong>
                <span class="detail">{c.detail}</span>
                {c.fix && c.state !== 'ok' && (
                  <div class="fix">
                    <pre>{c.fix.join('\n')}</pre>
                    <Copy text={c.fix.join('\n')} />
                  </div>
                )}
              </div>
            </li>
          ))}
        </ol>
        <div class="row">
          <button type="button" class="primary" disabled={!!busy} onClick={() => run('setup_status')}>{busy === 'setup_status' ? 'Checking…' : 'Check again'}</button>
          <button type="button" class="ghost" disabled={!!busy} onClick={() => run('setup_check')}>{busy === 'setup_check' ? 'Calling Meta…' : 'Test the Meta key live'}</button>
        </div>
      </main>
    </>
  );
}

function Start() {
  const [worlds, setWorlds] = useState<Summary[] | null>(null);
  const [needs, setNeeds] = useState<Check[]>([]);
  const [idea, setIdea] = useState('');
  const [slug, setSlug] = useState('');
  const [places, setPlaces] = useState(4);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    call<Summary[]>('world_list').then(setWorlds).catch((e) => setError(e.message));
    call<Check[]>('setup_status').then((c) => setNeeds(c.filter((x) => x.state === 'missing' || x.state === 'fail'))).catch(() => {});
  }, []);
  const name = slug || slugify(idea);
  const taken = worlds?.some((w) => w.slug === name);
  const build = async (e: Event) => {
    e.preventDefault();
    setError('');
    try {
      await call('world_build', { slug: name, idea: idea.trim(), places });
      go(`/w/${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const shown = (worlds ?? []).filter((w) => !query || `${w.title} ${w.slug} ${w.pitch ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <Header />
      <main class="wide">
        {needs.length > 0 && (
          <a class="banner" href="/setup" onClick={(e) => (e.preventDefault(), go('/setup'))}>
            Setup: {needs.map((n) => n.label).join(', ')} {needs.length > 1 ? 'are' : 'is'} missing. Open Setup →
          </a>
        )}
        <form class="idea" onSubmit={build}>
          <h1>What should the world be?</h1>
          <textarea rows={3} placeholder="A lighthouse keeper's last night before the foghorn is switched off for good…" value={idea} onInput={(e) => setIdea(e.currentTarget.value)} />
          <div class="row">
            <label>Name <input value={name} onInput={(e) => setSlug(e.currentTarget.value)} pattern="[a-z][a-z0-9\-]*" /></label>
            <label>Places <select value={places} onChange={(e) => setPlaces(Number(e.currentTarget.value))}>{[2, 3, 4, 5, 6].map((n) => <option value={n}>{n}</option>)}</select></label>
            <span class="grow" />
            <button type="submit" class="primary" disabled={idea.trim().length < 10 || !!taken}>{taken ? 'Name taken' : 'Build it'}</button>
          </div>
          {error && <p class="error">{error}</p>}
        </form>
        <section>
          <div class="row">
            <h2>Worlds{worlds ? ` · ${worlds.length}` : ''}</h2>
            <span class="grow" />
            {(worlds?.length ?? 0) > 6 && <input type="search" placeholder="Find a world" value={query} onInput={(e) => setQuery(e.currentTarget.value)} />}
          </div>
          {worlds && worlds.length === 0 && <p class="note">No worlds yet. Describe one above.</p>}
          <ul class="worlds">
            {shown.map((w) => (
              <li>
                <a href={`/w/${w.slug}`} onClick={(e) => (e.preventDefault(), go(`/w/${w.slug}`))}>
                  {w.cover ? <img src={fileUrl(w.slug, w.cover.file, w.cover.v)} alt="" loading="lazy" /> : <div class="noimg" />}
                  <strong>{w.title}</strong>
                  <span class="detail">{w.issue ?? `${w.places} places · ${w.playable} playable`}</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  );
}

type Line = { seq: number; text: string; kind: string };

function Workshop({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState<Record<string, 'run' | 'fail'>>({});
  const [calls, setCalls] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);

  const refresh = () => call<Status>('world_status', { slug }).then((s) => (setStatus(s), setError(''))).catch((e) => setError(e.status === 404 ? '' : e.message));
  useEffect(() => {
    refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => {
      clearTimeout(timer);
      timer = setTimeout(refresh, 300);
    };
    const add = (e: StudioEvent, text: string, kind: string) => setLines((l) => [...l.slice(-400), { seq: e.seq, text, kind }]);
    const stop = follow(slug, (e) => {
      switch (e.type) {
        case 'log': return add(e, String(e.line), e.stream === 'err' ? 'err' : 'out');
        case 'step.start': setRunning((r) => ({ ...r, [String(e.step)]: 'run' })); return add(e, `▸ ${e.step}`, 'step');
        case 'step.end': setRunning((r) => { const n = { ...r }; delete n[String(e.step)]; return n; }); soon(); return add(e, `✓ ${e.step} · ${e.seconds}s`, 'step');
        case 'step.fail': setRunning((r) => ({ ...r, [String(e.step)]: 'fail' })); return add(e, `✕ ${e.step}: ${e.error}`, 'err');
        case 'call': if (!e.hit) setCalls((c) => c + 1); return;
        case 'file.changed': return soon();
        case 'job.start': case 'job.end': case 'job.queued': {
          const job = e.job as Job;
          soon();
          return add(e, `${e.type === 'job.end' ? (job.state === 'done' ? 'done' : job.state) : e.type === 'job.start' ? 'started' : 'queued'}: ${job.label} (by ${job.by})${job.error ? ` · ${job.error}` : ''}`, e.type === 'job.end' && job.state !== 'done' ? 'err' : 'job');
        }
        case 'history.undo': soon(); return add(e, `${e.by === 'agent' ? 'agent' : 'you'}: undo to ${e.id} · ${(e.restored as string[]).length} restored, ${(e.removed as string[]).length} removed`, e.by === 'agent' ? 'agent' : 'act');
        case 'lock.changed': return add(e, `${e.by === 'agent' ? 'agent' : 'you'}: ${e.locked ? 'locked' : 'unlocked'} ${e.place ?? 'the world'}`, 'act');
        case 'action.start': if (quiet.has(String(e.action)) && e.by !== 'agent') return; return add(e, `${e.by === 'agent' ? 'agent' : 'you'}: ${e.action}`, e.by === 'agent' ? 'agent' : 'act');
        case 'ui.focus':
          if (!followAgent.value || e.by !== 'agent') return;
          if (e.place) setFocus(String(e.place));
          if (e.view === 'setup') go('/setup');
          if (e.view === 'start') go('/');
          return;
      }
    }, setLive);
    return () => (stop(), clearTimeout(timer));
  }, [slug]);

  const job = status?.jobs.findLast((j) => j.state === 'running' || j.state === 'queued');
  const stepState = (s: string): 'ok' | 'run' | 'fail' | 'todo' => running[s] ?? (status?.build[s] ? 'ok' : 'todo');
  const placeFocus = useMemo(() => status?.placeDetail.find((p) => p.key === focus), [status, focus]);

  return (
    <>
      <Header world={slug} live={live} />
      <main class="workshop">
        <div class="left">
          <div class="row">
            <h1>{status?.title ?? slug}</h1>
            <span class="grow" />
            {!job && status && status.steps.length > 0 && <button type="button" class="ghost" title="Put the world back as it was before the last job" onClick={() => call('history_undo', { slug }).catch((e) => setError(e.message))}>Undo last job</button>}
            {job
              ? <button type="button" class="ghost" onClick={() => call('job_cancel', { id: job.id })}>Stop {job.label}</button>
              : <button type="button" class="primary" disabled={!status || !!status.issue} onClick={() => call('world_build', { slug }).catch((e) => setError(e.message))}>{status && status.steps.length >= steps.length - 1 ? 'Rebuild verify' : 'Continue build'}</button>}
          </div>
          {status?.pitch && <p class="lead">{status.pitch}</p>}
          {error && <p class="error">{error}</p>}
          <ol class="steps" aria-label="Build steps">
            {steps.map((s) => <li class={stepState(s)} title={status?.build[s] ? `${status.build[s].seconds}s` : undefined}><Mark state={stepState(s)} />{s}</li>)}
          </ol>
          <ul class="places">
            {status?.placeDetail.map((p) => (
              <li class={focus === p.key ? 'focus' : ''}>
                <button type="button" class="card" onClick={() => setFocus(focus === p.key ? null : p.key)}>
                  {p.image ? <img src={fileUrl(slug, p.image.file, p.image.v)} alt={p.shows} loading="lazy" /> : <div class="noimg">{p.stages.layout ? 'laid out' : 'waiting'}</div>}
                  <span class="name">
                    <strong>{p.key}</strong>
                    {p.verdict ? <span class={`badge ${p.verdict.ok ? 'ok' : 'fail'}`}>{p.verdict.ok ? 'playable' : `${p.verdict.errors.length} errors`}</span> : <span class="badge">{Object.values(p.stages).filter(Boolean).length}/7</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {placeFocus && (
            <section class="inspect">
              <h2>{placeFocus.key}</h2>
              <p class="detail">{placeFocus.shows}</p>
              <p class="detail">{placeFocus.things.map((t) => `${t.key} (${t.role})`).join(' · ')}</p>
              {placeFocus.verdict && [...placeFocus.verdict.errors.map((f) => ['error', f] as const), ...placeFocus.verdict.flags.map((f) => ['flag', f] as const)].map(([kind, f]) => (
                <p class={kind === 'error' ? 'error' : 'flag'}><code>{f.code}</code>{f.key ? ` ${f.key}` : ''}: {f.detail}</p>
              ))}
            </section>
          )}
        </div>
        <aside class="right">
          <AgentPanel slug={slug} />
          <section class="log">
            <div class="row"><h2>Activity</h2><span class="grow" /><span class="detail">{calls} model calls this session{status ? ` · ${Object.entries(status.calls).map(([m, n]) => `${m} ${n}`).join(', ') || 'none yet'} total` : ''}</span></div>
            <ol>{[...lines].reverse().map((l) => <li key={l.seq} class={l.kind}>{l.text}</li>)}</ol>
          </section>
        </aside>
      </main>
    </>
  );
}

type Bubble = { key: number; kind: 'user' | 'agent' | 'tool' | 'error' | 'note'; text: string; ok?: boolean };

/** Chat with the Muse Code agent about this world. Its tool calls are Studio actions, so they also show in Activity. */
function AgentPanel({ slug }: { slug: string }) {
  const [items, setItems] = useState<Bubble[]>([]);
  const [stream, setStream] = useState('');
  const [running, setRunning] = useState(false);
  const [asks, setAsks] = useState<Array<{ id: string; kind: string; summary?: string }>>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    let n = 0;
    let after: number | null = null;
    const push = (kind: Bubble['kind'], body: string, ok?: boolean) => setItems((l) => [...l.slice(-200), { key: n++, kind, text: body, ok }]);
    fetch(`/api/agent/${slug}`, { headers: { authorization: `Bearer ${token}` } })
      .then((r) => r.json())
      .then((s: { seq: number; running: boolean; turns: Array<{ role: 'user' | 'agent'; text: string }>; approvals: Array<{ id: string; kind: string; summary?: string }> }) => {
        s.turns.forEach((t) => push(t.role, t.text));
        after = s.seq;
        setRunning(s.running);
        setAsks(s.approvals);
      })
      .catch(() => {});
    return follow(slug, (e) => {
      // The feed replays from the start on connect; the conversation up to `after` came from the state call above.
      if (!e.type.startsWith('agent.') || after === null || e.seq <= after) return;
      const v = e as unknown as Record<string, string | boolean | undefined>;
      switch (e.type) {
        case 'agent.user': return push('user', String(v.text));
        case 'agent.turn.start': setRunning(true); return setStream('');
        case 'agent.delta': return setStream((t) => t + String(v.text));
        case 'agent.message': setStream(''); return push('agent', String(v.text));
        case 'agent.tool': return push('tool', String(v.name));
        case 'agent.tool.end': return setItems((l) => l.map((b) => (b.kind === 'tool' && b.text === v.name && b.ok === undefined ? { ...b, ok: !v.isError } : b)));
        case 'agent.error': return push('error', String(v.text));
        case 'agent.approval': return setAsks((a) => [...a, (e as unknown as { request: { id: string; kind: string; summary?: string } }).request]);
        case 'agent.approval.resolved': return setAsks((a) => a.filter((x) => x.id !== v.id));
        case 'agent.turn.end':
          setRunning(false);
          setStream('');
          if (v.status !== 'completed' && v.status !== 'aborted') push('error', /ENOENT|spawn|not found/i.test(String(v.error)) ? 'Muse Code is not installed or not on PATH: see Setup.' : `The agent stopped: ${v.error ?? v.status}`);
          return;
      }
    });
  }, [slug]);
  const send = async (e?: Event) => {
    e?.preventDefault();
    const say = text.trim();
    if (!say) return;
    setText('');
    setError('');
    const res = await fetch(`/api/agent/${slug}/say`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ text: say }) });
    if (!res.ok) setError(((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not send (${res.status})`);
  };
  const post = (verb: string, body: object = {}) => fetch(`/api/agent/${slug}/${verb}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (
    <section class="agent">
      <div class="row"><h2>Muse Code</h2><span class="grow" /><span class={`live ${running ? 'on' : ''}`}>{running ? 'working…' : 'ready'}</span></div>
      <ol class="chat">
        {items.length === 0 && <li class="note">Ask for a world, a fix or a check. Everything the agent does runs through the same actions as the buttons, and you can undo its jobs.</li>}
        {items.map((b) => (
          <li key={b.key} class={b.kind}>{b.kind === 'tool' ? <><span class={`mark ${b.ok === undefined ? 'run' : b.ok ? 'ok' : 'fail'}`}>{b.ok === undefined ? '◌' : b.ok ? '✓' : '✕'}</span>{b.text}</> : b.text}</li>
        ))}
        {stream && <li class="agent streaming">{stream}</li>}
      </ol>
      {asks.map((a) => (
        <div class="ask" key={a.id}>
          <span>The agent asks to run: <code>{a.summary ?? a.kind}</code></span>
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

function NoToken() {
  return (
    <main class="narrow">
      <h1>Open Studio from your terminal</h1>
      <p class="lead">This page only opens through the link <code>diorama studio</code> prints, so no other site or program can drive it.</p>
      <pre>diorama studio</pre>
    </main>
  );
}

function App() {
  const [ready, setReady] = useState<'wait' | 'ok' | string>('wait');
  useEffect(() => {
    if (!token) return;
    Promise.all([openSession(), listActions()])
      .then(([, list]) => {
        steps = list.find((a) => a.name === 'run_step')?.input.properties?.step?.enum ?? [];
        quiet = new Set(list.filter((a) => a.reads).map((a) => a.name));
        setReady('ok');
      })
      .catch((e) => setReady(e.message));
    // The agent can move the view to another world.
    return follow(null, (e) => {
      if (e.type === 'ui.focus' && e.by === 'agent' && followAgent.value && e.slug) go(`/w/${e.slug}`);
    });
  }, []);
  if (!token) return <NoToken />;
  if (ready === 'wait') return <main class="narrow"><p class="lead">Opening…</p></main>;
  if (ready !== 'ok') return <main class="narrow"><h1>Studio</h1><p class="error">{ready}</p></main>;
  const path = route.value;
  if (path === '/setup') return <Setup />;
  const world = /^\/w\/([a-z][a-z0-9-]*)/.exec(path)?.[1];
  if (world) return <Workshop key={world} slug={world} />;
  return <Start />;
}

render(<App />, document.getElementById('app')!);
