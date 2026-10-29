// The build as it happens: one progress line in seven phases, each named for the model that does it; a stage
// where the place being worked on is painted, cut out, measured in depth and laid out for walking, picture over
// picture; the story growing beside it; and every place as a strip below. Everything comes from world_status,
// the live feed (step, call and file events) and the story, icons and cast actions the other tabs read too.
import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';
import { timeLeft } from '../src/world/schedule.ts';

export type Layer = { file: string; v: number | null };
export type LayerName = 'blockin' | 'first' | 'painting' | 'masks' | 'depth' | 'walk';
export type StagePlace = {
  key: string;
  shows: string;
  things: Array<{ key: string; role: string }>;
  layers?: Partial<Record<LayerName, Layer>>;
  image: Layer | null;
  verdict: { ok: boolean; errors: unknown[] } | null;
  /** Why the place is not playable, and the step Fix it rebuilds it from (null: Fix it asks the agent). */
  trouble?: { why: string; from: string | null } | null;
};

/** The build's steps in seven phases, each with what does the work. Meta's models first, by name. */
export const PHASES = [
  { key: 'story', title: 'Story', by: ['Muse Spark'], steps: ['world', 'story'] },
  { key: 'paint', title: 'Paint', by: ['Muse Image', 'Muse Spark'], steps: ['layout', 'paint'] },
  { key: 'cut', title: 'Cut out', by: ['SAM 3.1', 'Muse Image'], steps: ['masks', 'plates', 'icons'] },
  { key: 'space', title: 'Depth and walk', by: ['Depth Anything', 'code'], steps: ['derive', 'backdrop', 'weather'] },
  { key: 'cast', title: 'Cast', by: ['Muse Image', '3D'], steps: ['cast', 'model', 'sprites'] },
  { key: 'sound', title: 'Sound', by: ['ElevenLabs'], steps: ['sound', 'voices'] },
  { key: 'verify', title: 'Play test', by: ['code'], steps: ['verify'] },
] as const;

/** memo/calls.jsonl's model names as people know them. */
export const MODEL_NAME: Record<string, string> = { spark: 'Muse Spark', muse: 'Muse Image', sam: 'SAM 3.1', sound: 'ElevenLabs', music: 'ElevenLabs', voice: 'ElevenLabs', space: '3D' };
const META = new Set(['Muse Spark', 'Muse Image', 'SAM 3.1']);
const tone = (by: string) => ({ 'Muse Spark': 'spark', 'Muse Image': 'image', 'SAM 3.1': 'sam' })[by] ?? 'other';

/** A model another than Meta's, by a short name: what a call's `via` or Setup's pick names. */
export function viaName(via: string): string {
  if (/claude/i.test(via)) return 'Claude';
  if (/banana/i.test(via)) return 'Nano Banana';
  if (/gemini|google/i.test(via)) return 'Gemini';
  return via.replace(/^openrouter:/, '');
}

/** Who stands in for Spark and Muse Image (Setup's pick); the labels follow it. */
export const standIn = signal<{ spark: string | null; image: string | null }>({ spark: null, image: null });

/** A model's name as it works now: "Muse Spark" reads "Claude" while Claude answers Spark's asks. */
export const nowBy = (by: string) => (by === 'Muse Spark' && standIn.value.spark) || (by === 'Muse Image' && standIn.value.image) || by;

/** memo/calls.jsonl's model and via as people know them. */
export const callBy = (model: string, via?: unknown) => (typeof via === 'string' && via !== 'contributor' ? viaName(via) : MODEL_NAME[model] ?? model);

export function ModelTag({ by }: { by: string }) {
  const name = nowBy(by);
  return <span class={`model ${tone(by)}${META.has(name) ? ' meta' : ''}`}>{name}</span>;
}

