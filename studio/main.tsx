// Diorama Studio: Start (worlds and a new idea), Setup (what this machine needs) and the Workshop (a world
// building live). Everything here goes through actions, the same ones `diorama action` and the agent use.
import { render } from 'preact';
import { signal } from '@preact/signals';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { askAgent, call, fileUrl, follow, listActions, openSession, token, type StudioEvent } from './api.ts';
import { AgentPanel } from './agent.tsx';
import { CastView } from './cast.tsx';
import { KidsStart, KidsWait, polish, setPolish, t } from './kids.tsx';
import { StoryView } from './story.tsx';
import { PlaceEditor } from './place.tsx';
import { MODEL_NAME, Pipeline, Stage, Strip, Tale, working, type Live, type StagePlace } from './build.tsx';

type Check = { id: string; label: string; state: 'ok' | 'missing' | 'optional' | 'fail'; detail: string; fix?: string[] };
type Summary = { slug: string; title: string; pitch: string | null; issue: string | null; places: number; playable: number; verified: number; steps: string[]; cover: { file: string; v: number | null } | null };
type Finding = { code: string; key?: string; detail: string };
type PlaceDetail = {
  key: string;
  shows: string;
  things: Array<{ key: string; role: string }>;
  stages: Record<string, number | null>;
  image: { file: string; v: number | null } | null;
  layers?: StagePlace['layers'];
  verdict: { ok: boolean; errors: Array<Finding & { play?: { look: string; tools: string[]; last?: string } }>; flags: Finding[] } | null;
};
type Job = { id: string; label: string; args: string[]; unplayable?: Array<{ place: string; errors: string[] }>; state: string; by: string; step?: string; error?: string; startedAt?: string; endedAt?: string; tail: string[] };
type Note = { id: string; at: string; by: string; place?: string; point?: [number, number]; text: string; state: 'open' | 'done'; reply?: string };
type Spend = { usd: number; priced: boolean; calls: Record<string, number> };
type Budget = { total: Spend; today: Spend; limitUsd: number | null; over: boolean; prices: Record<string, number> };
type Status = Summary & { placeDetail: PlaceDetail[]; build: Record<string, { seconds: number }>; typical?: Record<string, number>; calls: Record<string, number>; jobs: Job[] };

const route = signal(location.pathname);
const followAgent = signal(true);
/** The world the agent moved the view away from, so the person can go back. */
const movedFrom = signal<string | null>(null);
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

