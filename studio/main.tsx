// Diorama Studio: Start (worlds and a new idea), Setup (what this machine needs) and the Workshop (a world
// building live). Everything here goes through actions, the same ones `diorama action` and the agent use.
import { render } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useState } from 'preact/hooks';
import { askAgent, call, fileUrl, follow, listActions, openSession, token, type StudioEvent } from './api.ts';
import { AgentPanel } from './agent.tsx';
import { CastView } from './cast.tsx';
import { StoryView } from './story.tsx';
import { PlaceEditor } from './place.tsx';

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
type Job = { id: string; label: string; args: string[]; unplayable?: Array<{ place: string; errors: string[] }>; state: string; by: string; step?: string; error?: string; startedAt?: string; endedAt?: string; tail: string[] };
type Note = { id: string; at: string; by: string; place?: string; point?: [number, number]; text: string; state: 'open' | 'done'; reply?: string };
type Spend = { usd: number; priced: boolean; calls: Record<string, number> };
type Budget = { total: Spend; today: Spend; limitUsd: number | null; over: boolean; prices: Record<string, number> };
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
        <BudgetBox />
      </main>
    </>
  );
}

const MODEL_NAMES: Record<string, string> = { spark: 'Muse Spark', muse: 'Muse Image', sam: 'SAM 3.1', sound: 'ElevenLabs sound', voice: 'Voices', music: 'Music', space: 'HF Spaces' };

