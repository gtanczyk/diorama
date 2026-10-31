// The atelier around every world: the mark, the worlds rail (each world's painting, a ring while it builds, a
// red dot when it waits for you) and the bell that gathers what is building and what needs you. One studio-wide
// feed keeps them live; the worlds come from world_list, the same action the agent and the CLI use.
import { signal } from '@preact/signals';
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl, follow } from './api.ts';
import { go, route } from './nav.ts';
import { doneWords, jobWords, stepWords } from './job-words.ts';

/** The Diorama mark: an arched opening onto painted layers, a moon and the ground you walk on. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <defs><clipPath id="dio-arch"><path d="M7.4 28 V14 A8.6 8.6 0 0 1 24.6 14 V28Z" /></clipPath></defs>
      <path d="M5.2 28.8 V14 A10.8 10.8 0 0 1 26.8 14 V28.8Z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round" />
      <g clip-path="url(#dio-arch)">
        <circle cx="19.5" cy="12" r="2.8" fill="var(--amber, #c27a2c)" />
        <path d="M6 22 C10 18 14 18 18 21 C21 23 24 22 27 19.5 V29 H6Z" fill="currentColor" opacity=".32" />
        <path d="M6 26 C11 22.5 16 22.8 21 25 C23 26 25 25.6 27 25 V29 H6Z" fill="currentColor" />
      </g>
    </svg>
  );
}

export type WorldSummary = { slug: string; title: string; pitch: string | null; issue: string | null; places: number; playable: number; verified: number; steps: string[]; cover: { file: string; v: number | null } | null; workshop?: boolean };
/** A world's job right now: its steps, the ones done, the one running; failed when the last job failed. */
type Busy = { label: string; plan: string[]; done: string[]; step?: string; by: string };
type Ended = { label: string; ok: boolean; at: number; error?: string };

export const worlds = signal<WorldSummary[] | null>(null);
export const busy = signal<Record<string, Busy>>({});
const ended = signal<Record<string, Ended>>({});
const seen = signal<Record<string, number>>(readSeen());

function readSeen(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem('diorama.seen') ?? '{}') as Record<string, number>;
  } catch {
    return {};
  }
}
/** Bell notes put away by hand, per world: the note's words. The same note stays away; a new one (other words) shows again. */
const dismissed = signal<Record<string, string>>(readDismissed());
function readDismissed(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem('diorama.dismissed') ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}
function dismiss(slug: string, note: string) {
  dismissed.value = { ...dismissed.value, [slug]: note };
  try {
    localStorage.setItem('diorama.dismissed', JSON.stringify(dismissed.value));
  } catch {
    // A private window keeps it for this visit only.
  }
}

function markSeen(slug: string) {
  seen.value = { ...seen.value, [slug]: Date.now() };
  try {
    localStorage.setItem('diorama.seen', JSON.stringify(seen.value));
  } catch {
    // A private window keeps it for this visit only.
  }
}

let revision = 0;
const refresh = async () => {
  const current = ++revision;
  try {
    const list = await call<WorldSummary[]>('world_list');
    if (current === revision) worlds.value = list;
  } catch {}
};

/** Forget a confirmed deletion immediately, including any list response already in flight. */
export function forgetWorld(slug: string) {
  revision++;
  worlds.value = worlds.value?.filter((w) => w.slug !== slug) ?? null;
  const nextBusy = { ...busy.value }, nextEnded = { ...ended.value };
  delete nextBusy[slug];
  delete nextEnded[slug];
  busy.value = nextBusy;
  ended.value = nextEnded;
}

/** Starts the studio-wide feed once: jobs start and end, steps finish; the worlds list is read again after. */
export function useAtelierFeed() {
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const soon = () => (clearTimeout(timer), (timer = setTimeout(refresh, 600)));
    const stop = follow(null, (e) => {
      const slug = String(e.world ?? '');
      if (!slug) return;
      const job = e.job as { label?: string; by?: string; state?: string; error?: string; args?: string[] } | undefined;
      const b = busy.value[slug];
      switch (e.type) {
        case 'world.deleted':
          forgetWorld(slug);
          return soon();
        case 'job.start':
          busy.value = { ...busy.value, [slug]: { label: job?.label ?? 'build', plan: [], done: [], by: job?.by ?? 'you' } };
          return soon();
        case 'build.start':
          if (b) busy.value = { ...busy.value, [slug]: { ...b, plan: e.steps as string[] } };
          return;
        case 'step.start':
          if (b) busy.value = { ...busy.value, [slug]: { ...b, step: String(e.step) } };
          return;
        case 'step.end':
          if (b) busy.value = { ...busy.value, [slug]: { ...b, done: [...b.done, String(e.step)] } };
          return soon();
        case 'job.end': {
          const next = { ...busy.value };
          delete next[slug];
          busy.value = next;
          ended.value = { ...ended.value, [slug]: { label: job?.label ?? 'job', ok: job?.state === 'done', at: Date.parse(e.at), error: job?.error } };
          return soon();
        }
      }
    });
    return () => (stop(), clearTimeout(timer));
  }, []);
}

const progress = (b: Busy) => (b.plan.length ? Math.min(0.97, (b.done.length + 0.4) / b.plan.length) : 0.05);
/** Waits for the person: the last job failed, or the world is built but some place is not playable. */
function needs(w: WorldSummary): string | null {
  if (busy.value[w.slug]) return null;
  const e = ended.value[w.slug];
  if (e && !e.ok) return `${e.label} failed${e.error ? `: ${e.error}` : ''}`;
  if (w.issue && w.issue !== 'no world.json yet') return w.issue;
  if (w.places > 0 && w.steps.includes('verify') && w.playable < w.places) return `${w.places - w.playable} of ${w.places} places not playable yet`;
  return null;
}