const clock = (ms: number) => {
  const t = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

export type Live = {
  /** The steps of the running job (build.start, else its arguments), done ones with their seconds, the running one. */
  plan: string[];
  done: Record<string, number>;
  running: Record<string, 'run' | 'fail'>;
  /** When each running step began (ms), to tell a place's new picture from its old one. */
  since: Record<string, number>;
  /** Calls sent per model since the job began, and the last one. */
  calls: Record<string, number>;
  lastCall: { by: string; label: string; at: number } | null;
  /** Per place, the things SAM has cut out so far in this job (from its `mask:place/thing` calls). */
  cut: Record<string, string[]>;
  tail: string;
};

type JobLike = { label: string; by: string; state: string; startedAt?: string };

/**
 * The one progress display: phases as a bar, each as wide as it usually takes, filled as its steps finish.
 * Idle, it shows which steps the world has; running, the time and what is left, from the last build's step
 * times (world_status.typical), never a made-up countdown.
 */
/** What each step leaves on the stage, for a click on its segment: the place layer it makes. */
export const STEP_SHOWS: Record<string, LayerName> = { layout: 'blockin', paint: 'painting', masks: 'masks', plates: 'masks', derive: 'walk', backdrop: 'depth', weather: 'painting' };

export function Pipeline({ job, all, live, build, typical, onOpen }: { job?: JobLike; all: string[]; live: Live; build: Record<string, { seconds: number }>; typical: Record<string, number>; onOpen?: (phase: string, step?: string) => void }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!job) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [!!job]);
  const { plan, done, running } = live;
  const took = (s: string) => build[s]?.seconds ?? typical[s] ?? 30;
  const state = (s: string): 'ok' | 'run' | 'fail' | 'todo' | 'skip' => {
    if (running[s] === 'fail') return 'fail';
    if (done[s] !== undefined) return 'ok';
    if (running[s] === 'run') return 'run';
    if (job && plan.length && !plan.includes(s)) return build[s] ? 'ok' : 'skip';
    return !job && build[s] ? 'ok' : 'todo';
  };
  const started = job?.startedAt ? Date.parse(job.startedAt) : null;
  const elapsed = started ? now - started : 0;
  // Several steps run at once (places side by side, cast and voices alongside): each has its own clock.
  const runStep = Object.keys(running).find((s) => running[s] === 'run');
  const runFor = (s: string) => (running[s] === 'run' && live.since[s] ? now - live.since[s] : 0);
  // Time left is the longest chain of what is still to do along the build's web, not the sum of every step.
  const left = timeLeft(plan, (s) => (done[s] !== undefined ? 0 : Math.max(0, took(s) * 1000 - runFor(s))));
  const known = plan.length > 0 && plan.every((s) => done[s] !== undefined || build[s] || typical[s] !== undefined);
  const when = !job ? null : job.state === 'queued' ? 'waiting for the job before it'
    : `${clock(elapsed)}${!known ? '' : left > 30_000 ? ` · about ${Math.max(1, Math.round(left / 60_000))} min left` : runStep && left === 0 ? ' · longer than last time' : ' · almost done'}`;
  const phases = PHASES.map((p) => ({ ...p, steps: p.steps.filter((s) => all.includes(s)) })).filter((p) => p.steps.length);
  const weight = (p: (typeof phases)[number]) => p.steps.reduce((sum, s) => sum + took(s), 0);
  const calls = Object.entries(live.calls).filter(([, n]) => n > 0).sort(([a], [b]) => Number(META.has(b)) - Number(META.has(a)));
  const fresh = live.lastCall && now - live.lastCall.at < 4000;
  return (
    <section class={`pipeline${job ? ' on' : ''}`} aria-live="polite">
      <div class="row head">
        <strong>{job ? `${job.by === 'agent' ? 'Agent: ' : ''}${job.label}` : 'Build'}</strong>
        {job && calls.map(([by, n]) => <span class={`count ${tone(by)}${fresh && live.lastCall?.by === by ? ' hot' : ''}`}><ModelTag by={by} /> {n}</span>)}
        {/* A step's raw line is cut to what it is doing ("barn-interior layout try 1"); the whole line is on hover. */}
        <span class="detail tail" title={job ? live.tail : undefined}>{job ? (fresh && live.lastCall ? `${live.lastCall.by}: ${live.lastCall.label}` : live.tail.split(/: |[.!?]\s/)[0].slice(0, 60)) : ''}</span>
        {when && <span class="detail when">{when}</span>}
      </div>
      <ol class="phases" aria-label="Build phases">
        {phases.map((p) => {
          const states = p.steps.map(state);
          const all = weight(p);
          // Filled by the steps done and by the running one's share of its usual time.
          const filled = p.steps.reduce((sum, s, i) => sum + (states[i] === 'ok' ? took(s) : states[i] === 'run' ? Math.min(took(s) * 0.95, runFor(s) / 1000) : 0), 0);
          const phase = states.includes('fail') ? 'fail' : states.includes('run') ? 'run' : states.every((x) => x === 'ok') ? 'ok' : states.every((x) => x === 'skip') ? 'skip' : 'todo';
          // Something to show once a step has run (or runs now); a click puts it on the stage.
          const open = onOpen && phase !== 'todo' && phase !== 'skip';
          const tip = `${p.title} · ${p.by.join(', ')}\n` + p.steps.map((s, i) => `${states[i] === 'ok' ? '✓' : states[i] === 'run' ? '…' : states[i] === 'fail' ? '✕' : '·'} ${s}${done[s] !== undefined ? ` ${Math.round(done[s])}s` : ''}`).join('\n');
          let at = 0;
          return (
            <li class={`${phase}${open ? ' open' : ''}`} style={{ flexGrow: Math.max(1, all) }}>
              <span class="bar"><span class="fill" style={{ width: `${Math.round((100 * filled) / Math.max(1, all))}%` }} />
                {p.steps.slice(1).map((s) => <span class="tick" style={{ left: `${(100 * p.steps.slice(0, p.steps.indexOf(s)).reduce((a, x) => a + took(x), 0)) / Math.max(1, all)}%` }} />)}
                {open && p.steps.map((s, i) => {
                  const from = at;
                  at += took(s);
                  const ready = states[i] === 'ok' || states[i] === 'run';
                  return ready && <button type="button" class="seg" style={{ left: `${(100 * from) / Math.max(1, all)}%`, width: `${(100 * took(s)) / Math.max(1, all)}%` }}
                    title={`${s}${states[i] === 'run' ? ', running' : done[s] !== undefined ? `, ${Math.round(done[s])} s` : ''}. Click to see what it made`} onClick={() => onOpen!(p.key, s)} />;
                })}
              </span>
              {open
                ? <button type="button" class="label" title={`${tip}\nClick to see what it made`} onClick={() => onOpen!(p.key)}><span class="name">{p.title}</span>{p.by[0] !== 'code' && <ModelTag by={p.by[0]} />}</button>
                : <span class="label" title={tip}><span class="name">{p.title}</span>{p.by[0] !== 'code' && <ModelTag by={p.by[0]} />}</span>}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** What a place step leaves behind, and who makes it. */
const STEP_LAYER: Record<string, { layer: LayerName; doing: string; by: string }> = {
  layout: { layer: 'blockin', doing: 'plans where every thing, light and floor goes', by: 'Muse Spark' },
  paint: { layer: 'painting', doing: 'paints over the plan sketch', by: 'Muse Image' },
  masks: { layer: 'masks', doing: 'cuts out every thing and the floor', by: 'SAM 3.1' },
  derive: { layer: 'walk', doing: 'measures depth, scale and where to walk', by: 'Depth Anything' },
};
/** The pictures in the order the build lays them on, with what each one says. */
const SHOWN: Array<{ layer: LayerName; title: string; by: string; enter: string }> = [
  { layer: 'blockin', title: 'Plan', by: 'Muse Spark', enter: 'fade' },
  { layer: 'painting', title: 'Painting', by: 'Muse Image', enter: 'wipe' },
  { layer: 'masks', title: 'Things', by: 'SAM 3.1', enter: 'iris' },
  { layer: 'depth', title: 'Depth', by: 'Depth Anything', enter: 'sweep' },
  { layer: 'walk', title: 'Walk grid', by: 'code', enter: 'fade' },
];

const has = (p: StagePlace, l: LayerName) => !!p.layers?.[l];
/** The step working on this place right now whose picture is not out yet, if any. */
export function working(p: StagePlace, live: Live) {
  const step = Object.keys(live.running).find((s) => live.running[s] === 'run' && STEP_LAYER[s]);
  if (!step) return null;
  const { layer } = STEP_LAYER[step];
  const v = p.layers?.[layer]?.v ?? 0;
  return v < (live.since[step] ?? 0) ? { step, ...STEP_LAYER[step] } : null;
}

/** depth.png (rows below the horizon, R high byte, G low byte) as a colour picture: near warm, far cool. */
function DepthLayer({ src, class: cls }: { src: string; class: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const img = new Image();
    img.onload = () => {
      const c = canvas.current;
      if (!c) return;
      [c.width, c.height] = [img.width, img.height];
      const g = c.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, c.width, c.height);
      const d = px.data;
      // Ranked, not scaled: most of a picture sits at a few distances, and the ramp should span them all.
      const n = c.width * c.height;
      const raw = new Uint16Array(n);
      for (let i = 0; i < n; i++) raw[i] = (d[i * 4] << 8) | d[i * 4 + 1];
      const sorted = raw.slice().sort();
      const rank = (v: number) => {
        let [lo, hi] = [0, n];
        while (lo < hi) (sorted[(lo + hi) >> 1] < v ? (lo = ((lo + hi) >> 1) + 1) : (hi = (lo + hi) >> 1));
        return lo / n;
      };
      const ramp = new Map<number, number>();
      for (let i = 0; i < n; i++) {
        // 0 far (deep blue), 1 near (amber): a three-stop ramp.
        const t = ramp.get(raw[i]) ?? (ramp.set(raw[i], rank(raw[i])), ramp.get(raw[i])!);
        const [a, b, u] = t < 0.5 ? [[28, 36, 120], [60, 170, 180], t * 2] : [[60, 170, 180], [255, 196, 90], (t - 0.5) * 2];
        d.set([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u, 255], i * 4);
      }
      g.putImageData(px, 0, 0);
    };
    img.src = src;
  }, [src]);
  return <canvas ref={canvas} class={cls} />;
}

/**
 * The big picture: one place, its pictures stacked in build order, the newest sliding in over the last.
 * While a step works on it, a scan line and the model's name; once built, it turns through its layers.
 */
export function Stage({ slug, place, live, building, hold }: { slug: string; place: StagePlace; live: Live; building: boolean; hold?: { layer: LayerName; at: number } | null }) {
  const shown = SHOWN.filter((s) => has(place, s.layer));
  const newest = shown.at(-1)?.layer ?? null;
  const [pick, setPick] = useState<LayerName | null>(null);
  const [turn, setTurn] = useState(0);
  const [hover, setHover] = useState(false);
  // Built and nobody looking at one layer: show them in turn, painting longest.
  useEffect(() => {
    if (building || pick || hover || shown.length < 3) return;
    const timer = setTimeout(() => setTurn((t) => t + 1), turn % shown.length === 0 ? 5000 : 2600);
    return () => clearTimeout(timer);
  }, [building, pick, hover, shown.length, turn]);
  // A click on the build bar holds the layer its step made, on this place and the next the stage moves to.
  const held = useRef<LayerName | null>(null);
  useEffect(() => void (hold && (held.current = hold.layer, setPick(has(place, hold.layer) ? hold.layer : newest))), [hold?.at]);
  useEffect(() => (setPick(held.current && has(place, held.current) ? held.current : null), setTurn(0)), [place.key]);
  const cycle = ['painting', ...shown.map((s) => s.layer).filter((l) => l !== 'painting' && l !== 'blockin')] as LayerName[];
  const top: LayerName | null = pick ?? (building || shown.length < 3 ? newest : cycle[turn % cycle.length]);
  const upTo = shown.findIndex((s) => s.layer === top);
  const busy = building ? working(place, live) : null;
  const caption = busy ? { by: busy.by, text: `${busy.doing}…` } : top ? { by: SHOWN.find((s) => s.layer === top)!.by, text: SHOWN.find((s) => s.layer === top)!.title } : null;
  const base = place.layers?.painting ?? place.layers?.blockin;
  return (
    <figure class="stage-live" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div class="frame">
        {/* Not painted yet: the place's name and who paints it; what it shows is in the tooltip and the story beside. */}
        {shown.length === 0 && <div class="empty waiting" title={place.shows}><strong>{place.key}</strong><span><ModelTag by="Muse Image" /> {busy ? `${busy.doing}…` : 'paints it next'}</span></div>}
        {/* The depth map needs a painting under it; the rest are whole pictures, each over the one before. */}
        {shown.slice(0, upTo + 1).map((s) => {
          const l = place.layers![s.layer]!;
          const cls = `layer enter-${s.enter}`;
          if (s.layer === 'depth') return [base && <img key={`${s.layer}-base`} class="layer" src={fileUrl(slug, base.file, base.v)} alt="" />, <DepthLayer key={`${s.layer}-${l.v}`} class={`${cls} depth`} src={fileUrl(slug, l.file, l.v)} />];
          return <img key={`${s.layer}-${l.v}`} class={cls} src={fileUrl(slug, l.file, l.v)} alt={`${place.key}: ${s.title}`} />;
        })}
        {/* Cutting out: Spark's boxes for each thing, filled in as SAM returns its mask. Real progress, not a sweep. */}
        {busy?.step === 'masks' && <Finds slug={slug} place={place.key} cut={live.cut[place.key] ?? []} />}
        {busy && <div class={`scan ${busy.step}`} />}
        {caption && (
          <figcaption>
            <ModelTag by={caption.by} />
            <span>{caption.text}</span>
          </figcaption>
        )}
        <span class="where">{place.key}</span>
        {shown.length > 1 && (
          <div class="layers" role="tablist" aria-label="Layers">
            {shown.map((s) => (
              <button type="button" role="tab" aria-selected={top === s.layer} class={`ghost small${top === s.layer ? ' on' : ''}`} title={`${LAYER_TIPS[s.layer] ?? s.title}, by ${s.by}. Click to hold it, again to let the stage cycle`} onClick={() => ((held.current = null), setPick(pick === s.layer ? null : s.layer))}>{s.title}</button>
            ))}
          </div>
        )}
      </div>
    </figure>
  );
}

const LAYER_TIPS: Record<string, string> = {
  blockin: 'Plan: where Spark put every thing, light and floor. Muse paints over this sketch (without the names) and keeps each shape where it stands',
  first: 'The first painting, before the critic\'s fixes',
  painting: 'The painting Muse made',
  masks: 'What SAM cut out: each thing and floor',
  depth: 'Depth: how far away each spot is, as colour',
  walk: 'Where the hero can walk',
};

/** On a failed or unpainted place: why in one line, and a button that rebuilds it from where it broke or asks the agent. */
function FixIt({ slug, place, why }: { slug: string; place: string; why: string }) {
  const [said, setSaid] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fix = async () => {
    setBusy(true);
    try {
      const r = await call<{ did: 'rebuild' | 'agent'; from?: string }>('place_fix', { slug, place });
      setSaid(r.did === 'rebuild' ? `Rebuilding from ${r.from}…` : 'Asked the agent to repair it');
    } catch (error) {
      setSaid(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="fixit">
      <div class="panel">
        <span class="why" title={why}>{said ?? why}</span>
        {!said && <button type="button" class="small" disabled={busy} title="Rebuild this place from the step it broke at (a refused painting is reworded by itself). Steps before it are free; a new painting is 1 Muse Image call. If it was built and still fails, the agent repairs it" onClick={fix}>Fix it</button>}
      </div>
    </div>
  );
}

/** Every place as a small card: its newest picture, how far it got, and what the build is doing to it. */
export function Strip({ slug, places, focus, live, building, repairing, onPick }: { slug: string; places: StagePlace[]; focus: string | null; live: Live; building: boolean; repairing: Record<string, string>; onPick: (key: string) => void }) {
  return (
    <ul class="strip">
      {places.map((p) => {
        const top = [...SHOWN].reverse().find((s) => s.layer !== 'depth' && has(p, s.layer));
        const busy = building ? working(p, live) : null;
        const n = SHOWN.filter((s) => has(p, s.layer)).length;
        return (
          <li class={`${focus === p.key ? 'focus' : ''}${busy ? ' busy' : ''}`}>
            <button type="button" class="card" title={`${p.shows}\n\nOpen this place to look at it and fix it; click again to close`} onClick={() => onPick(p.key)}>
              <span class="thumb">
                {top ? <img src={fileUrl(slug, p.layers![top.layer]!.file, p.layers![top.layer]!.v)} alt={p.shows} loading="lazy" /> : <span class="noimg" title={p.shows}>{busy ? `${busy.by}…` : 'waiting to paint'}</span>}
                {busy && <span class="scan" />}
              </span>
              <span class="name">
                <strong>{p.key}</strong>
                {repairing[p.key] ? <span class="badge run" title={repairing[p.key]}>repairing</span>
                  : p.trouble && !p.verdict ? <span class="badge fail">failed</span>
                  : p.verdict ? <span class={`badge ${p.verdict.ok ? 'ok' : 'fail'}`}>{p.verdict.ok ? 'playable' : `${p.verdict.errors.length} error${p.verdict.errors.length === 1 ? '' : 's'}`}</span>
                  : busy ? <span class="badge run">{busy.by}</span>
                  : <span class="dots" aria-label={`${n} of ${SHOWN.length} layers`}>{SHOWN.map((s) => <i class={has(p, s.layer) ? 'on' : ''} />)}</span>}
              </span>
            </button>
            {p.trouble && !building && !repairing[p.key] && <FixIt key={p.trouble.why} slug={slug} place={p.key} why={p.trouble.why} />}
          </li>
        );
      })}
    </ul>
  );
}

type Story = { intro: string; items: { key: string; name: string }[]; endings: { key: string; title: string }[]; dialogues: { npc: string }[] } | null;
type StoryStatus = { hero: string; story: Story; places: { key: string; shows: string }[] };
type Item = { key: string; name?: string; icon?: { file: string; v?: number | null } | null };
type Character = { key: string; figure?: { file: string; v?: number | null } | null };

/** The story as it is written: the idea, the hero, each place, then the intro, what to find and how it can end. */
export function Tale({ slug, version, pitch, hero, places }: { slug: string; version: number; pitch: string | null; hero?: string; places: StagePlace[] }) {
  const [story, setStory] = useState<StoryStatus | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [cast, setCast] = useState<Character[]>([]);
  useEffect(() => {
    if (!places.length) return;
    call<StoryStatus>('story_status', { slug }).then(setStory).catch(() => {});
    call<Item[]>('icons_status', { slug }).then(setItems).catch(() => {});
    call<Character[]>('cast_status', { slug }).then(setCast).catch(() => {});
  }, [slug, version, places.length]);
  const s = story?.story;
  const icon = (key: string) => items.find((i) => i.key === key)?.icon;
  const face = (key: string) => cast.find((c) => c.key === key)?.figure;
  const people = [...new Set([story?.hero ?? hero, ...(s?.dialogues.map((d) => d.npc) ?? [])].filter((k): k is string => !!k))];
  return (
    <aside class="tale" aria-live="polite">
      <p class="kicker"><ModelTag by="Muse Spark" /> writes the world</p>
      {!places.length && <p class="pitch">{pitch ?? 'The idea becomes places, a hero and a story…'}</p>}
      {people.length > 0 && (
        <ul class="people">
          {people.map((k) => {
            const pic = face(k);
            return <li key={k}>{pic ? <img src={fileUrl(slug, pic.file, pic.v)} alt="" /> : <span class="noface">{k[0]}</span>}<span>{k}</span></li>;
          })}
        </ul>
      )}
      {places.length > 0 && <ol class="where-list">{places.map((p) => <li key={p.key}><strong>{p.key}</strong> {p.shows}</li>)}</ol>}
      {s?.intro && <blockquote>{s.intro}</blockquote>}
      {s && s.items.length > 0 && (
        <ul class="finds">
          {s.items.map((i) => {
            const pic = icon(i.key);
            return <li key={i.key}>{pic ? <img src={fileUrl(slug, pic.file, pic.v)} alt="" /> : <span class="noicon" />}<span>{i.name}</span></li>;
          })}
        </ul>
      )}
      {s && s.endings.length > 0 && <p class="endings">{s.endings.length === 1 ? 'Ending' : `${s.endings.length} endings`}: {s.endings.map((e) => e.title).join(' · ')}</p>}
    </aside>
  );
}

export type FeedItem = { id: number; by: string | null; text: string; at: number };

/** Ideas for the agent once a world plays: one click asks it. */
const NEXT = (place?: string) => [
  'Make it night, with warm lanterns',
  'Add gentle rain and puddles',
  place ? `Add a friendly animal in ${place}` : 'Add a friendly animal',
  'Add one more place to explore',
];

/**
 * The agent's side while a build runs: what each model does right now, newest first; when the world plays, a few
 * things to ask the agent next. The chat stays below, one click away.
 */
export function Crew({ feed, building, playable, place, onAsk, onClose }: { feed: FeedItem[]; building: boolean; playable: boolean; place?: string; onAsk: (text: string) => void; onClose: () => void }) {
  const ideas = NEXT(place);
  return (
    <section class={`crew${building ? ' live' : ''}`} aria-live="polite">
      <div class="row">
        <strong>{building ? 'Building now' : 'Try next'}</strong>
        <span class="grow" />
        {!building && <button type="button" class="ghost tiny" aria-label="Hide" title="Hide until the next build" onClick={onClose}>✕</button>}
      </div>
      {building && (
        <ol class="feed">
          {feed.length === 0 && <li class="detail">Starting…</li>}
          {feed.slice(0, 9).map((f) => <li key={f.id} class={f.by ? 'call' : 'step'}>{f.by ? <ModelTag by={f.by} /> : <span class="ok">✓</span>}<span>{f.text}</span></li>)}
        </ol>
      )}
      <p class="detail">{building ? 'When it is done, ask the agent:' : 'Ask the agent, one click:'}</p>
      <div class="ideas">
        {ideas.map((t) => <button type="button" class="ghost small" disabled={building || !playable} title={building ? 'After the build' : 'Sends this to the agent below'} onClick={() => onAsk(t)}>{t}</button>)}
      </div>
    </section>
  );
}

type Located = { things?: Record<string, { box?: [number, number, number, number]; phrase?: string }> };

/** The things Muse Spark located on a painting, as boxes; each turns solid when SAM 3.1 has cut it out. */
function Finds({ slug, place, cut }: { slug: string; place: string; cut: string[] }) {
  const [found, setFound] = useState<Located | null>(null);
  // locate.json is written once Spark has looked; asked again as SAM answers, until it is there.
  useEffect(() => {
    if (found?.things) return;
    fetch(fileUrl(slug, `places/${place}/locate.json`, Date.now()), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j) => j && setFound(j as Located)).catch(() => {});
  }, [slug, place, cut.length]);
  useEffect(() => setFound(null), [place]);
  const things = Object.entries(found?.things ?? {}).filter(([, t]) => t.box);
  if (!things.length) return null;
  return (
    <svg class="finds" viewBox="0 0 1200 896" preserveAspectRatio="none" aria-label={`${cut.length} of ${things.length} things cut out`}>
      {things.map(([key, t], i) => {
        const [x0, y0, x1, y1] = t.box!;
        const done = cut.includes(key);
        return (
          <g key={key} class={done ? 'cut' : 'look'} style={{ animationDelay: `${i * 0.08}s` }}>
            <rect x={x0 + 3} y={y0 + 3} width={Math.max(0, x1 - x0 - 6)} height={Math.max(0, y1 - y0 - 6)} rx="10" />
            <text x={x0 + 14} y={y0 + 34}>{done ? '✓ ' : ''}{key}</text>
          </g>
        );
      })}
    </svg>
  );
}