/** What the models cost so far, and the prices and limit to count it by. */
function BudgetBox() {
  const [b, setB] = useState<Budget | null>(null);
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState('');
  const [saved, setSaved] = useState('');
  const load = () => call<Budget>('budget').then((x) => {
    setB(x);
    setPrices(Object.fromEntries(Object.entries(x.prices).map(([k, v]) => [k, String(v)])));
    setLimit(x.limitUsd === null ? '' : String(x.limitUsd));
  }).catch(() => {});
  useEffect(() => void load(), []);
  const save = async (e: Event) => {
    e.preventDefault();
    const p = Object.fromEntries(Object.entries(prices).filter(([, v]) => v.trim() !== '' && !Number.isNaN(Number(v))).map(([k, v]) => [k, Number(v)]));
    await call('budget_set', { prices: p, ...(limit.trim() && { limitUsd: Number(limit) }) });
    setSaved('Saved');
    setTimeout(() => setSaved(''), 1500);
    void load();
  };
  if (!b) return null;
  const models = Object.keys(MODEL_NAMES).filter((m) => b.total.calls[m] || m in b.prices || ['spark', 'muse', 'sam'].includes(m));
  return (
    <form class="budget" onSubmit={save}>
      <h2>Budget</h2>
      <p class="lead">{b.total.priced ? `$${b.total.usd.toFixed(2)} spent` : `${Object.values(b.total.calls).reduce((x, y) => x + y, 0)} model calls sent`}{b.limitUsd !== null ? ` of $${b.limitUsd}` : ''}, {b.today.priced ? `$${b.today.usd.toFixed(2)}` : `${Object.values(b.today.calls).reduce((x, y) => x + y, 0)} calls`} today. Answers already asked are reused for free.</p>
      <p class="note">Dollars per call, from your Meta and ElevenLabs billing pages. Without a price a model is only counted.</p>
      <div class="prices">
        {models.map((m) => <label>{MODEL_NAMES[m]} · {b.total.calls[m] ?? 0} calls<input inputMode="decimal" placeholder="$ per call" value={prices[m] ?? ''} onInput={(e) => setPrices({ ...prices, [m]: e.currentTarget.value })} /></label>)}
        <label>Warn at ($)<input inputMode="decimal" placeholder="150" value={limit} onInput={(e) => setLimit(e.currentTarget.value)} /></label>
      </div>
      <div class="row"><button type="submit" class="ghost small">Save</button><span class="detail">{saved}</span></div>
    </form>
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

// ?replay=<session file> plays a recorded conversation back in the agent panel (for the film); ?speed=2 doubles it.
const query = new URLSearchParams(location.search);
const replay = query.get('replay');
const speed = Number(query.get('speed') ?? '1') || 1;

function Workshop({ slug }: { slug: string }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState('');
  const [live, setLive] = useState(false);
  const [lines, setLines] = useState<Line[]>([]);
  const [running, setRunning] = useState<Record<string, 'run' | 'fail'>>({});
  const [calls, setCalls] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [playing, setPlaying] = useState<{ place?: string; round?: number } | null>(null);
  const [view, setView] = useState<'places' | 'story' | 'cast'>('places');
  const [notes, setNotes] = useState<Note[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);

  const refresh = () => {
    setTick((t) => t + 1);
    call<Note[]>('feedback_list', { slug }).then(setNotes).catch(() => {});
    call<Budget>('budget').then(setBudget).catch(() => {});
    return call<Status>('world_status', { slug }).then((s) => (setStatus(s), setError(''))).catch((e) => setError(e.status === 404 ? '' : e.message));
  };
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
        case 'file.changed': case 'feedback.changed': return soon();
        case 'job.start': case 'job.end': case 'job.queued': {
          const job = e.job as Job;
          soon();
          return add(e, `${e.type === 'job.end' ? (job.state === 'done' ? 'done' : job.state) : e.type === 'job.start' ? 'started' : 'queued'}: ${job.label} (by ${job.by})${job.error ? ` · ${job.error}` : ''}`, e.type === 'job.end' && job.state !== 'done' ? 'err' : 'job');
        }
        case 'history.undo': soon(); return add(e, `${e.by === 'agent' ? 'agent' : 'you'}: undo to ${e.id} · ${(e.restored as string[]).length} restored, ${(e.removed as string[]).length} removed`, e.by === 'agent' ? 'agent' : 'act');
        case 'lock.changed': return add(e, `${e.by === 'agent' ? 'agent' : 'you'}: ${e.locked ? 'locked' : 'unlocked'} ${e.place ?? 'the world'}`, 'act');
        case 'action.start': if (quiet.has(String(e.action)) && e.by !== 'agent') return; return add(e, `${e.by === 'agent' ? 'agent' : 'you'}: ${e.action}`, e.by === 'agent' ? 'agent' : 'act');
        case 'ui.focus':
          if (e.by !== 'agent') return;
          // A reload of the open game is always fine; moving the view only when the person follows the agent.
          if (e.view === 'play' && e.reload) setPlaying((p) => (p ? { ...p, round: (p.round ?? 0) + 1 } : followAgent.value ? { place: e.place as string | undefined } : p));
          if (!followAgent.value) return;
          if (e.view === 'play' && !e.reload) setPlaying((p) => ({ place: e.place as string | undefined, round: (p?.round ?? 0) + 1 }));
          if (e.view === 'story' || e.view === 'cast') setView(e.view);
          if (e.view === 'workshop') setView('places');
          if (e.place && e.view !== 'play') setFocus(String(e.place));
          if (e.view === 'setup') go('/setup');
          if (e.view === 'start') go('/');
          return;
      }
    }, setLive);
    return () => (stop(), clearTimeout(timer));
  }, [slug]);

  const job = status?.jobs.findLast((j) => j.state === 'running' || j.state === 'queued');
  const last = status?.jobs.at(-1);
  const failed = last && last.state === 'failed' ? last : null;
  const stepState = (s: string): 'ok' | 'run' | 'fail' | 'todo' => running[s] ?? (status?.build[s] ? 'ok' : 'todo');
  const placeFocus = useMemo(() => status?.placeDetail.find((p) => p.key === focus), [status, focus]);
  
  const playable = !!status?.placeDetail.some((p) => p.stages.layout);
  const playLine = (text: string) => setLines((l) => [...l.slice(-400), { seq: -Date.now() - Math.random(), text, kind: 'play' }]);

  return (
    <>
      <Header world={slug} live={live} />
      <main class="workshop">
        <div class="left">
          <div class="row">
            <h1>{status?.title ?? slug}</h1>
            <span class="grow" />
            {playable && <button type="button" class={playing ? 'primary' : 'ghost'} onClick={() => setPlaying(playing ? null : {})}>{playing ? 'Close game' : 'Play'}</button>}
            {!job && status && status.steps.length > 0 && <button type="button" class="ghost" title="Put the world back as it was before the last job" onClick={() => call('history_undo', { slug }).catch((e) => setError(e.message))}>Undo last job</button>}
            {/* Stop sits beside the build button, never in its place: a double click must not start a build and stop it again. */}
            {job && <button type="button" class="ghost" title={`Stop ${job.label} (started by ${job.by === 'agent' ? 'the agent' : 'you'})`} onClick={() => call('job_cancel', { id: job.id })}>Stop</button>}
            <button type="button" class="primary" disabled={!status || !!status.issue || !!job} title={job ? `${job.label} is running${job.step ? `: ${job.step}` : ''}` : undefined} onClick={() => call('world_build', { slug }).catch((e) => setError(e.message))}>
              {job ? `${job.by === 'agent' ? 'Agent: ' : ''}${job.label}…` : status && status.steps.length >= steps.length - 1 ? 'Rebuild verify' : 'Continue build'}
            </button>
          </div>
          {status?.pitch && <p class="lead">{status.pitch}</p>}
          {error && <p class="error">{error}</p>}
          {failed && !job && <Failed slug={slug} job={failed} onError={setError} onPlace={setFocus} />}
          {budget?.over && <p class="banner">Budget: ${budget.total.usd} spent of the ${budget.limitUsd} limit. Check Setup before the next big build.</p>}
          {playing && <Play slug={slug} place={playing.place} round={playing.round ?? 0} onRestart={() => setPlaying({ ...playing, round: (playing.round ?? 0) + 1 })} version={tick} onLine={playLine} onError={setError} />}
          <ol class="steps" aria-label="Build steps">
            {steps.map((s) => <li class={stepState(s)} title={status?.build[s] ? `${status.build[s].seconds}s` : undefined}><Mark state={stepState(s)} />{s}</li>)}
          </ol>
          <div class="seg" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={view === 'places'} class={view === 'places' ? 'on' : ''} onClick={() => setView('places')}>Places</button>
            <button type="button" role="tab" aria-selected={view === 'story'} class={view === 'story' ? 'on' : ''} onClick={() => setView('story')}>Story</button>
            <button type="button" role="tab" aria-selected={view === 'cast'} class={view === 'cast' ? 'on' : ''} onClick={() => setView('cast')}>Cast</button>
          </div>
          {view === 'story' && <StoryView slug={slug} version={tick} onError={setError} />}
          {view === 'cast' && <CastView slug={slug} version={tick} onError={setError} />}
          {view === 'places' && <ul class="places">
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
          </ul>}
          {view === 'places' && placeFocus && (
            <section class="inspect">
              <p class="detail">{placeFocus.shows}</p>
              {placeFocus.verdict && [...placeFocus.verdict.errors.map((f) => ['error', f] as const), ...placeFocus.verdict.flags.map((f) => ['flag', f] as const)].map(([kind, f]) => (
                <p class={kind === 'error' ? 'error' : 'flag'}><code>{f.code}</code>{f.key ? ` ${f.key}` : ''}: {f.detail}</p>
              ))}
              {placeFocus.stages.layout && <button type="button" class="ghost small" onClick={() => setPlaying({ place: placeFocus.key })}>Play from {placeFocus.key}</button>}
              {placeFocus.stages.painting ? <PlaceEditor slug={slug} place={placeFocus.key} version={tick} onError={setError} /> : <p class="detail">Fixing opens once the place is painted.</p>}
            </section>
          )}
          <Notes slug={slug} notes={notes} onPlace={setFocus} onError={setError} />
        </div>
        <aside class="right">
          <AgentPanel slug={slug} replay={replay} speed={speed} jobs={status?.jobs ?? []} />
          <section class="log">
            <div class="row"><h2>Activity</h2><span class="grow" /><span class="detail" title={status ? `this world: ${Object.entries(status.calls).map(([m, n]) => `${m} ${n}`).join(', ') || 'no calls yet'}` : undefined}>{calls} calls this session{budget ? ` · ${spend(budget.today)} today · ${spend(budget.total)}${budget.limitUsd !== null ? ` of $${budget.limitUsd}` : ''} total` : ''}</span></div>
            <ol>{[...lines].reverse().map((l) => <li key={l.seq} class={l.kind}>{l.text}</li>)}</ol>
          </section>
        </aside>
      </main>
    </>
  );
}