function Ring({ p }: { p: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg class="ring" width="24" height="24" viewBox="0 0 24 24" aria-label={`${Math.round(p * 100)}% built`}>
      <circle cx="12" cy="12" r={r} class="track" />
      <circle cx="12" cy="12" r={r} class="done" stroke-dasharray={`${c * p} ${c}`} transform="rotate(-90 12 12)" />
    </svg>
  );
}

const here = () => /^\/w\/([a-z][a-z0-9-]*)/.exec(route.value)?.[1] ?? null;

/** Every world as its painting, newest first; the one open is ringed in amber. */
export function Rail() {
  const open = here();
  useEffect(() => void (open && markSeen(open)), [open]);
  return (
    <nav class="rail" aria-label="Worlds">
      <a href="/" class="mark-link" title="The atelier: describe a new world" onClick={(e) => (e.preventDefault(), go('/'))}><Logo size={30} /><span>Diorama</span></a>
      <button type="button" class="new" title="A new world: describe it in a sentence" aria-label="New world" onClick={() => go('/')}>+</button>
      <div class="rail-worlds">
        {worlds.value?.filter((w) => !(w.workshop && w.issue === 'no world.json yet')).map((w) => {
          const b = busy.value[w.slug];
          const n = needs(w);
          return (
            <a href={`/w/${w.slug}`} class={`rail-world${open === w.slug ? ' on' : ''}`} title={`${w.title}${b ? ` · ${b.label}${b.step ? `: ${b.step}` : ''}` : n ? ` · needs you: ${n}` : ''}`} onClick={(e) => (e.preventDefault(), markSeen(w.slug), go(`/w/${w.slug}`))}>
              <span class="th" style={w.cover ? { backgroundImage: `url("${fileUrl(w.slug, w.cover.file, w.cover.v)}")` } : undefined} />
              {b ? <Ring p={progress(b)} /> : n ? <span class="dot-needs" aria-label="needs you">!</span> : null}
              <span class="lb">{w.title}</span>
            </a>
          );
        })}
      </div>
    </nav>
  );
}

/** What a world's running job does, for the bell: who, what, which step now, how far. */
function busyWords(b: Busy): string {
  const what = jobWords(b.label);
  const now = b.step ? `, now ${stepWords(b.step)}` : '';
  const far = b.plan.length ? ` · step ${Math.min(b.done.length + 1, b.plan.length)} of ${b.plan.length}` : '';
  return `${b.by === 'agent' ? 'The agent is ' : ''}${b.by === 'agent' ? what : what.replace(/^./, (c) => c.toUpperCase())}${now}${far}`;
}

/** What is building, what waits for you, and what finished since you last looked: one click goes there. */
export function Bell() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: Event) => !(e.target as HTMLElement).closest?.('.bell-wrap') && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    addEventListener('pointerdown', close);
    addEventListener('keydown', esc);
    return () => (removeEventListener('pointerdown', close), removeEventListener('keydown', esc));
  }, [open]);
  const list = worlds.value ?? [];
  const items = [
    ...list.flatMap((w) => (needs(w) && dismissed.value[w.slug] !== `needs:${needs(w)}` ? [{ w, kind: 'needs', text: needs(w)! }] : [])),
    ...list.flatMap((w) => { const b = busy.value[w.slug]; return b ? [{ w, kind: 'busy', text: busyWords(b) }] : []; }),
    ...list.flatMap((w) => { const e = ended.value[w.slug]; return e?.ok && !busy.value[w.slug] && e.at > (seen.value[w.slug] ?? 0) ? [{ w, kind: 'done', text: doneWords(e.label) }] : []; }),
  ];
  // A note that waits for you, or a finished job, can be put away; a build in progress is live and stays.
  const put = (i: (typeof items)[number]) => (i.kind === 'done' ? markSeen(i.w.slug) : dismiss(i.w.slug, `needs:${i.text}`));
  const away = items.filter((i) => i.kind !== 'busy');
  const loud = items.filter((i) => i.kind !== 'busy').length;
  return (
    <div class="bell-wrap">
      <button type="button" class={`bell${loud ? ' loud' : ''}`} aria-expanded={open} title="What is building and what waits for you" aria-label={`Notifications${items.length ? `: ${items.length}` : ''}`} onClick={() => setOpen(!open)}>
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z" /><path d="M10 20.5a2 2 0 0 0 4 0" /></svg>
        {items.length > 0 && <b>{items.length}</b>}
      </button>
      {open && (
        <div class="bell-pop" role="menu">
          {items.length === 0 && <p class="detail">Nothing building, nothing waiting for you.</p>}
          {items.map((i) => {
            const { w, kind, text } = i;
            return (
              <div class="bell-row">
                <a href={`/w/${w.slug}`} class={`bell-item ${kind}`} onClick={(e) => (e.preventDefault(), markSeen(w.slug), setOpen(false), go(`/w/${w.slug}`))}>
                  <span class="th" style={w.cover ? { backgroundImage: `url("${fileUrl(w.slug, w.cover.file, w.cover.v)}")` } : undefined} />
                  <span><strong>{w.title}</strong> {kind === 'needs' ? 'needs you' : kind === 'busy' ? 'is building' : 'is ready'}<small>{text}</small></span>
                </a>
                {kind !== 'busy' && <button type="button" class="ghost tiny bell-x" aria-label={`Dismiss: ${w.title}`} title={kind === 'needs' ? 'Dismiss. It comes back only if something new needs you' : 'Dismiss'} onClick={() => put(i)}>✕</button>}
              </div>
            );
          })}
          {away.length > 1 && <button type="button" class="ghost small bell-clear" onClick={() => away.forEach(put)}>Clear all</button>}
        </div>
      )}
    </div>
  );
}
