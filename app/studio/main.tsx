// Diorama Studio: Start (worlds and a new idea), Setup (what this machine needs) and the Workshop (a world
// building live). Everything here goes through actions, the same ones `diorama action` and the agent use.
import { render, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChatNotice, SessionTurn } from 'genaicode/react';
import { askAgent, call, fileUrl, follow, listActions, openSession, token, type StudioEvent } from './api.ts';
import { AgentPanel } from './agent.tsx';
import { CastView } from './cast.tsx';
import { base64, Camera, shrink } from './camera.tsx';
import { StoryView } from './story.tsx';
import { StyleMenu } from './style-menu.tsx';
import { PlaceEditor } from './place.tsx';
import { MODEL_NAME, Pipeline, Stage, STEP_SHOWS, working, type LayerName, type Live, type StagePlace } from './build.tsx';
import { Bell, Logo, Rail, useAtelierFeed, worlds as allWorlds } from './atelier.tsx';
import { Card, CastCard, CastStage, nice, PlacesCard, PlaceStage, type Picked, type StageView } from './world.tsx';
import { Tips } from './tip.tsx';
import { Lightbox } from './lightbox.tsx';
import { followAgent, go, movedFrom, route } from './nav.ts';

type Check = { id: string; label: string; state: 'ok' | 'missing' | 'optional' | 'fail'; detail: string; fix?: string[] };
type Summary = { slug: string; title: string; pitch: string | null; issue: string | null; places: number; playable: number; verified: number; steps: string[]; cover: { file: string; v: number | null } | null; workshop?: boolean };
type Finding = { code: string; key?: string; detail: string };
type PlaceDetail = {
  key: string;
  shows: string;
  things: Array<{ key: string; role: string }>;
  stages: Record<string, number | null>;
  image: { file: string; v: number | null } | null;
  layers?: StagePlace['layers'];
  verdict: { ok: boolean; errors: Array<Finding & { play?: { look: string; tools: string[]; last?: string } }>; flags: Finding[] } | null;
  trouble?: { why: string; from: string | null } | null;
};
type Job = { id: string; label: string; args: string[]; unplayable?: Array<{ place: string; errors: string[] }>; state: string; by: string; step?: string; error?: string; startedAt?: string; endedAt?: string; tail: string[] };
type Note = { id: string; at: string; by: string; place?: string; point?: [number, number]; text: string; state: 'open' | 'done'; reply?: string };
type Spend = { usd: number; priced: boolean; calls: Record<string, number> };
type Budget = { total: Spend; today: Spend; limitUsd: number | null; over: boolean; prices: Record<string, number> };
type Status = Summary & { placeDetail: PlaceDetail[]; build: Record<string, { seconds: number }>; typical?: Record<string, number>; calls: Record<string, number>; jobs: Job[] };

let steps: string[] = [];
let quiet = new Set<string>();

function Mark({ state }: { state: Check['state'] | 'run' | 'todo' }) {
  const glyph = { ok: '✓', missing: '!', optional: '·', fail: '✕', run: '◌', todo: '' }[state];
  return <span class={`mark ${state}`} aria-label={state}>{glyph}</span>;
}

const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

/** What a job changed: the places it touched, else the first files. */
function touched(s: { places?: string[]; sample?: string[] }): string {
  return s.places?.length ? s.places.join(', ') : (s.sample ?? []).slice(0, 2).map((f) => f.split('/').at(-1)).join(', ');
}