/** The game in a frame: the same page `diorama play` serves. What happens in it goes to Activity. */
function Play({ slug, place, round, onRestart, version, onLine, onError }: { slug: string; place?: string; round: number; onRestart: () => void; version: number; onLine: (t: string) => void; onError: (m: string) => void }) {
  const [fresh, setFresh] = useState(true);
  const [loadedAt, setLoadedAt] = useState(version);
  useEffect(() => void (version !== loadedAt && setFresh(false)), [version]);
  const src = `/play/${slug}/${place ? `?place=${encodeURIComponent(place)}` : ''}`;
  const hook = (e: Event) => {
    setFresh(true);
    setLoadedAt(version);
    const game = ((e.currentTarget as HTMLIFrameElement).contentWindow as unknown as { diorama?: { on(fn: (ev: string, d: Record<string, unknown>) => void): void } } | null)?.diorama;
    game?.on((ev, d) => {
      const say: Record<string, string> = {
        enter: `entered ${d.place}`, exit: `left ${d.from} for ${d.to}`, use: `${d.verb ?? 'used'} ${d.thing}`, say: `"${String(d.text ?? '').slice(0, 80)}"`, ending: `reached the ending ${d.ending}`,
      };
      if (say[ev]) onLine(`play: ${say[ev]}`);
    });
  };
  return (
    <section class="play">
      <div class="row">
        <strong>Playing{place ? ` from ${place}` : ''}</strong>
        <span class="detail">click to walk or use, right click to look</span>
        <span class="grow" />
        <button type="button" class="ghost small" onClick={onRestart}>Restart</button>
        <button type="button" class="ghost small" title="The bot plays every route to an ending and says where it got stuck" onClick={() => call('playthrough', { slug }).catch((err) => onError(err.message))}>Bot playthrough</button>
      </div>
      {!fresh && (
        <div class="banner row" role="status">
          <span>The world changed since this game started.</span>
          <span class="grow" />
          <button type="button" class="primary small" onClick={onRestart}>Reload the game</button>
        </div>
      )}
      <iframe key={`${src}#${round}`} src={src} title={`${slug}, playable`} onLoad={hook} allow="autoplay" />
    </section>
  );
}