const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** Sharing: a zip to download, or the public link. The last export or publish job says where it went. */
function Share({ slug, jobs, onError }: { slug: string; jobs: Job[]; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const last = (args0: string) => jobs.findLast((j) => j.args[0] === args0 && j.state === 'done');
  const exported = last('export');
  const link = last('publish')?.tail.map((l) => /play: (https?:\S+)/.exec(l)?.[1]).find(Boolean);
  const firstTime = last('publish')?.tail.find((l) => l.includes('first publish:'))?.trim();
  const publish = () => {
    if (confirm(`Put ${slug} on the public web? Anyone with the link can play it.`)) call('world_publish', { slug }).catch((e) => onError(e.message));
  };
  return (
    <div class="share">
      <button type="button" class="ghost" aria-expanded={open} onClick={() => setOpen(!open)}>Share</button>
      {open && (
        <div class="share-menu" role="menu">
          <button type="button" class="ghost small" onClick={() => call('world_export', { slug }).catch((e) => onError(e.message))}>Make a zip</button>
          {exported && <a class="detail" href={`/exports/${slug}.zip`} download>Download {slug}.zip</a>}
          <p class="detail">A zip plays offline and goes on itch.io as an HTML game.</p>
          <button type="button" class="ghost small" onClick={publish}>Publish a link</button>
          {link && <a class="detail" href={link} target="_blank" rel="noopener">{link}</a>}
          {firstTime && <p class="detail">{firstTime}</p>}
          <p class="detail">Puts it on this repository's GitHub Pages, public.</p>
        </div>
      )}
    </div>
  );
}

/** In a workshop run in Polish (pl), the header says nothing in English. */
function Header({ world, live, pl }: { world?: string; live?: boolean; pl?: boolean }) {
  return (
    <header class="top">
      <a href="/" class="brand" onClick={(e) => (e.preventDefault(), go('/'))}>
        <svg width="22" height="22" viewBox="0 0 28 28" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M3 21 L14 6 L25 21 Z" /><path d="M3 21 H25" /><path d="M9 21 L14 14 L19 21" /></svg>
        Diorama Studio
      </a>
      {world && <><span class="sep">/</span><span class="crumb">{world}</span></>}
      <span class="grow" />
      {live !== undefined && <span class={`live ${live ? 'on' : ''}`}>{live ? 'live' : 'reconnecting'}</span>}
      <label class="follow"><input type="checkbox" checked={followAgent.value} onChange={(e) => (followAgent.value = e.currentTarget.checked)} /> {pl ? 'Śledź agenta' : 'Follow agent'}</label>
      <a href="/setup" class="navlink" onClick={(e) => (e.preventDefault(), go('/setup'))}>{pl ? 'Ustawienia' : 'Setup'}</a>
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
        <p class="lead">{!checks ? 'Checking this machine…' : blocking.length ? `${blocking.map((c) => c.label).join(' and ')} still ${blocking.length > 1 ? 'need' : 'needs'} you. Everything else is ready or optional.` : `Everything diorama needs is here.${ok < checks.length ? ' The unticked ones are optional.' : ''}`}</p>
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
          <button type="button" class="ghost" disabled={!!busy || checks?.find((c) => c.id === 'META_API_KEY')?.state === 'missing'} onClick={() => run('setup_check')}>{busy === 'setup_check' ? 'Calling Meta…' : 'Test the Meta key live'}</button>
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

/** A workshop world's default name: the day it was made. */
/** A workshop world's default name: the day it was made, numbered when a game of that day is already built. */
const today = (worlds: Summary[] | null) => {
  const day = `workshop-${new Date().toISOString().slice(5, 10)}`;
  const built = (slug: string) => worlds?.some((w) => w.slug === slug && w.issue !== 'no world.json yet');
  let n = 1;
  while (built(n === 1 ? day : `${day}-${n}`)) n++;
  return n === 1 ? day : `${day}-${n}`;
};

function Start() {
  const [worlds, setWorlds] = useState<Summary[] | null>(null);
  const [needs, setNeeds] = useState<Check[]>([]);
  // Without the Meta key a build fails in its first step; say so before anyone waits for it.
  const noKey = needs.some((n) => n.id === 'META_API_KEY');
  const [idea, setIdea] = useState('');
  // ?kids=<slug> opens a workshop world that is not built yet: its drawings and recordings.
  const [kids, setKids] = useState(new URLSearchParams(location.search).has('kids'));
  const [slug, setSlug] = useState(new URLSearchParams(location.search).get('kids') ?? '');
  const [places, setPlaces] = useState(kids ? 3 : 4);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  useEffect(() => {
    call<Summary[]>('world_list').then(setWorlds).catch((e) => setError(e.message));
    call<Check[]>('setup_status').then((c) => setNeeds(c.filter((x) => x.state === 'missing' || x.state === 'fail'))).catch(() => {});
  }, []);
  const name = slug || (kids ? today(worlds) : slugify(idea));
  const taken = worlds?.some((w) => w.slug === name && !(kids && w.issue === 'no world.json yet'));
  const build = async (e?: Event, told?: string) => {
    e?.preventDefault();
    if (kids && told === undefined) return;
    setError('');
    try {
      await call('world_build', { slug: name, idea: (told ?? idea).trim(), places });
      go(`/w/${name}`);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  // A workshop run in Polish shows no English: the children may be looking.
  const pl = kids && polish.value;
  const say = (inPolish: string, english: string) => (pl ? inPolish : english);
  const shown = (worlds ?? []).filter((w) => !query || `${w.title} ${w.slug} ${w.pitch ?? ''}`.toLowerCase().includes(query.toLowerCase()));
  return (
    <>
      <Header pl={pl} />
      <main class="wide">
        {needs.length > 0 && (
          <a class="banner" href="/setup" onClick={(e) => (e.preventDefault(), go('/setup'))}>
            {say(`Ustawienia: brakuje ${needs.map((n) => n.label).join(', ')}. Otwórz ustawienia →`, `Setup: ${needs.map((n) => n.label).join(', ')} ${needs.length > 1 ? 'are' : 'is'} missing. Open Setup →`)}
          </a>
        )}
        <form class="idea" onSubmit={build}>
          <div class="row">
            <h1 class="grow">{kids ? say('Gra z dziecięcych rysunków', 'A game from children\'s drawings') : 'What should the world be?'}</h1>
            <div class="tabs">
              <button type="button" class={`ghost small${kids ? '' : ' on'}`} onClick={() => (setKids(false), setPlaces(4))}>{say('Opisz', 'Describe it')}</button>
              <button type="button" class={`ghost small${kids ? ' on' : ''}`} onClick={() => (setKids(true), setPlaces(3))}>{say('Rysunki i głosy', 'Drawings and voices')}</button>
              {kids && <button type="button" class="ghost small" title={say('Warsztat po angielsku', 'Run the workshop in Polish')} onClick={() => setPolish(!polish.value)}>{polish.value ? 'EN' : 'PL'}</button>}
            </div>
          </div>
          {!kids && <textarea rows={3} placeholder="A lighthouse keeper's last night before the foghorn is switched off for good…" value={idea} onInput={(e) => setIdea(e.currentTarget.value)} />}
          {(() => {
            const settings = (
              <div class="row">
                <label>{say('Nazwa', 'Name')} <input value={name} onInput={(e) => setSlug(e.currentTarget.value)} pattern="[a-z][a-z0-9\-]*" /></label>
                <label>{say('Miejsca', 'Places')} <select value={places} onChange={(e) => setPlaces(Number(e.currentTarget.value))}>{[2, 3, 4, 5, 6].map((n) => <option value={n}>{n}</option>)}</select></label>
                <span class="grow" />
                {!kids && <button type="submit" class="primary" disabled={idea.trim().length < 10 || !!taken || noKey}>{taken ? 'Name taken' : noKey ? 'Needs the Meta key' : 'Build it'}</button>}
              </div>
            );
            // In a workshop the name and the number of places wait under More: the children's steps come first.
            if (!kids) return settings;
            return /^[a-z][a-z0-9-]*$/.test(name)
              ? <KidsStart slug={name} taken={!!taken} onBuild={(told) => void build(undefined, told)} onError={setError}>{settings}</KidsStart>
              : settings;
          })()}
          {error && <p class="error">{error}</p>}
        </form>
        <section>
          <div class="row">
            <h2>{say('Światy', 'Worlds')}{worlds ? ` · ${worlds.length}` : ''}</h2>
            <span class="grow" />
            {(worlds?.length ?? 0) > 6 && <input type="search" placeholder={say('Znajdź świat', 'Find a world')} value={query} onInput={(e) => setQuery(e.currentTarget.value)} />}
          </div>
          {worlds && worlds.length === 0 && <p class="note">{say('Nie ma jeszcze światów.', 'No worlds yet. Describe one above.')}</p>}
          <ul class="worlds">
            {shown.map((w) => (
              <li>
                <a href={`/w/${w.slug}`} onClick={(e) => {
                  e.preventDefault();
                  // A workshop world not built yet opens on its drawings and recordings.
                  if (w.issue === 'no world.json yet') (setKids(true), setSlug(w.slug), setPlaces(3), scrollTo(0, 0));
                  else go(`/w/${w.slug}`);
                }}>
                  {w.cover ? <img src={fileUrl(w.slug, w.cover.file, w.cover.v)} alt="" loading="lazy" /> : <div class="noimg" />}
                  <strong>{w.title}</strong>
                  <span class="detail">{w.issue === 'no world.json yet' && pl ? 'jeszcze niezbudowany' : w.issue ?? say(`miejsca: ${w.places} · grywalne: ${w.playable}`, `${w.places} places · ${w.playable} playable`)}</span>
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
  /** Steps the running job finished, with their seconds; the last thing it printed. */
  const [jobDone, setJobDone] = useState<Record<string, number>>({});
  const [jobTail, setJobTail] = useState('');
  const [jobPlan, setJobPlan] = useState<string[] | null>(null);
  /** What the last undo or redo put back, until the next job. */
  const [undone, setUndone] = useState<string | null>(null);
  const undoneJob = useRef<string | null>(null);
  /** Activity shows what happened; what each step prints is there too, on request (the job card shows its last line). */
  const [allLines, setAllLines] = useState(false);
  /** The agent that would have repaired the last build, when it is not installed. */
  const [noAgent, setNoAgent] = useState<string | null>(null);
  /** Places the build is mending right now, with what it tries. */
  const [repairing, setRepairing] = useState<Record<string, string>>({});
  const [calls, setCalls] = useState(0);
  /** For the build stage: when each running step began, calls per model this job, the last call, the place last changed. */
  const [since, setSince] = useState<Record<string, number>>({});
  const [jobCalls, setJobCalls] = useState<Record<string, number>>({});
  const [lastCall, setLastCall] = useState<Live['lastCall']>(null);
  const [livePlace, setLivePlace] = useState<{ key: string; at: number } | null>(null);
  const [spin, setSpin] = useState(0);
  const [focus, setFocus] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  /** Right after an undo the person can take it back. */
  const [canRedo, setCanRedo] = useState(false);
  const [playing, setPlaying] = useState<{ place?: string; round?: number; full?: boolean } | null>(null);
  const [view, setView] = useState<'places' | 'story' | 'cast'>('places');
  const [notes, setNotes] = useState<Note[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  /** The build a workshop world's children are watching, until the game starts or the grown-up hides the show. */
  const [watched, setWatched] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string | null>(null);

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
        // Verify's notes on a playable place live in the place's inspector; Activity sums them up in one line.
        case 'log': {
          // place.verdict says it once, in words; the folder on this machine is nobody's business on a recording.
          const line = String(e.line).replace(/\/(?:Users|home)\/[^/\s]+/g, '~');
          if (/^\s+flag\s|^# |^calls sent:|^[a-z][a-z0-9-]*: (ok|\d+ error\(s\)), \d+ flag\(s\)$|^[a-z][a-z0-9-]*: playable, flagged and continued/.test(line)) return;
          if (line.trim()) setJobTail(line.trim().slice(0, 160));
          return add(e, line, e.stream === 'err' ? 'err' : 'out');
        }
        case 'build.start': return setJobPlan(e.steps as string[]);
        case 'step.start': setSince((t) => ({ ...t, [String(e.step)]: Date.parse(e.at) })); setRunning((r) => ({ ...r, [String(e.step)]: 'run' })); return;
        case 'step.end': setJobDone((d) => ({ ...d, [String(e.step)]: Number(e.seconds) })); setRunning((r) => { const n = { ...r }; delete n[String(e.step)]; return n; }); soon(); return add(e, `✓ ${e.step} · ${e.seconds}s`, 'step');
        case 'step.fail': setRunning((r) => ({ ...r, [String(e.step)]: 'fail' })); return add(e, `✕ ${e.step}: ${e.error}`, 'err');
        case 'call': {
          if (e.hit) return;
          setCalls((c) => c + 1);
          const by = MODEL_NAME[String(e.model)] ?? String(e.model);
          setJobCalls((c) => ({ ...c, [by]: (c[by] ?? 0) + 1 }));
          return setLastCall({ by, label: String(e.label ?? '').replace(/#\d+$/, ''), at: Date.now() });
        }
        case 'file.changed': {
          // A new picture of a place puts that place on the stage.
          const at = /^places\/([^/]+)\/(blockin|painting|masks\/overlay|depth|walk)\.png$/.exec(String(e.file));
          if (at && e.exists) setLivePlace({ key: at[1], at: Date.now() });
          return soon();
        }
        case 'feedback.changed': return soon();
        case 'job.start': case 'job.end': case 'job.queued': {
          if (e.type === 'job.start') (setCanRedo(false), setJobDone({}), setJobTail(''), setJobPlan(null), setRunning({}), setUndone(null), setNoAgent(null), setSince({}), setJobCalls({}), setLastCall(null));
          const job = e.job as Job;
          soon();
          // What the agent changed shows in an open game at once; after the person's own builds the banner offers it.
          if (e.type === 'job.end' && job.by === 'agent' && job.state === 'done') setPlaying((p) => (p ? { ...p, round: (p.round ?? 0) + 1 } : p));
          return add(e, `${e.type === 'job.end' ? (job.state === 'done' ? 'done' : job.state) : e.type === 'job.start' ? 'started' : 'queued'}: ${job.label} (by ${job.by})${job.error ? ` · ${job.error}` : ''}`, e.type === 'job.end' && job.state !== 'done' ? 'err' : 'job');
        }
        case 'history.undo': {
          soon();
          setCanRedo(!e.redo);
          // A redo puts back what the undo took away, so it is named the same.
          if (!e.redo) undoneJob.current = String(e.label ?? '').replace(/^before /, '') || 'the last job';
          const files = (e.restored as string[]).length + (e.removed as string[]).length;
          setUndone(`${e.by === 'agent' ? `The agent ${e.redo ? 'redid' : 'undid'}` : e.redo ? 'Redone' : 'Undone'}: ${undoneJob.current ?? 'the last job'} · ${files} file${files === 1 ? '' : 's'}`);
          setPlaying((p) => (p ? { ...p, round: (p.round ?? 0) + 1 } : p));
          return add(e, `${e.by === 'agent' ? 'agent' : 'you'}: ${e.redo ? 'redo' : `undo to ${e.id}`} · ${(e.restored as string[]).length} restored, ${(e.removed as string[]).length} removed`, e.by === 'agent' ? 'agent' : 'act');
        }
        // The build mending itself: free fixes first, then the agent is asked.
        case 'place.fail': return add(e, `✕ ${e.place}: ${e.step} failed, set aside · ${e.error}`, 'err');
        case 'place.verdict': if (e.ok) { const n = (e.flagged as string[] | undefined)?.length ?? 0; return add(e, `✓ ${e.place}: playable${n ? ` · ${n} note${n === 1 ? '' : 's'}, nothing to do (open the place to read them)` : ''}`, 'step'); } return add(e, `✕ ${e.place}: not playable · ${(e.errors as string[] | undefined)?.join('; ') || 'see verify'}`, 'err');
        case 'repair.start': setRepairing((r) => ({ ...r, [String(e.place)]: `repairing: ${(e.fixes as string[]).join('; ')}` })); return add(e, `↻ ${e.place}: repairing · ${(e.fixes as string[]).join('; ')}`, 'step');
        case 'repair.end': setRepairing((r) => { const n = { ...r }; delete n[String(e.place)]; return n; }); soon(); return add(e, `${e.ok ? '✓' : '✕'} ${e.place}: ${e.ok ? 'repaired, playable' : 'still not playable, left for the agent'}`, e.ok ? 'step' : 'err');
        case 'repair.agent':
          if (e.missing) return (setNoAgent(String(e.missing)), add(e, `${e.missing} is not installed, so no agent can repair ${(e.places as string[]).join(', ')}: see Setup`, 'err'));
          return add(e, `agent asked to repair ${(e.places as string[]).join(', ')}`, 'agent');
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
  const placeFocus = useMemo(() => status?.placeDetail.find((p) => p.key === focus), [status, focus]);
  
  const playable = !!status?.placeDetail.some((p) => p.stages.layout);
  const building = job?.args[0] === 'build' ? job : null;
  useEffect(() => void (building && setWatched(building.id)), [building?.id]);
  const shown = watched && hidden !== watched ? status?.jobs.find((j) => j.id === watched) : undefined;
  // How far the watched build is, weighed by how long each step took last time.
  const plan = jobPlan ?? steps;
  const took = (s: string) => status?.build[s]?.seconds ?? status?.typical?.[s] ?? 30;
  const total = plan.reduce((sum, s) => sum + took(s), 0);
  // A running step counts as far along as its time so far says (never quite done), so the road moves every second, not only between steps.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!shown || shown.state !== 'running') return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [shown?.id, shown?.state]);
  const left = plan.filter((s) => jobDone[s] === undefined).reduce((sum, s) => sum + took(s) - (running[s] === 'run' && since[s] ? Math.min((now - since[s]) / 1000, took(s) * 0.9) : 0), 0);
  // The build stage: the running job's own steps (the build says them; until then, its arguments).
  const arg = (name: string) => (job && job.args.includes(name) ? job.args[job.args.indexOf(name) + 1] : undefined);
  const ownPlan = jobPlan ?? (job?.args[0] === 'build' ? steps.slice(arg('--from') ? steps.indexOf(arg('--from')!) : 0, arg('--to') ? steps.indexOf(arg('--to')!) + 1 : steps.length) : []);
  const liveBuild: Live = { plan: job ? ownPlan : [], done: jobDone, running, since, calls: jobCalls, lastCall, tail: jobTail };
  // On stage: the place picked; else a new picture as it lands; else, in turn, the places a step is working on.
  const busy = building ? (status?.placeDetail ?? []).filter((p) => working(p, liveBuild)).map((p) => p.key) : [];
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => setSpin((n) => n + 1), 4500);
    return () => clearInterval(timer);
  }, [!!building]);
  const fresh = livePlace && Date.now() - livePlace.at < 4000 ? livePlace.key : null;
  const stageKey = focus ?? fresh ?? (busy.length ? busy[spin % busy.length] : null) ?? livePlace?.key ?? status?.placeDetail[0]?.key;
  const stagePlace = status?.placeDetail.find((p) => p.key === stageKey);
  const playLine = (text: string) => setLines((l) => [...l.slice(-400), { seq: -Date.now() - Math.random(), text, kind: 'play' }]);

  return (
    <>
      <Header world={slug} live={live} />
      {shown && status && <KidsWait slug={slug} places={status.placeDetail} progress={total ? 1 - left / total : 0} left={shown.state === 'running' ? left : null} doing={plan.find((s) => running[s] === 'run')}
        ready={shown.state === 'done' && playable} failed={shown.state === 'failed' || shown.state === 'cancelled'}
        onPlay={() => (setHidden(shown.id), setPlaying({ full: true }))} onHide={() => setHidden(shown.id)} />}
      <main class="workshop">
        <div class="left">
          <div class="row">
            <h1>{status?.title ?? slug}</h1>
            <span class="grow" />
            {playable && <button type="button" class={playing ? 'primary' : 'ghost'} onClick={() => setPlaying(playing ? null : {})}>{playing ? 'Close game' : 'Play'}</button>}
            {playable && !job && <Share slug={slug} jobs={status?.jobs ?? []} onError={setError} />}
            {!job && status && status.steps.length > 0 && <button type="button" class="ghost" title="Put the world back as it was before the last job" onClick={() => call('history_undo', { slug }).catch((e) => setError(e.message))}>Undo last job</button>}
            {!job && canRedo && <button type="button" class="ghost" title="Take back the undo" onClick={() => call('history_redo', { slug }).catch((e) => setError(e.message))}>Redo</button>}
            {/* Stop sits beside the build button, never in its place: a double click must not start a build and stop it again. */}
            {job && <button type="button" class="ghost" title={`Stop ${job.label} (started by ${job.by === 'agent' ? 'the agent' : 'you'})`} onClick={() => call('job_cancel', { id: job.id })}>Stop</button>}
            <button type="button" class="primary" disabled={!status || !!status.issue || !!job} title={job ? `${job.label} is running${job.step ? `: ${job.step}` : ''}` : undefined} onClick={() => call('world_build', { slug }).catch((e) => setError(e.message))}>
              {job ? `${job.by === 'agent' ? 'Agent: ' : ''}${job.label}…` : status && status.steps.length >= steps.length - 1 ? 'Rebuild verify' : 'Continue build'}
            </button>
          </div>
          {status?.pitch && <p class="lead">{status.pitch}</p>}
          {error && <p class="error">{error}</p>}
          {movedFrom.value && movedFrom.value !== slug && <p class="banner">The agent moved the view here from {movedFrom.value}. <button type="button" class="ghost" onClick={() => { const back = movedFrom.value!; movedFrom.value = null; go(`/w/${back}`); }}>Back to {movedFrom.value}</button> <button type="button" class="ghost" onClick={() => (movedFrom.value = null)}>Stay</button></p>}
          {undone && !job && <p class="banner">{undone}{canRedo ? ' · Redo puts it back.' : ''}</p>}
          {status && <Pipeline job={job} all={steps} live={liveBuild} build={status.build} typical={status.typical ?? {}} />}
          {failed && !job && <Failed slug={slug} job={failed} noAgent={noAgent} onError={setError} onPlace={setFocus} />}
          {budget?.over && <p class="banner">Budget: ${budget.total.usd} spent of the ${budget.limitUsd} limit. Check Setup before the next big build.</p>}
          {playing && <Play slug={slug} place={playing.place} round={playing.round ?? 0} full={playing.full} onRestart={() => setPlaying({ ...playing, round: (playing.round ?? 0) + 1 })} version={tick} onLine={playLine} onError={setError} />}
          <div class="seg" role="tablist" aria-label="Show">
            <button type="button" role="tab" aria-selected={view === 'places'} class={view === 'places' ? 'on' : ''} onClick={() => setView('places')}>Places</button>
            <button type="button" role="tab" aria-selected={view === 'story'} class={view === 'story' ? 'on' : ''} onClick={() => setView('story')}>Story</button>
            <button type="button" role="tab" aria-selected={view === 'cast'} class={view === 'cast' ? 'on' : ''} onClick={() => setView('cast')}>Cast</button>
          </div>
          {view === 'story' && <StoryView slug={slug} version={tick} onError={setError} />}
          {view === 'cast' && <CastView slug={slug} version={tick} onError={setError} />}
          {view === 'places' && status && (
            <div class="build-stage">
              {stagePlace ? <Stage slug={slug} place={stagePlace} live={liveBuild} building={!!building} /> : <figure class="stage-live"><div class="frame"><div class="empty"><span>{status.pitch ?? 'Muse Spark is dreaming up the places…'}</span></div></div></figure>}
              <Tale slug={slug} version={tick} pitch={status.pitch} places={status.placeDetail} />
            </div>
          )}
          {view === 'places' && status && <Strip slug={slug} places={status.placeDetail} focus={stageKey ?? null} live={liveBuild} building={!!building} repairing={repairing} onPick={(k) => setFocus(focus === k ? null : k)} />}
          {view === 'places' && placeFocus && (
            <section class="inspect">
              <p class="detail">{placeFocus.shows}</p>
              {placeFocus.verdict && [...placeFocus.verdict.errors.map((f) => ['error', f] as const), ...placeFocus.verdict.flags.map((f) => ['flag', f] as const)].map(([kind, f]) => (
                <>
                  <p class={kind === 'error' ? 'error' : 'flag'}><code>{f.code}</code>{f.key ? ` ${f.key}` : ''}: {f.detail.replace(/\/(?:Users|home)\/[^/\s]+/g, '~')}</p>
                  {'play' in f && f.play && (
                    <details class="play-hint">
                      <summary>How to fix it</summary>
                      <p class="detail">Look: {f.play.look}</p>
                      <p class="detail">Then try, in order: {f.play.tools.join(' · ')}</p>
                      {f.play.last && <p class="detail">Last resort: {f.play.last}</p>}
                      <button type="button" class="ghost small" onClick={() => askAgent(slug, `${placeFocus.key} is not playable: ${f.code}: ${f.detail}. Fix it as your playbook says and tell me what you did.`).catch((e) => setError(e.message))}>Ask the agent to fix it</button>
                    </details>
                  )}
                </>
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
            <label class="detail"><input type="checkbox" checked={allLines} onChange={(e) => setAllLines(e.currentTarget.checked)} /> Every line the steps print</label>
            <ol>{[...lines].reverse().filter((l) => allLines || l.kind !== 'out').map((l) => <li key={l.seq} class={l.kind}>{l.text}</li>)}</ol>
          </section>
        </aside>
      </main>
    </>
  );
}

/** The game in a frame: the same page `diorama play` serves. What happens in it goes to Activity. */
function Play({ slug, place, round, full, onRestart, version, onLine, onError }: { slug: string; place?: string; round: number; full?: boolean; onRestart: () => void; version: number; onLine: (t: string) => void; onError: (m: string) => void }) {
  const [fresh, setFresh] = useState(true);
  const [loadedAt, setLoadedAt] = useState(version);
  const loadedTime = useRef(0);
  const frame = useRef<HTMLIFrameElement>(null);
  // Started from the children's Let's play: straight onto the whole screen, still inside the click that asked for it.
  useEffect(() => void (full && frame.current?.requestFullscreen().then(() => frame.current?.focus()).catch(() => {})), []);
  // The refresh that follows a reload (an undo, a finished job) is not a change since the game started.
  useEffect(() => void (version !== loadedAt && (Date.now() - loadedTime.current < 3000 ? setLoadedAt(version) : setFresh(false))), [version]);
  // Gamepads: all steer one hero, take turns, or each steers its own hero (a party); kept for the next visit.
  const [pads, setPads] = useState<string>(() => {
    try {
      return localStorage.getItem('diorama.pads') ?? '';
    } catch {
      return '';
    }
  });
  const pickPads = (v: string) => {
    setPads(v);
    try {
      localStorage.setItem('diorama.pads', v);
    } catch {
      // A private window keeps it for this visit only.
    }
  };
  const query = new URLSearchParams({ ...(place && { place }), ...(pads && { pads }) }).toString();
  const src = `/play/${slug}/${query ? `?${query}` : ''}`;
  const hook = (e: Event) => {
    setFresh(true);
    setLoadedAt(version);
    loadedTime.current = Date.now();
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
        <span class="detail">click to walk or use, right click to look, or play with a gamepad</span>
        <span class="grow" />
        <label class="detail" title="With several gamepads: all steer the one hero, they take turns, or each pad has its own hero">
          Gamepads{' '}
          <select value={pads} onChange={(e) => pickPads(e.currentTarget.value)}>
            <option value="">one hero</option>
            <option value="turns">take turns</option>
            <option value="party">a hero each</option>
          </select>
        </label>
        <button type="button" class="ghost small" onClick={onRestart}>Restart</button>
        {/* For a big screen: the game letterboxes to it, keyboard and gamepads keep working; Esc comes back. */}
        <button type="button" class="ghost small" title="Play on the whole screen (Esc to come back)" onClick={() => frame.current?.requestFullscreen().then(() => frame.current?.focus()).catch((err) => onError(err.message))}>Full screen</button>
        <button type="button" class="ghost small" title="The bot plays every route to an ending and says where it got stuck" onClick={() => call('playthrough', { slug }).catch((err) => onError(err.message))}>Bot playthrough</button>
      </div>
      {!fresh && (
        <div class="banner row" role="status">
          <span>The world changed since this game started.</span>
          <span class="grow" />
          <button type="button" class="primary small" onClick={onRestart}>Reload the game</button>
        </div>
      )}
      <iframe ref={frame} key={`${src}#${round}`} src={src} title={`${slug}, playable`} onLoad={hook} allow="autoplay; fullscreen; gamepad" allowFullScreen />
    </section>
  );
}

const spend = (s: Spend) => (s.priced && Object.keys(s.calls).length > 0 ? `$${s.usd.toFixed(2)}` : `${Object.values(s.calls).reduce((a, b) => a + b, 0)} calls${s.usd ? ` ($${s.usd.toFixed(2)}+)` : ''}`);

/** The last job failed: where, why, its last lines, and what to do next. */
function Failed({ slug, job, noAgent, onError, onPlace }: { slug: string; job: Job; noAgent: string | null; onError: (m: string) => void; onPlace: (p: string) => void }) {
  const [more, setMore] = useState(false);
  // The output is for when the reason above is not enough: hidden at first when it names the places, and never with this machine's folders.
  const lines = job.tail.filter((l) => l.trim()).map((l) => l.replace(/\/(?:Users|home|tmp)\/\S*?\/(worlds\/)/g, '$1').replace(/\/(?:Users|home)\/[^/\s]+/g, '~'));
  const listed = !!job.unplayable?.length;
  const step = job.step;
  const retry = () => call('job_retry', { id: job.id }).catch((e) => onError(e.message));
  const ask = () => askAgent(slug, `The job "${job.label}" failed${step ? ` at the ${step} step` : ''}: ${job.error ?? 'see its output'}. Find out why with world_status and place_status, fix it only with the Studio fix tools (never by editing files), and tell me what you did.`).catch((e) => onError(e.message));
  return (
    <section class="failed" role="alert">
      <div class="row"><strong>{job.label} failed{step ? ` at ${step}` : ''}</strong><span class="detail">by {job.by}</span></div>
      {job.unplayable?.length ? job.unplayable.map((u) => (
        <div class="row"><button type="button" class="ghost small" onClick={() => onPlace(u.place)}>{u.place}</button><span class="error">{u.errors.join(' · ') || 'not playable: see verify.json'}</span></div>
      )) : job.error && <p class="error">{job.error}</p>}
      {noAgent && listed && <p class="detail">The agent would repair these, but {noAgent} is not installed on this computer. <a href="/setup" onClick={(e) => (e.preventDefault(), go('/setup'))}>Setup</a> says how to add it.</p>}
      {lines.length > 0 && (more || !listed) && <pre>{(more ? lines : lines.slice(-6)).join('\n')}</pre>}
      <div class="row">
        <button type="button" class="primary small" onClick={retry}>Try again</button>
        <button type="button" class="ghost small" disabled={!!noAgent} title={noAgent ? `${noAgent} is not installed` : undefined} onClick={ask}>Ask the agent</button>
        <button type="button" class="ghost small" title="Put the world back as it was before this job" onClick={() => call('history_undo', { slug }).catch((e) => onError(e.message))}>Undo it</button>
        <span class="grow" />
        {(lines.length > 6 || (listed && lines.length > 0)) && <button type="button" class="ghost small" onClick={() => setMore(!more)}>{more ? 'Less' : `Its output (${lines.length} lines)`}</button>}
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
      if (e.type !== 'ui.focus' || e.by !== 'agent' || !followAgent.value || !e.slug) return;
      const here = /^\/w\/([a-z][a-z0-9-]*)/.exec(route.value)?.[1];
      if (here && here !== e.slug) movedFrom.value = here;
      go(`/w/${e.slug}`);
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