const ago = (at: string) => {
  const m = Math.round((Date.now() - Date.parse(at)) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 24 * 60 ? `${Math.round(m / 60)} h ago` : new Date(at).toLocaleDateString();
};

type Snap = { id: string; at: string; label: string; by: string; files: number; added?: number; changed?: number; removed?: number; sample?: string[]; places?: string[] };

/**
 * History: every job the world went through, newest first, with who ran it and what it changed; any of them can
 * be gone back on, to the world as it was before it. The back step is itself kept, so Redo or a later pick undoes it.
 */
function HistoryMenu({ slug, version, onError }: { slug: string; version: number; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [snaps, setSnaps] = useState<Snap[] | null>(null);
  const [sure, setSure] = useState<string | null>(null);
  useEffect(() => void (open && call<Snap[]>('history_list', { slug, limit: 20 }).then(setSnaps).catch((e) => onError(e.message))), [open, slug, version]);
  const back = (id: string) => call('history_undo', { slug, id }).then(() => (setOpen(false), setSure(null))).catch((e) => onError(e.message));
  return (
    <div class="share">
      <button type="button" class="ghost" aria-expanded={open} title="Every job this world went through. Go back to before any of them. Free" onClick={() => (setOpen(!open), setSure(null))}>History</button>
      {open && (
        <div class="share-menu history" role="menu">
          {!snaps && <p class="detail">Reading the history…</p>}
          {snaps?.length === 0 && <p class="detail">Nothing to go back to yet.</p>}
          <ol>
            {snaps?.map((s) => (
              <li key={s.id}>
                <div class="row">
                  <strong>{s.label.replace(/^before /, '')}</strong>
                  <span class="grow" />
                  <span class="detail">{s.by === 'agent' ? 'agent' : 'you'} · {ago(s.at)}</span>
                </div>
                {s.changed !== undefined && <p class="detail">{(s.changed ?? 0) + (s.added ?? 0) + (s.removed ?? 0) === 0 ? 'changed nothing' : `changed ${touched(s)} · ${(s.changed ?? 0) + (s.added ?? 0)} file${(s.changed ?? 0) + (s.added ?? 0) === 1 ? '' : 's'}${s.removed ? `, removed ${s.removed}` : ''}`}</p>}
                {sure === s.id
                  ? <div class="row"><span class="detail">Everything after it goes too.</span><span class="grow" /><button type="button" class="primary small" title="Put the world back as it was before this job. Redo takes it back. Free" onClick={() => back(s.id)}>Go back</button><button type="button" class="ghost small" onClick={() => setSure(null)}>Cancel</button></div>
                  : <button type="button" class="ghost small" title="Asks once more before going back. Everything after this job goes too" onClick={() => setSure(s.id)}>Back to before this</button>}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

/** Sharing: a zip to download, or the public link. The last export or publish job says where it went. */
function Share({ slug, jobs, onError }: { slug: string; jobs: Job[]; onError: (m: string) => void }) {
  const last = (args0: string) => jobs.findLast((j) => j.args[0] === args0 && j.state === 'done');
  const exported = last('export');
  const link = last('publish')?.tail.map((l) => /play: (https?:\S+)/.exec(l)?.[1]).find(Boolean);
  const firstTime = last('publish')?.tail.find((l) => l.includes('first publish:'))?.trim();
  const publish = () => {
    if (confirm(`Put ${slug} on the public web? Anyone with the link can play it.`)) call('world_publish', { slug }).catch((e) => onError(e.message));
  };
  return (
    <div class="menu-group">
      <p class="menu-head">Share this game</p>
      <button type="button" class="ghost small" title="Pack a playable copy to download, for itch.io or e-mail. Free, no model calls" onClick={() => call('world_export', { slug }).catch((e) => onError(e.message))}>Make a zip</button>
      {exported && <a class="detail" href={`/exports/${slug}.zip`} download>Download {slug}.zip</a>}
      <p class="detail">A zip plays offline and goes on itch.io as an HTML game.</p>
      <button type="button" class="ghost small" title="Put the game on GitHub Pages: anyone with the link can play. Asks first. Free, no model calls" onClick={publish}>Publish a link</button>
      {link && <a class="detail" href={link} target="_blank" rel="noopener">{link}</a>}
      {firstTime && <p class="detail">{firstTime}</p>}
      <p class="detail">Puts it on this repository's GitHub Pages, public.</p>
    </div>
  );
}

/** What is seldom needed waits behind one button: following the agent, Setup, and whatever the page adds. */
function Menu({ children }: { children?: ComponentChildren }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !(e.target as HTMLElement).closest?.('.menu-wrap, .share-menu') && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', close);
    addEventListener('keydown', esc);
    return () => (removeEventListener('pointerdown', close), removeEventListener('keydown', esc));
  }, [open]);
  return (
    <div class="share menu-wrap">
      <button type="button" class="ghost menu-button" aria-label="More" title="More: follow the agent, history, style, Setup" aria-expanded={open} onClick={() => setOpen(!open)}>☰</button>
      {open && (
        <div class="share-menu top-menu" role="menu" onClick={(e) => (e.target as HTMLElement).closest('a, .mi.go') && setOpen(false)}>
          {children && <p class="menu-head">This diorama</p>}
          {children}
          {children && <hr />}
          <p class="menu-head">Studio</p>
          <label class="mi switch" title="When the agent opens a place, the cast or the game, the stage goes there too"><span>Follow the agent</span><input type="checkbox" role="switch" checked={followAgent.value} onChange={(e) => (followAgent.value = e.currentTarget.checked)} /></label>
          <a href="/setup" class="mi" title="Keys, tools and the budget on this computer" onClick={(e) => (e.preventDefault(), go('/setup'))}>Setup</a>
        </div>
      )}
    </div>
  );
}

/**
 * What the agent asked at the end of its turn: its ask_person question, or a plain question it ended its answer
 * with, which gets a yes and a no in the language it was asked in.
 */
function asked(turn: SessionTurn): { question: string; options: string[]; recommended?: number } | null {
  const tool = turn.entries.findLast((e) => e.kind === 'tool' && e.name.endsWith('ask_person'));
  if (tool?.kind === 'tool' && !tool.isError) {
    const q = tool.input as { question?: string; options?: string[]; recommended?: number } | undefined;
    if (q?.question && q.options?.length) return { question: q.question, options: q.options, recommended: q.recommended };
  }
  const text = turn.entries.findLast((e) => e.kind === 'text');
  if (text?.kind !== 'text' || !/\?\s*$/.test(text.text)) return null;
  const pl = /[ąćęłńóśźż]|\b(czy|się|mogę|chcesz)\b/i.test(text.text);
  return { question: '', options: pl ? ['Tak', 'Nie'] : ['Yes', 'No'], recommended: 0 };
}

/** Build again runs every step once more, so it asks first; going on from where a build stopped does not. */
function Rebuild({ slug, again, onError }: { slug: string; again: boolean; onError: (m: string) => void }) {
  const [sure, setSure] = useState(false);
  const run = () => call('world_build', { slug }).catch((e) => onError(e.message));
  if (!again) return <button type="button" class="mi go" title="Go on from where the build stopped. Answers already asked are reused for free" onClick={run}>Continue the build</button>;
  if (!sure) return <button type="button" class="mi danger" title="Run every step of the build again. Asks first" onClick={() => setSure(true)}>Build everything again…</button>;
  return (
    <div class="mi-confirm">
      <p>Every step runs again over the whole world. What was asked before is reused for free, anything new costs model calls; History in this menu takes it back.</p>
      <div class="row"><button type="button" class="danger-fill small mi go" onClick={run}>Build again</button><button type="button" class="ghost small" onClick={() => setSure(false)}>Cancel</button></div>
    </div>
  );
}

/** The bell and the menu, top right of a page with no stage of its own. */
function Corner() {
  return <div class="corner"><Bell /><Menu /></div>;
}

/** Share as one button: the zip and the public link behind it. */
function ShareButton({ slug, jobs, onError }: { slug: string; jobs: Job[]; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !(e.target as HTMLElement).closest?.('.share-wrap') && setOpen(false);
    addEventListener('pointerdown', close);
    return () => removeEventListener('pointerdown', close);
  }, [open]);
  return (
    <div class="share share-wrap">
      <button type="button" class="ghost" aria-expanded={open} title="A zip for itch.io, or a link anyone can play" onClick={() => setOpen(!open)}>Share</button>
      {open && <div class="share-menu" role="menu"><Share slug={slug} jobs={jobs} onError={onError} /></div>}
    </div>
  );
}

/** Which model does the running step, for the build card. */
const MODEL_FOR: Record<string, string> = { world: 'Muse Spark', story: 'Muse Spark', layout: 'Muse Spark', paint: 'Muse Image', masks: 'SAM 3.1', plates: 'Muse Image', icons: 'Muse Image', derive: 'Depth', backdrop: 'Muse Image', cast: 'Muse Image', model: '3D', sprites: 'Muse Image', sound: 'ElevenLabs', voices: 'ElevenLabs', verify: 'play test' };

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return <button type="button" class="ghost small" title="Copy these commands to paste in a terminal" onClick={() => navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1200)))}>{done ? 'Copied' : 'Copy'}</button>;
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
      <Corner />
      {/* What to do on the left, the checks on the right, each scrolling on its own: the page itself never does. */}
      <main class="setup">
        <div class="side">
        <h1>Setup</h1>
        <p class="lead">{!checks ? 'Checking this machine…' : blocking.length ? `${blocking.map((c) => c.label).join(' and ')} still ${blocking.length > 1 ? 'need' : 'needs'} you. Everything else is ready or optional.` : `Everything diorama needs is here.${ok < checks.length ? ' The unticked ones are optional.' : ''}`}</p>
        <p class="note">Keys are typed only in your terminal with <code>diorama setup</code>, hidden, and kept in your system keychain. This page never sees them.</p>
        {error && <p class="error">{error}</p>}
        <div class="row">
          <button type="button" class="primary" disabled={!!busy} title="Look at this computer again: keys, tools, the agent. Free" onClick={() => run('setup_status')}>{busy === 'setup_status' ? 'Checking…' : 'Check again'}</button>
          <button type="button" class="ghost" disabled={!!busy || checks?.find((c) => c.id === 'META_API_KEY')?.state === 'missing'} title="Send one tiny request to Meta to see the key works. 1 small Meta call" onClick={() => run('setup_check')}>{busy === 'setup_check' ? 'Calling Meta…' : 'Test the Meta key live'}</button>
        </div>
        <BudgetBox />
        </div>
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
        <label title="Studio shows a banner once the spend passes this">Warn at ($)<input inputMode="decimal" placeholder="150" value={limit} onInput={(e) => setLimit(e.currentTarget.value)} /></label>
      </div>
      <div class="row"><button type="submit" class="ghost small" title="Keep the prices and the limit on this computer">Save</button><span class="detail">{saved}</span></div>
    </form>
  );
}

/** Ideas to start from: a click puts one in the box. */
const EXAMPLES = [
  'A night market where paper lanterns hold lost memories, and one lantern has gone dark',
  "My grandmother's kitchen in 1989, the evening before the house is sold",
  'A foggy harbour where a cat has stolen the last ferry ticket',
  'Ostatni tramwaj przez zamglony Kraków i pasażer, który nie pamięta, dokąd jedzie',
];

type Photo = { name: string; data: string };

/** A job's error in a few plain words, for the chat; the whole error still goes to the agent. */
export function plainError(error: string | undefined): string {
  const e = error ?? '';
  if (/content_policy_violation|safety|moderat/i.test(e)) return 'the image safety filter refused a picture';
  if (/invalid_api_key|401|unauthori[sz]ed/i.test(e)) return 'the Meta key was refused';
  if (/\b429\b|rate.?limit|quota/i.test(e)) return 'too many model calls at once';
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|socket hang up|\b50[234]\b/i.test(e)) return 'a model did not answer';
  const first = e.replace(/^diorama \w+: /, '').replace(/\{.*$/s, '').split(/[.\n]/)[0].trim();
  return first ? (first.length > 70 ? `${first.slice(0, 68)}…` : first) : 'see its output';
}
/** As many photos as a world_new takes: a class's drawings, a room, a person. */
const MAX_PHOTOS = 16;
/** The languages the game's voices speak (ElevenLabs multilingual); Spark writes in all of them. */
const LANGUAGES = ['Arabic', 'Bulgarian', 'Chinese', 'Croatian', 'Czech', 'Danish', 'Dutch', 'English', 'Filipino', 'Finnish', 'French', 'German', 'Greek', 'Hindi', 'Indonesian', 'Italian', 'Japanese', 'Korean', 'Malay', 'Polish', 'Portuguese', 'Romanian', 'Russian', 'Slovak', 'Spanish', 'Swedish', 'Tamil', 'Turkish', 'Ukrainian'];

/** The mic beside the idea: press to speak, press again; what was said joins the text. */
function SayIt({ onText, onError }: { onText: (text: string) => void; onError: (m: string) => void }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const [hearing, setHearing] = useState(false);
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!rec) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.round((Date.now() - started) / 1000)), 250);
    return () => clearInterval(timer);
  }, [rec]);
  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
      const r = new MediaRecorder(stream, type ? { mimeType: type } : {});
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setHearing(true);
        try {
          const said = await call<{ text: string }>('idea_hear', { name: `idea.${r.mimeType.includes('mp4') ? 'm4a' : 'webm'}`, data: await base64(new Blob(chunks, { type: r.mimeType })) });
          if (said.text) onText(said.text);
        } catch (e) {
          onError((e as Error).message);
        } finally {
          setHearing(false);
        }
      };
      r.start(1000);
      setSeconds(0);
      setRec(r);
    } catch (e) {
      onError(`No microphone: ${(e as Error).message}`);
    }
  };
  return (
    <button type="button" class={`ghost bare${rec ? ' rec' : ''}`} disabled={hearing} title={rec ? 'Stop: what you said is written into the idea' : 'Say the idea instead of typing it. Muse Voice Transcribe writes it here: 1 call'} onClick={rec ? () => (rec.stop(), setRec(null)) : start}>
      {hearing ? 'Hearing…' : rec ? `■ Stop · ${seconds} s` : '🎙 Say it'}
    </button>
  );
}