const spend = (s: Spend) => (s.priced && Object.keys(s.calls).length > 0 ? `$${s.usd.toFixed(2)}` : `${Object.values(s.calls).reduce((a, b) => a + b, 0)} calls${s.usd ? ` ($${s.usd.toFixed(2)}+)` : ''}`);

/** The last job failed: where, why, its last lines, and what to do next. */
function Failed({ slug, job, onError, onPlace }: { slug: string; job: Job; onError: (m: string) => void; onPlace: (p: string) => void }) {
  const [more, setMore] = useState(false);
  const lines = job.tail.filter((l) => l.trim());
  const step = job.step;
  const retry = () => call('job_retry', { id: job.id }).catch((e) => onError(e.message));
  const ask = () => askAgent(slug, `The job "${job.label}" failed${step ? ` at the ${step} step` : ''}: ${job.error ?? 'see its output'}. Find out why with world_status and place_status, fix it only with the Studio fix tools (never by editing files), and tell me what you did.`).catch((e) => onError(e.message));
  return (
    <section class="failed" role="alert">
      <div class="row"><strong>{job.label} failed{step ? ` at ${step}` : ''}</strong><span class="detail">by {job.by}</span></div>
      {job.unplayable?.length ? job.unplayable.map((u) => (
        <div class="row"><button type="button" class="ghost small" onClick={() => onPlace(u.place)}>{u.place}</button><span class="error">{u.errors.join(' · ') || 'not playable: see verify.json'}</span></div>
      )) : job.error && <p class="error">{job.error}</p>}
      {lines.length > 0 && <pre>{(more ? lines : lines.slice(-6)).join('\n')}</pre>}
      <div class="row">
        <button type="button" class="primary small" onClick={retry}>Try again</button>
        <button type="button" class="ghost small" onClick={ask}>Ask the agent</button>
        <button type="button" class="ghost small" title="Put the world back as it was before this job" onClick={() => call('history_undo', { slug }).catch((e) => onError(e.message))}>Undo it</button>
        <span class="grow" />
        {lines.length > 6 && <button type="button" class="ghost small" onClick={() => setMore(!more)}>{more ? 'Less' : `All ${lines.length} lines`}</button>}
      </div>
    </section>
  );
}

/** The person's notes on this world: open ones wait for a fix, done ones say what was done. */
function Notes({ slug, notes, onPlace, onError }: { slug: string; notes: Note[]; onPlace: (p: string) => void; onError: (m: string) => void }) {
  const [text, setText] = useState('');
  const open = notes.filter((n) => n.state === 'open');
  const done = notes.filter((n) => n.state === 'done').slice(-5).reverse();
  const add = (e: Event) => {
    e.preventDefault();
    call('feedback_add', { slug, text: text.trim() }).then(() => setText('')).catch((err) => onError(err.message));
  };
  return (
    <section class="notes">
      <div class="row">
        <h2>Notes{open.length ? ` · ${open.length} open` : ''}</h2>
        <span class="grow" />
        {open.length > 0 && <button type="button" class="primary small" onClick={() => askAgent(slug, `Go through my ${open.length} open note${open.length > 1 ? 's' : ''} (feedback_pending): fix each one and close it with feedback_done.`).catch((e) => onError(e.message))}>Hand {open.length > 1 ? 'them' : 'it'} to the agent</button>}
      </div>
      <ul>
        {open.map((n) => (
          <li class="open">
            {n.place && <button type="button" class="ghost small" onClick={() => onPlace(n.place!)}>{n.place}{n.point ? ` @${n.point.join(',')}` : ''}</button>}
            <span>{n.text}</span>
            <span class="grow" />
            <button type="button" class="ghost small" onClick={() => call('feedback_done', { slug, id: n.id, reply: 'done by hand' }).catch((e) => onError(e.message))}>Done</button>
          </li>
        ))}
        {done.map((n) => (
          <li class="done">
            <span>{n.text}</span>
            <span class="detail">→ {n.reply}</span>
            <span class="grow" />
            <button type="button" class="ghost small" onClick={() => call('feedback_reopen', { slug, id: n.id }).catch((e) => onError(e.message))}>Reopen</button>
          </li>
        ))}
      </ul>
      <form class="row" onSubmit={add}>
        <input class="grow" placeholder="A note on the whole world (or pick a place and use Note on its picture)" value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <button type="submit" class="ghost small" disabled={text.trim().length < 2}>Add</button>
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