function useStart() {
  const [worlds, setWorlds] = useState<Summary[] | null>(null);
  const [needs, setNeeds] = useState<Check[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    call<Summary[]>('world_list').then(setWorlds).catch((e) => setError(e.message));
    call<Check[]>('setup_status').then((c) => setNeeds(c.filter((x) => x.state === 'missing' || x.state === 'fail'))).catch(() => {});
  }, []);
  return { worlds, needs, error, setError };
}

function SetupBanner({ needs, pl }: { needs: Check[]; pl?: boolean }) {
  if (!needs.length) return null;
  return (
    <a class="banner" href="/setup" onClick={(e) => (e.preventDefault(), go('/setup'))}>
      {pl ? `Ustawienia: brakuje ${needs.map((n) => n.label).join(', ')}. Otwórz ustawienia →` : `Setup: ${needs.map((n) => n.label).join(', ')} ${needs.length > 1 ? 'are' : 'is'} missing. Open Setup →`}
    </a>
  );
}

/** The front door: one idea, in words, a voice or a photo; Spark picks the name, the places and the language. */
function Start() {
  const { worlds, needs, error, setError } = useStart();
  const noKey = needs.some((n) => n.id === 'META_API_KEY');
  const [idea, setIdea] = useState('');
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [slug, setSlug] = useState('');
  const [places, setPlaces] = useState(0);
  const [language, setLanguage] = useState('');
  const [busy, setBusy] = useState(false);
  const [drop, setDrop] = useState(false);
  const [camera, setCamera] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);
  const taken = !!slug && worlds?.some((w) => w.slug === slug);
  const ready = idea.trim().length >= 10 && !taken && !noKey && !busy;
  const addPhotos = async (files: Iterable<File>) => {
    const pics = [...files].filter((f) => f.type.startsWith('image/'));
    const kept = await Promise.all(pics.map(async (f) => ({ name: (f.name || 'pasted.png').replace(/\.[^.]+$/, '') + '.jpg', data: await shrink(f) })));
    setPhotos((p) => [...p, ...kept].slice(0, MAX_PHOTOS));
  };
  // A snap from the camera: shrunk like a picked photo, named in the order taken.
  const snap = async (jpeg: string) => {
    const bytes = Uint8Array.from(atob(jpeg.slice(jpeg.indexOf(',') + 1)), (c) => c.charCodeAt(0));
    const data = await shrink(new Blob([bytes], { type: 'image/jpeg' }));
    setPhotos((p) => [...p, { name: `photo-${p.length + 1}.jpg`, data }].slice(0, MAX_PHOTOS));
  };
  const build = async (e?: Event) => {
    e?.preventDefault();
    if (!ready) return;
    setError('');
    setBusy(true);
    try {
      const made = await call<{ slug: string }>('world_new', { idea: idea.trim(), ...(slug && { slug }), ...(places && { places }), ...(language && { language }), ...(photos.length && { photos }) });
      void call('world_list').then((w) => (allWorlds.value = w as typeof allWorlds.value)).catch(() => {});
      go(`/w/${made.slug}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <>
      <main class="start">
        <Corner />
        <SetupBanner needs={needs} />
        <form class="hero" onSubmit={build}>
          <Logo size={44} />
          <h1>What should the <em>world</em> be?</h1>
          <p class="lead">Say it in a sentence. Muse Spark writes the story, Muse Image paints the places, SAM 3.1 cuts out everything you can touch, and the agent looks after it with you.</p>
          <div class={`prompt${drop ? ' drop' : ''}`}
            onDragOver={(e) => (e.preventDefault(), setDrop(true))}
            onDragLeave={() => setDrop(false)}
            onDrop={(e) => (e.preventDefault(), setDrop(false), void addPhotos(e.dataTransfer?.files ?? []))}>
            <textarea ref={box} rows={4} aria-label="Your idea" placeholder="A lighthouse keeper's last night before the foghorn is switched off for good…" value={idea}
              onInput={(e) => setIdea(e.currentTarget.value)}
              onPaste={(e) => { const files = [...(e.clipboardData?.files ?? [])]; if (files.length) (e.preventDefault(), void addPhotos(files)); }}
              onKeyDown={(e) => e.key === 'Enter' && (e.metaKey || e.ctrlKey) && void build()} />
            {photos.length > 0 && (
              <div class="attached">
                {photos.map((p, i) => (
                  <span class="att" title={`${p.name}. Spark decides what it is: a real room becomes the first place, a person the hero, a drawing a character, thing or place of the game`}>
                    <button type="button" class="ghost bare" data-lightbox={p.data} aria-label="See it big"><img src={p.data} alt="" /></button>
                    <button type="button" class="ghost bare" aria-label="Remove the photo" onClick={() => setPhotos(photos.filter((_, j) => j !== i))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <div class="row">
              <label class="button ghost bare" title="A photo of a real room becomes the first place, of a person the hero, of a drawing a character, thing or place. Dropping or pasting pictures works too">
                <input type="file" accept="image/*" multiple onChange={(e) => (void addPhotos(e.currentTarget.files ?? []), (e.currentTarget.value = ''))} />＋ Photo
              </label>
              <button type="button" class="ghost bare" title="Take photos with the camera, one after another: drawings, a room, a person" onClick={() => setCamera(true)}>📷 Camera</button>
              <SayIt onText={(text) => (setIdea((old) => `${old.trim()} ${text}`.trim()), box.current?.focus())} onError={setError} />
              <span class="grow" />
              <button type="submit" class="primary" disabled={!ready}
                title={taken ? 'A world has this name already: change it under More' : noKey ? 'Add the Meta key in Setup first' : idea.trim().length < 10 ? 'Write the idea first (at least 10 letters)' : 'Spark names the world and picks how many places it needs, then the whole game is built: story, paintings, cut-outs, depth, cast, sound, play test. A few minutes; per place about 1 Muse Image + several SAM and Spark calls'}>
                {busy ? 'Spark reads the idea…' : taken ? 'Name taken' : noKey ? 'Needs the Meta key' : 'Build it'}
              </button>
            </div>
          </div>
          <div class="row ideas">
            {EXAMPLES.map((x) => <button type="button" class="chip" title="Start from this idea" onClick={() => (setIdea(x), box.current?.focus())}>{x}</button>)}
          </div>
          <details class="more">
            <summary title="The world's name, how many places and the language: Spark picks them from the idea when left on Auto">More options</summary>
            <div class="fields">
              <label title="The world's name in links and folders: small letters, digits and dashes"><span>Name</span><input value={slug} placeholder="Auto" onInput={(e) => setSlug(e.currentTarget.value)} pattern="[a-z][a-z0-9\-]*" /></label>
              <label title="How many places the game has. Each is about one Muse Image painting plus SAM cut-outs. Auto: as many as the story needs (2 to 5)"><span>Places</span><select value={places} onChange={(e) => setPlaces(Number(e.currentTarget.value))}><option value={0}>Auto</option>{[2, 3, 4, 5, 6].map((n) => <option value={n}>{n}</option>)}</select></label>
              <label title="The language of the game's text and voices: every language the voices speak. Auto: the language the idea is written in"><span>Language</span><select value={language} onChange={(e) => setLanguage(e.currentTarget.value)}><option value="">Auto</option>{LANGUAGES.map((l) => <option value={l}>{l}</option>)}</select></label>
            </div>
          </details>
          {error && <p class="error">{error}</p>}
        </form>
        {camera && (
          <div class="shoot" role="dialog" aria-label="Camera">
            <Camera tip={photos.length >= MAX_PHOTOS ? `That is ${MAX_PHOTOS}, the most one world takes.` : 'Hold each drawing flat, filling the picture. Take as many as you like, then Done.'} words={{ snap: photos.length ? `Take another (${photos.length})` : 'Take the photo', done: 'Done', none: 'No camera' }}
              onSnap={(jpeg) => photos.length < MAX_PHOTOS && void snap(jpeg)} onClose={() => setCamera(false)} />
            {photos.length > 0 && <div class="taken">{photos.map((p) => <img src={p.data} alt="" />)}</div>}
          </div>
        )}
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
  const [stage, setStage] = useState<StageView | null>(null);
  const [picked, setPicked] = useState<Picked | null>(null);
  const [byHand, setByHand] = useState<string | null>(null);
  const [idea, setIdea] = useState('');
  const worldRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLElement>(null);
  useEffect(() => void fetch(fileUrl(slug, 'idea.txt', Date.now()), { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).then((t) => setIdea(t.trim())).catch(() => {}), [slug]);
  useEffect(() => {
    if (!byHand) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setByHand(null);
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [byHand]);
  /** Activity, the raw record of what ran, opens as a drawer from the top bar. */
  const [logOpen, setLogOpen] = useState(false);
  const [notesOpen, setNotesOpen] = useState(false);
  useEffect(() => {
    if (!notesOpen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setNotesOpen(false);
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [notesOpen]);
  useEffect(() => {
    if (!logOpen) return;
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setLogOpen(false);
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [logOpen]);
  /** The agent that would have repaired the last build, when it is not installed. */
  const [noAgent, setNoAgent] = useState<string | null>(null);
  /** Places the build is mending right now, with what it tries. */
  const [repairing, setRepairing] = useState<Record<string, string>>({});
  const [calls, setCalls] = useState(0);
  /** For the build stage: when each running step began, calls per model this job, the last call, the place last changed. */
  const [since, setSince] = useState<Record<string, number>>({});
  const [jobCalls, setJobCalls] = useState<Record<string, number>>({});
  const [lastCall, setLastCall] = useState<Live['lastCall']>(null);
  const [cut, setCut] = useState<Record<string, string[]>>({});
  const [livePlace, setLivePlace] = useState<{ key: string; at: number } | null>(null);
  const [spin, setSpin] = useState(0);
  const [tick, setTick] = useState(0);
  /** Right after an undo the person can take it back. */
  const [canRedo, setCanRedo] = useState(false);
  const [playing, setPlaying] = useState<{ place?: string; round?: number; full?: boolean } | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [budget, setBudget] = useState<Budget | null>(null);
  /** The build a workshop world's children are watching, until the game starts or the grown-up hides the show. */

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
          // A mask from the memo is still a thing cut out: the stage fills its box either way.
          const m = /^mask:([^/]+)\/([^~#]+)/.exec(String(e.label ?? ''));
          if (m && e.model === 'sam') setCut((c) => ({ ...c, [m[1]]: [...new Set([...(c[m[1]] ?? []), m[2]])] }));
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
          if (e.type === 'job.start') (setCanRedo(false), setJobDone({}), setJobTail(''), setJobPlan(null), setRunning({}), setUndone(null), setNoAgent(null), setSince({}), setJobCalls({}), setLastCall(null), setCut({}));
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
          if (e.view === 'story' || e.view === 'cast') (setPlaying(null), setStage({ kind: e.view }));
          if (e.view === 'workshop') (setPlaying(null), setStage(null));
          if (e.place && e.view !== 'play') (setPlaying(null), setStage({ kind: 'place', place: String(e.place) }));
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
  
  const playable = !!status?.placeDetail.some((p) => p.stages.layout);
  const building = job?.args[0] === 'build' ? job : null;
  const shown = job;
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
  const liveBuild: Live = { plan: job ? ownPlan : [], done: jobDone, running, since, calls: jobCalls, lastCall, tail: jobTail, cut };
  // On stage: the place picked; else a new picture as it lands; else, in turn, the places a step is working on.
  const busy = building ? (status?.placeDetail ?? []).filter((p) => working(p, liveBuild)).map((p) => p.key) : [];
  useEffect(() => {
    if (!building) return;
    const timer = setInterval(() => setSpin((n) => n + 1), 4500);
    return () => clearInterval(timer);
  }, [!!building]);
  const fresh = livePlace && Date.now() - livePlace.at < 4000 ? livePlace.key : null;
  const stageKey = fresh ?? (busy.length ? busy[spin % busy.length] : null) ?? livePlace?.key ?? status?.placeDetail[0]?.key;
  const stagePlace = status?.placeDetail.find((p) => p.key === stageKey);
  // A click on the build bar: the story, the cast or the game, or the place layer the step made.
  const [hold, setHold] = useState<{ layer: LayerName; at: number } | null>(null);
  const openPhase = (phase: string, step?: string) => {
    if (phase === 'story') return onStage({ kind: 'story' });
    if (phase === 'cast') return onStage({ kind: 'cast' });
    if (phase === 'sound') return setByHand('#cast');
    if (phase === 'verify') return playable ? onStage({ kind: 'play' }) : setLogOpen(true);
    const layer = (step && STEP_SHOWS[step]) ?? ({ paint: 'painting', cut: 'masks', space: 'walk' } as Record<string, LayerName>)[phase];
    if (layer) setHold({ layer, at: Date.now() });
  };
  const playLine = (text: string) => setLines((l) => [...l.slice(-400), { seq: -Date.now() - Math.random(), text, kind: 'play' }]);

  const places = status?.placeDetail ?? [];
  const shownView: StageView = playing ? { kind: 'play' } : stage ?? (building ? { kind: 'build' } : { kind: 'place', place: places[0]?.key });
  const onStage = (s: StageView) => {
    setStage(s.kind === 'play' ? null : s);
    if (s.kind === 'play') setPlaying((p) => p ?? { place: undefined });
    else setPlaying(null);
    if (s.kind !== 'place') setPicked((p) => (p && !p.place ? p : null));
  };
  const stagedPlace = shownView.kind === 'place' ? places.find((p) => p.key === shownView.place) ?? places[0] : undefined;
  const unplayable = !job ? places.filter((p) => p.trouble) : [];
  const openNotes = notes.filter((n) => n.state === 'open');
  const ask = (text: string, gist?: string) => askAgent(slug, text, gist).catch((e) => setError(e.message));
  const castDone = !!status?.steps.includes('cast');
  // What the conversation opens with: the idea, then the world as the build made it, card by card.
  const opening = [
    idea && { id: 'idea', afterTurn: 0, text: <div class="idea-bubble">{idea}</div> },
    status?.title && status.steps.includes('story') && { id: 'story', afterTurn: 0, text: (
      <Card kind="Story" by="Muse Spark" on={shownView.kind === 'story'} onClick={() => onStage({ kind: 'story' })}>
        <h3>{status.title}</h3>
        {status.pitch && <p>{status.pitch}</p>}
      </Card>
    ) },
    places.length > 0 && { id: 'places', afterTurn: 0, text: <PlacesCard slug={slug} places={places} stage={shownView} onStage={onStage} /> },
    castDone && { id: 'cast', afterTurn: 0, text: <CastCard slug={slug} version={tick} stage={shownView} onStage={onStage} /> },
  ].filter(Boolean) as ChatNotice[];
  // What a turn of the agent changed: the places it touched, to look at, and its undo.
  const afterTurn = (turn: SessionTurn, _index: number, last: boolean) => {
    // While the agent works its steps fold into one line; what it last said stays out in the open.
    if (!turn.endedAt) {
      const said = turn.entries.findLast((e) => e.kind === 'text');
      return said && said !== turn.entries.at(-1) && said.kind === 'text' && said.text.trim() ? <p class="agent-says">{said.text}</p> : null;
    }
    const touched = [...new Set(turn.entries.flatMap((e) => (e.kind === 'tool' && e.name.startsWith('mcp__diorama__') && !quiet.has(e.name.slice(14)) && e.input && typeof (e.input as { place?: unknown }).place === 'string' ? [String((e.input as { place: string }).place)] : [])))];
    const question = last && turn.endedAt ? asked(turn) : null;
    const changed = touched.length > 0 && turn.endedAt ? (
      <Card kind="Changed" on={shownView.kind === 'place' && touched.includes(shownView.place ?? '')}>
        <div class="thumbs">{touched.map((k) => { const p = places.find((x) => x.key === k); return <button type="button" class="thumb" title={`Show ${nice(k)}`} onClick={() => onStage({ kind: 'place', place: k })} style={p?.image ? { backgroundImage: `url("${fileUrl(slug, p.image.file, p.image.v)}")` } : undefined}>{!p?.image && <span>{nice(k)}</span>}</button>; })}</div>
        <div class="btns"><button type="button" class="ghost small" title="Play the game to see it. Free" onClick={() => onStage({ kind: 'play' })}>▶ Try it</button>{last && <button type="button" class="ghost small" title="Take back the last job. Free" onClick={() => call('history_undo', { slug }).catch((e) => setError(e.message))}>↶ Undo</button>}</div>
      </Card>
    ) : null;
    if (!changed && !question) return null;
    return (
      <>
        {changed}
        {question && (
          <Card kind="The agent asks" tone="ask">
            {question.question && <h3>{question.question}</h3>}
            <div class="btns">{question.options.map((o, i) => <button type="button" class={i === question.recommended ? 'primary small' : 'ghost small'} title={i === question.recommended ? 'What the agent advises' : undefined} onClick={() => void ask(o)}>{o}</button>)}</div>
          </Card>
        )}
      </>
    );
  };
  // While the agent works, its progress is the last thing above the prompt: what waits for you comes back after.
  const footer = (agentBusy: boolean) => (
    <div class="world-footer">
      {movedFrom.value && movedFrom.value !== slug && <Card kind="Moved here" tone="ask"><p>The agent moved the view here from {movedFrom.value}.</p><div class="btns"><button type="button" class="ghost small" onClick={() => { const back = movedFrom.value!; movedFrom.value = null; go(`/w/${back}`); }}>Back to {movedFrom.value}</button><button type="button" class="ghost small" onClick={() => (movedFrom.value = null)}>Stay</button></div></Card>}
      {job && (
        <Card kind={job.by === 'agent' ? 'The agent is building' : 'Building'} by={MODEL_FOR[liveBuild.plan.find((s) => running[s] === 'run') ?? ''] } on={shownView.kind === 'build'} onClick={() => onStage({ kind: 'build' })}>
          <p>{job.label}{job.step ? `: ${job.step}` : ''}{total ? ` · about ${Math.max(1, Math.round(left / 60))} min left` : ''}</p>
          <div class="bar"><i style={{ width: `${Math.round((total ? 1 - left / total : 0.05) * 100)}%` }} /></div>
          {jobTail && <p class="detail">{jobTail}</p>}
          <div class="btns"><button type="button" class="ghost small" title={`Stop ${job.label}`} onClick={(e) => (e.stopPropagation(), call('job_cancel', { id: job.id }))}>Stop</button></div>
        </Card>
      )}
      {failed && !job && !agentBusy && <Card kind="Needs you" tone="ask"><Failed slug={slug} job={failed} noAgent={noAgent} onError={setError} onPlace={(p) => onStage({ kind: 'place', place: p })} /></Card>}
      {unplayable.length > 0 && !failed && !agentBusy && (
        <Card kind="Needs you" tone="ask">
          {unplayable.map((p) => <p><button type="button" class="link" onClick={() => onStage({ kind: 'place', place: p.key })}>{nice(p.key)}</button>: {p.trouble!.why}</p>)}
          <div class="btns"><button type="button" class="primary small" title="The agent fixes them with the Studio tools and says what it did. It uses model calls as it works" onClick={() => void ask(`${unplayable.map((p) => `${p.key}: ${p.trouble!.why}`).join('; ')}. Fix ${unplayable.length > 1 ? 'these places' : 'this place'} as your playbook says and tell me in one sentence what you did.`, `Fix ${unplayable.length > 1 ? `${unplayable.length} places that cannot be played` : `${nice(unplayable[0].key)}: it cannot be played`}`)}>Fix it</button></div>
        </Card>
      )}
      {openNotes.length > 0 && !job && !agentBusy && (
        <Card kind={`${openNotes.every((n) => n.by === 'agent') ? 'The agent noted' : openNotes.some((n) => n.by === 'agent') ? 'Open notes' : 'Your notes'} · ${openNotes.length}`}>
          {openNotes.slice(0, 3).map((n) => <p>{n.by === 'agent' && openNotes.some((x) => x.by !== 'agent') ? <em>the agent: </em> : ''}{n.place ? `${nice(n.place)}: ` : ''}{n.text}</p>)}
          <div class="btns"><button type="button" class="ghost small" onClick={() => setNotesOpen(true)}>All notes</button><button type="button" class="ghost small" title="The agent fixes each open note and closes it with what it did" onClick={() => void ask(`Go through my ${openNotes.length} open note${openNotes.length > 1 ? 's' : ''} (feedback_pending): fix each one and close it with feedback_done.`, `Fix my ${openNotes.length} open note${openNotes.length > 1 ? 's' : ''}`)}>Hand to the agent</button></div>
        </Card>
      )}
      {undone && !job && <p class="world-note">{undone}{canRedo ? ' · ' : ''}{canRedo && <button type="button" class="link" onClick={() => call('history_redo', { slug }).catch((e) => setError(e.message))}>Redo</button>}</p>}
      {budget?.over && <p class="world-note">Budget: ${budget.total.usd} spent of the ${budget.limitUsd} limit.</p>}
      {playable && !job && !agentBusy && (
        <div class={`wcard play${shownView.kind === 'play' ? ' on' : ''}`} style={places[0]?.image ? { backgroundImage: `url("${fileUrl(slug, places[0].image.file, places[0].image.v)}")` } : undefined}>
          <div class="in"><div class="grow"><div class="k">Ready</div><h3>Play {status?.title ?? slug}</h3></div><button type="button" class="amber" onClick={() => onStage({ kind: 'play' })}>▶ Play</button></div>
        </div>
      )}
      {error && <p class="error">{error}</p>}
    </div>
  );
  // The tab says which world it is.
  useEffect(() => {
    document.title = `${status?.title ?? slug} · Diorama`;
    return () => void (document.title = 'Diorama Studio');
  }, [status?.title, slug]);
  const stageTitle = shownView.kind === 'place' ? nice(stagedPlace?.key ?? '') : shownView.kind === 'cast' ? 'Cast' : shownView.kind === 'story' ? 'Story' : shownView.kind === 'build' ? (stagePlace ? nice(stagePlace.key) : 'Building') : status?.title ?? slug;
  const stageHint = shownView.kind === 'place' ? 'Click a thing to talk about it' : shownView.kind === 'cast' ? 'Click someone to talk about them' : shownView.kind === 'play' ? 'Click to walk, right click to look, or a gamepad' : '';

  return (
    <>
      <main class="world" ref={worldRef}>
        <section class="convo">
          <header>
            <h1 title={status?.pitch ?? undefined}>{status?.title ?? slug}</h1>
            <small>{places.length ? `${places.length} places` : 'being made'}{status && status.playable ? ` · ${status.playable} playable` : ''}{job ? ' · building' : playable ? ' · ready to play' : ''}{live ? '' : ' · reconnecting…'}</small>
          </header>
          <AgentPanel slug={slug} replay={replay} speed={speed} jobs={status?.jobs ?? []} notices={opening} afterTurn={afterTurn} footer={footer} picked={picked} onUnpick={() => setPicked(null)}
            empty={<span />} />
        </section>
        <section class="theatre" ref={stageRef}>
          <div class="stage-top">
            <h2>{stageTitle}</h2>
            {stageHint && <small>{stageHint}</small>}
            <span class="grow" />
            {playable && <button type="button" class={shownView.kind === 'play' ? 'ghost' : 'amber'} title={shownView.kind === 'play' ? 'Close the game' : 'Play the game here. Free'} onClick={() => onStage(shownView.kind === 'play' ? { kind: 'place', place: places[0]?.key } : { kind: 'play' })}>{shownView.kind === 'play' ? 'Close game' : '▶ Play'}</button>}
            {playable && !job && <ShareButton slug={slug} jobs={status?.jobs ?? []} onError={setError} />}
            <button type="button" class="ghost wide" title="The stage alone on the whole screen, for recording. Esc comes back" onClick={() => stageRef.current?.querySelector<HTMLElement>('.stage-body')?.requestFullscreen().catch((e) => setError(e.message))}>Film</button>
            <Bell />
            <Menu>
              {!job && status && status.steps.length > 0 && <HistoryMenu slug={slug} version={tick} onError={setError} />}
              {!job && status && !status.issue && <StyleMenu slug={slug} places={places.map((p) => p.key)} version={tick} onError={setError} />}
              <hr />
              <button type="button" class="mi go" title="What the build, the agent and the game did, line by line" onClick={() => setLogOpen(true)}>Activity</button>
              <button type="button" class="mi go" title="Your notes on this diorama, open and done" onClick={() => setNotesOpen(true)}>Notes{openNotes.length ? ` · ${openNotes.length}` : ''}</button>
              {!job && status && !status.issue && <><hr /><Rebuild slug={slug} again={status.steps.length >= steps.length - 1} onError={setError} /></>}
            </Menu>
          </div>
          <div class={`stage-body ${shownView.kind}`}>
            {shownView.kind === 'play' && <Play slug={slug} place={playing?.place} round={playing?.round ?? 0} full={playing?.full} onRestart={() => setPlaying({ ...playing, round: (playing?.round ?? 0) + 1 })} version={tick} onLine={playLine} onError={setError} />}
            {shownView.kind === 'build' && status && (
              <div class="build-on-stage">
                <Pipeline job={job} all={steps} live={liveBuild} build={status.build} typical={status.typical ?? {}} onOpen={openPhase} />
                {stagePlace ? <Stage slug={slug} place={stagePlace} live={liveBuild} building={!!building} hold={hold} /> : <figure class="stage-live"><div class="frame"><div class="empty"><span>{status.pitch ?? 'Muse Spark is dreaming up the places…'}</span></div></div></figure>}
              </div>
            )}
            {shownView.kind === 'place' && stagedPlace && <PlaceStage slug={slug} place={stagedPlace} version={tick} picked={picked} onPick={setPicked} />}
            {shownView.kind === 'place' && !stagedPlace && <div class="mat"><p class="detail">{status?.pitch ?? 'Muse Spark is dreaming up the places…'}</p></div>}
            {shownView.kind === 'cast' && <CastStage slug={slug} version={tick} picked={picked} onPick={setPicked} />}
            {shownView.kind === 'place' && stagedPlace?.stages.painting && <button type="button" class="stage-tool" title="Masks, floors, stand spots and repaints for this place, by hand. Or just ask the agent" onClick={() => setByHand(stagedPlace.key)}>✎ Fix this place by hand</button>}
            {shownView.kind === 'cast' && castDone && <button type="button" class="stage-tool" title="Looks, voices, moves and inventory icons, by hand. Or just ask the agent" onClick={() => setByHand('#cast')}>✎ Cast details</button>}
            {shownView.kind === 'story' && <div class="paper-panel"><StoryView slug={slug} version={tick} onError={setError} /></div>}
          </div>
        </section>
      </main>
      {byHand && (
        <div class="drawer-back" onClick={(e) => e.target === e.currentTarget && setByHand(null)}>
          <section class="drawer by-hand" role="dialog" aria-label="By hand">
            <div class="row"><h2>{byHand === '#cast' ? 'Cast' : `${nice(byHand)}, by hand`}</h2><span class="grow" /><button type="button" class="ghost tiny" aria-label="Close" title="Close (Esc)" onClick={() => setByHand(null)}>✕</button></div>
            {byHand === '#cast' ? <CastView slug={slug} version={tick} onError={setError} /> : <PlaceEditor slug={slug} place={byHand} version={tick} onError={setError} />}
          </section>
        </div>
      )}
      {logOpen && (
        <div class="drawer-back" onClick={(e) => e.target === e.currentTarget && setLogOpen(false)}>
          <section class="drawer log" role="dialog" aria-label="Activity">
            <div class="row"><h2>Activity</h2><span class="grow" /><button type="button" class="ghost tiny" aria-label="Close" title="Close (Esc)" onClick={() => setLogOpen(false)}>✕</button></div>
            <div class="row"><span class="detail" title={status ? `this world: ${Object.entries(status.calls).map(([m, n]) => `${m} ${n}`).join(', ') || 'no calls yet'}` : undefined}>{calls} calls this session{budget ? ` · ${spend(budget.today)} today · ${spend(budget.total)}${budget.limitUsd !== null ? ` of $${budget.limitUsd}` : ''} total` : ''}</span></div>
            <label class="detail" title="Also show every line the build steps print, not only what matters"><input type="checkbox" checked={allLines} onChange={(e) => setAllLines(e.currentTarget.checked)} /> Every line the steps print</label>
            <ol>{[...lines].reverse().filter((l) => allLines || l.kind !== 'out').map((l) => <li key={l.seq} class={l.kind}>{l.text}</li>)}</ol>
          </section>
        </div>
      )}
      {notesOpen && (
        <div class="drawer-back" onClick={(e) => e.target === e.currentTarget && setNotesOpen(false)}>
          <section class="drawer" role="dialog" aria-label="Notes">
            <div class="row"><h2>Your notes</h2><span class="grow" /><button type="button" class="ghost tiny" aria-label="Close notes" onClick={() => setNotesOpen(false)}>✕</button></div>
            <Notes slug={slug} notes={notes} onPlace={(p) => { onStage({ kind: 'place', place: p }); setNotesOpen(false); }} onError={setError} />
          </section>
        </div>
      )}
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
  // The gamepad choice shows only once two pads are plugged in: with one or none it means nothing.
  const [padCount, setPadCount] = useState(0);
  useEffect(() => {
    const count = () => setPadCount((navigator.getGamepads?.() ?? []).filter(Boolean).length);
    count();
    // Pads wake on a button press, often inside the game's frame where these events do not reach: look now and then too.
    const timer = setInterval(count, 2000);
    addEventListener('gamepadconnected', count);
    addEventListener('gamepaddisconnected', count);
    return () => (clearInterval(timer), removeEventListener('gamepadconnected', count), removeEventListener('gamepaddisconnected', count));
  }, []);
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
        <span class="detail">click to walk or use, right click to look{padCount ? ', or use the gamepad' : ''}</span>
        <span class="grow" />
        {padCount > 1 && <label class="detail" title="With several gamepads: all steer the one hero, they take turns, or each pad has its own hero">
          Gamepads{' '}
          <select value={pads} onChange={(e) => pickPads(e.currentTarget.value)}>
            <option value="">one hero</option>
            <option value="turns">take turns</option>
            <option value="party">a hero each</option>
          </select>
        </label>}
        <button type="button" class="ghost small" title="Start the game over from the beginning. Free" onClick={onRestart}>Restart</button>
        {/* For a big screen: the game letterboxes to it, keyboard and gamepads keep working; Esc comes back. */}
        <button type="button" class="ghost small" title="Play on the whole screen (Esc to come back)" onClick={() => frame.current?.requestFullscreen().then(() => frame.current?.focus()).catch((err) => onError(err.message))}>Full screen</button>
        <button type="button" class="ghost small" title="The bot plays every route to an ending in a browser and says where it got stuck. A minute or two, no model calls" onClick={() => call('playthrough', { slug }).catch((err) => onError(err.message))}>Bot playthrough</button>
      </div>
      {!fresh && (
        <div class="banner row" role="status">
          <span>The world changed since this game started.</span>
          <span class="grow" />
          <button type="button" class="primary small" title="Start the game again with the latest changes" onClick={onRestart}>Reload the game</button>
        </div>
      )}
      {/* The game letterboxes to the room it is given, never wider or taller: no page scroll while playing. */}
      <div class="screen">
        <iframe ref={frame} key={`${src}#${round}`} src={src} title={`${slug}, playable`} onLoad={hook} allow="autoplay; fullscreen; gamepad" allowFullScreen />
      </div>
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
  const ask = () => askAgent(slug, `The job "${job.label}" failed${step ? ` at the ${step} step` : ''}: ${job.error ?? 'see its output'}. Find out why with world_status and place_status, fix it only with the Studio fix tools (never by editing files), and tell me what you did.`, `Fix the failed ${job.label.split(' ')[0] === 'build' ? 'build' : `“${job.label}”`}${step ? ` at ${step}` : ''}: ${plainError(job.error)}`).catch((e) => onError(e.message));
  return (
    <section class="failed" role="alert">
      <div class="row"><strong>{job.label} failed{step ? ` at ${step}` : ''}</strong><span class="detail">by {job.by}</span></div>
      {job.unplayable?.length ? job.unplayable.map((u) => (
        <div class="row"><button type="button" class="ghost small" title="Open this place to look at it and fix it" onClick={() => onPlace(u.place)}>{u.place}</button><span class="error">{u.errors.join(' · ') || 'not playable: see verify.json'}</span></div>
      )) : job.error && <p class="error">{job.error}</p>}
      {noAgent && listed && <p class="detail">The agent would repair these, but {noAgent} is not installed on this computer. <a href="/setup" onClick={(e) => (e.preventDefault(), go('/setup'))}>Setup</a> says how to add it.</p>}
      {lines.length > 0 && (more || !listed) && <pre>{(more ? lines : lines.slice(-6)).join('\n')}</pre>}
      <div class="row">
        <button type="button" class="primary small" title="Run the job again from the step it failed on. Done steps are free" onClick={retry}>Try again</button>
        <button type="button" class="ghost small" disabled={!!noAgent} title={noAgent ? `${noAgent} is not installed` : 'The agent finds out why and fixes it with the Studio tools. It uses model calls as it works'} onClick={ask}>Ask the agent</button>
        <button type="button" class="ghost small" title="Put the world back as it was before this job. Free" onClick={() => call('history_undo', { slug }).catch((e) => onError(e.message))}>Undo it</button>
        <span class="grow" />
        {(lines.length > 6 || (listed && lines.length > 0)) && <button type="button" class="ghost small" title={more ? 'Show only the last lines' : 'Every line the job printed'} onClick={() => setMore(!more)}>{more ? 'Less' : `Its output (${lines.length} lines)`}</button>}
      </div>
    </section>
  );
}

/** The person's notes on this world: open ones wait for a fix, done ones say what was done. */
function Notes({ slug, notes, onPlace, onError }: { slug: string; notes: Note[]; onPlace: (p: string) => void; onError: (m: string) => void }) {
  const [text, setText] = useState('');
  const open = notes.filter((n) => n.state === 'open');
  const done = notes.filter((n) => n.state === 'done').reverse();
  const add = (e: Event) => {
    e.preventDefault();
    call('feedback_add', { slug, text: text.trim() }).then(() => setText('')).catch((err) => onError(err.message));
  };
  return (
    <section class="notes">
      <div class="row">
        <h2>Notes{open.length ? ` · ${open.length} open` : ''}</h2>
        <span class="grow" />
        {open.length > 0 && <button type="button" class="primary small" title="The agent fixes each open note and closes it with what it did. It uses model calls as it works" onClick={() => askAgent(slug, `Go through my ${open.length} open note${open.length > 1 ? 's' : ''} (feedback_pending): fix each one and close it with feedback_done.`, `Fix my ${open.length} open note${open.length > 1 ? 's' : ''}`).catch((e) => onError(e.message))}>Hand {open.length > 1 ? 'them' : 'it'} to the agent</button>}
      </div>
      <ul>
        {open.map((n) => (
          <li class="open">
            {n.place && <button type="button" class="ghost small" title="Open the place this note is on" onClick={() => onPlace(n.place!)}>{n.place}{n.point ? ` @${n.point.join(',')}` : ''}</button>}
            <span>{n.text}</span>
            <span class="grow" />
            <button type="button" class="ghost small" title="Close the note: you fixed it yourself" onClick={() => call('feedback_done', { slug, id: n.id, reply: 'done by hand' }).catch((e) => onError(e.message))}>Done</button>
          </li>
        ))}
        {done.map((n) => (
          <li class="done">
            <span>{n.text}</span>
            <span class="detail">→ {n.reply}</span>
            <span class="grow" />
            <button type="button" class="ghost small" title="Open the note again: it is not fixed" onClick={() => call('feedback_reopen', { slug, id: n.id }).catch((e) => onError(e.message))}>Reopen</button>
          </li>
        ))}
      </ul>
      <form class="row" onSubmit={add}>
        <input class="grow" placeholder="A note on the whole world (or pick a place and use Note on its picture)" value={text} onInput={(e) => setText(e.currentTarget.value)} />
        <button type="submit" class="ghost small" disabled={text.trim().length < 2} title="Keep the note open until it is fixed. Free">Add</button>
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
  return <Shell />;
}

/** The atelier: the worlds rail on the left, then the page (the prompt, a world, or Setup). */
function Shell() {
  useAtelierFeed();
  const path = route.value;
  const world = /^\/w\/([a-z][a-z0-9-]*)/.exec(path)?.[1];
  return (
    <div class="atelier">
      <Rail />
      <div class="atelier-page">{path === '/setup' ? <Setup /> : world ? <Workshop key={world} slug={world} /> : <Start />}</div>
    </div>
  );
}

render(<><App /><Tips /><Lightbox /></>, document.getElementById('app')!);
