// The story at a glance: places as a map joined by their exits, locked exits marked, endings on the right,
// and the checker's verdict with a shortest route to each ending. Pick a place to read and reword what
// happens there; anything that changes what the player can do is asked of the agent (story_redo).
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { askAgent, call } from './api.ts';

type Effect = Record<string, string>;
type Interaction = { place: string; thing: string; verb: string; with?: string; when: string[]; say: string; do: Effect[]; once: boolean };
type Choice = { text: string; when: string[]; do: Effect[]; next?: string };
type Dialogue = { npc: string; place: string; when: string[]; start: string; lines: { key: string; says: string; choices: Choice[] }[] };
type Story = {
  intro: string;
  items: { key: string; name: string }[];
  locks: { place: string; via: string; until: string[]; say: string }[];
  interactions: Interaction[];
  dialogues: Dialogue[];
  changes: { place: string; thing: string; when: string[]; looks: string }[];
  endings: { key: string; title: string; text: string }[];
};
type Place = { key: string; shows: string; exits: { to: string; via: string }[]; things: { key: string; role: string }[] };
type Status = {
  start: string; hero: string; places: Place[]; story: Story | null;
  fixes: { wish?: string; texts: Record<string, { text: string; at: string }> };
  issues: string[]; states: number; routes: { ending: string; steps: string[] }[];
  long: string[]; unanswerable?: string[]; unseen?: string[]; unvoiced: string[]; unpainted: number[];
};

/** Word limits the designer keeps to (src/story/check.ts BREVITY); shown, never enforced, on hand edits. */
const LIMIT = { intro: 30, say: 14, says: 20, choice: 8, ending: 25 } as const;
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

const fact = (f: string) => f.replace(/^!has:(.*)/, 'without $1').replace(/^has:(.*)/, 'has $1').replace(/^at:(.*)/, 'at $1').replace(/^!(.*)/, 'not $1');
const effect = (e: Effect) => Object.entries(e).map(([k, v]) => (k === 'go' ? `go to ${v}` : k === 'ending' ? `ends: ${v}` : `${k} ${v}`)).join(' ');

/** One thing the story step did while writing: a draft from the model, or what the checker found in it. */
export type StoryProgress = { at: number; text: string; kind: 'call' | 'check'; by?: string };
type Writing = { since?: number; log: StoryProgress[] };

export function StoryView({ slug, version, onError, writing }: { slug: string; version: number; onError: (m: string) => void; writing?: Writing }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [asked, setAsked] = useState(false);
  useEffect(() => setAsked(false), [slug]);
  const load = () => call<Status>('story_status', { slug }).then(setStatus).catch((e) => onError(e.message));
  useEffect(() => void load(), [slug, version]);
  if (!status) return <p class="detail">Reading the story…</p>;
  const { story } = status;
  if (!story) return <PlanOnly status={status} writing={writing} />;
  const save = (path: string, text: string) => call('story_text', { slug, path, text }).then(load).catch((e) => onError(e.message));
  const ask = async (step: 'voices' | 'plates') => {
    if (asking) return;
    setAsking(true);
    setAsked(false);
    try {
      await askAgent(slug,
        `Review the story's missing ${step === 'voices' ? 'spoken audio' : 'painted changes'}. Read story_status to check what is currently missing, explain the scope and estimated generation cost (say if the cost is unknown), and ask me to confirm before making any paid generation calls. This request is for review only; do not run generation yet.`,
        step === 'voices' ? 'Review missing story voices and cost' : 'Review missing story paintings and cost');
      setAsked(true);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setAsking(false);
    }
  };
  const place = status.places.find((p) => p.key === pick);
  const ending = story.endings.find((e) => `ending:${e.key}` === pick);
  return (
    <div class="story">
      {writing && <Writing writing={writing} again />}
      <Verdict status={status} onAsk={ask} asking={asking} onFirst={() => call('story_redo', { slug }).catch((e) => onError(e.message))} />
      {asked && <p class="detail" role="status">Sent to the agent. Review the scope and cost in the conversation before approving generation.</p>}
      <StoryMap key={slug} status={status} story={story} pick={pick} onPick={(k) => setPick(pick === k ? null : k)} />
      {place
        ? <PlaceStory place={place} story={story} hero={status.hero} unpainted={status.unpainted} onSave={save} />
        : ending
          ? <EndingStory story={story} ending={ending.key} route={status.routes.find((r) => r.ending === ending.key)?.steps ?? null} onSave={save} />
          : <Overview story={story} onSave={save} />}
    </div>
  );
}

/**
 * Before the story step has written story.json, the places step has already planned the world:
 * show that plan (what the story will be written over) rather than an empty page.
 */
function PlanOnly({ status, writing }: { status: Status; writing?: Writing }) {
  return (
    <div class="story plan-only">
      {writing
        ? <Writing writing={writing} />
        : <p class="detail">The story is not written yet: the story step of the build writes it over this plan. It shows here when done.</p>}
      <p class="detail">Hero: <strong>{status.hero}</strong> · starts in <strong>{status.start}</strong></p>
      <ul class="plan-places">
        {status.places.map((p) => (
          <li>
            <strong>{p.key}</strong>
            <span>{p.shows}</span>
            {!!p.things.length && <span class="detail">Things: {p.things.map((t) => t.key).join(', ')}</span>}
            {!!p.exits.length && <span class="detail">Exits: {p.exits.map((e) => `${e.to} (${e.via})`).join(', ')}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The story step at work: a draft, the checker plays every state and lists what breaks, the next draft fixes it
 * (up to 4), then a dialogue review. Each of those lands here as it happens, with the step's own clock.
 */
function Writing({ writing, again }: { writing: Writing; again?: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = writing.since ? Math.max(0, Math.round((now - writing.since) / 1000)) : null;
  const drafts = writing.log.filter((l) => l.kind === 'call' && l.text.startsWith('draft')).length;
  const doing = writing.log.at(-1)?.kind === 'call' && drafts ? (writing.log.at(-1)!.text.startsWith('draft') ? 'the checker plays it through' : 'deciding') : drafts ? `writing draft ${drafts + 1} of up to 4` : 'writing the first draft';
  return (
    <section class="story-writing" role="status" aria-live="polite">
      <strong>{again ? 'Rewriting the story' : 'Writing the story'}{secs !== null ? ` · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : ''}</strong>
      <span class="detail">Now: {doing}. Each draft is played through every state by a checker; what breaks goes back for the next draft (up to 4), then the dialogue is reviewed.{again ? ' Below: the story as it was until the new one is ready.' : ''}</span>
      {!!writing.log.length && <ol class="story-log">{writing.log.map((l) => <li class={l.kind}>{l.by ? `${l.by}: ` : 'checker: '}{l.text}</li>)}</ol>}
    </section>
  );
}

function Verdict({ status, onAsk, asking, onFirst }: { status: Status; onAsk: (step: 'voices' | 'plates') => void; asking: boolean; onFirst: () => void }) {
  const ok = status.issues.length === 0;
  return (
    <section class="verdict">
      <div class="row">
        <span class={`badge ${ok ? 'ok' : 'fail'}`}>{ok ? 'winnable' : `${status.issues.length} problem${status.issues.length === 1 ? '' : 's'}`}</span>
        <span class="detail">{status.states.toLocaleString()} states played · {status.routes.map((r) => `${r.ending} in ${r.steps.length} clicks`).join(' · ')}</span>
      </div>
      {status.fixes.wish && (
        <div class="row">
          <span class="detail">Rewritten by the agent to your wish: “{status.fixes.wish}”</span>
          <span class="grow" />
          <button type="button" class="ghost small" title="Drop the wish and go back to Spark's first story (kept, so free). Reworded lines go too" onClick={onFirst}>Back to the first story</button>
        </div>
      )}
      {!ok && <ul class="issues">{status.issues.map((i) => <li>{i}</li>)}</ul>}
      {(status.unvoiced.length > 0 || status.unpainted.length > 0) && (
        <div class="row">
          {status.unvoiced.length > 0 && <button type="button" class="ghost small" disabled={asking} title={`Ask the agent to review missing voices and cost before you approve generation:\n${status.unvoiced.join('\n')}`} onClick={() => onAsk('voices')}>Ask agent about {status.unvoiced.length} missing voice{status.unvoiced.length === 1 ? '' : 's'}</button>}
          {status.unpainted.length > 0 && <button type="button" class="ghost small" disabled={asking} title="Ask the agent to review missing paintings and cost before you approve generation" onClick={() => onAsk('plates')}>Ask agent about {status.unpainted.length} unpainted change{status.unpainted.length === 1 ? '' : 's'}</button>}
        </div>
      )}
      {(status.unseen?.length ?? 0) > 0 && <details open><summary class="detail">{status.unseen!.length} part{status.unseen!.length === 1 ? '' : 's'} of the story the painting will not show (ask the agent to redo)</summary><ul class="issues">{status.unseen!.map((l) => <li>{l}</li>)}</ul></details>}
      {(status.unanswerable?.length ?? 0) > 0 && <details open><summary class="detail">{status.unanswerable!.length} question{status.unanswerable!.length === 1 ? '' : 's'} the player cannot answer (ask the agent to reword)</summary><ul class="issues">{status.unanswerable!.map((l) => <li>{l}</li>)}</ul></details>}
      {status.long.length > 0 && <details><summary class="detail">{status.long.length} line{status.long.length === 1 ? ' is' : 's are'} over the word limit</summary><ul class="issues">{status.long.map((l) => <li>{l}</li>)}</ul></details>}
    </section>
  );
}

const COL = 280;
const ROW = 100;
const NODE = { w: 210, h: 72 };

/** Keep labels at reading size; a neighbourhood can be laid out independently of the whole world. */
export function StoryMap({ status, story, pick, onPick }: { status: Status; story: Story; pick: string | null; onPick: (key: string) => void }) {
  const [zoom, setZoom] = useState(1);
  const [nearby, setNearby] = useState(false);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => { if (!pick) setNearby(false); }, [pick]);
  const graph = useMemo(() => {
    const keys = new Set(status.places.map((p) => p.key));
    const joins: { a: string; b: string; locked: string[]; ending?: boolean }[] = [];
    for (const p of status.places) for (const e of p.exits) {
      if (!keys.has(e.to)) continue;
      const lock = story.locks.find((l) => l.place === p.key && l.via === e.via);
      const known = joins.find((j) => (j.a === e.to && j.b === p.key) || (j.a === p.key && j.b === e.to));
      const conditions = lock ? [`${p.key} → ${e.to}: ${lock.until.map(fact).join(', ')}`] : [];
      if (known) known.locked.push(...conditions);
      else joins.push({ a: p.key, b: e.to, locked: conditions });
    }
    const addEnding = (from: string, end: string) => {
      const to = `ending:${end}`;
      if (keys.has(from) && story.endings.some((e) => e.key === end) && !joins.some((j) => j.a === from && j.b === to)) {
        joins.push({ a: from, b: to, locked: [], ending: true });
      }
    };
    for (const it of story.interactions) for (const d of it.do) if (d.ending) addEnding(it.place, d.ending);
    for (const dl of story.dialogues) for (const l of dl.lines) for (const c of l.choices) for (const d of c.do) if (d.ending) addEnding(dl.place, d.ending);
    return joins;
  }, [status, story]);
  const layout = useMemo(() => {
    const visible = nearby && pick ? new Set([pick, ...graph.filter((j) => j.a === pick || j.b === pick).flatMap((j) => [j.a, j.b])]) : null;
    const places = status.places.filter((p) => !visible || visible.has(p.key));
    const endings = story.endings.filter((e) => !visible || visible.has(`ending:${e.key}`));
    const depth = new Map<string, number>([[status.start, 0]]);
    const queue = [status.start];
    for (let i = 0; i < queue.length; i++) {
      const at = queue[i];
      for (const e of status.places.find((p) => p.key === at)?.exits ?? []) if (!depth.has(e.to)) { depth.set(e.to, depth.get(at)! + 1); queue.push(e.to); }
    }
    const last = Math.max(0, ...depth.values());
    // Disconnected places share a column instead of making the map ever wider.
    for (const p of status.places) if (!depth.has(p.key)) depth.set(p.key, last + 1);
    const columns = [...new Set(places.map((p) => depth.get(p.key)!))].sort((a, b) => a - b);
    const rows = new Map<number, number>();
    const pos = new Map<string, { x: number; y: number }>();
    for (const p of places) {
      const col = columns.indexOf(depth.get(p.key)!);
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      pos.set(p.key, { x: 24 + col * COL, y: 24 + row * ROW });
    }
    endings.forEach((e, i) => pos.set(`ending:${e.key}`, { x: 24 + columns.length * COL, y: 24 + i * ROW }));
    const base = 24 + Math.max(1, endings.length, ...rows.values()) * ROW;
    let lane = 0;
    const joins = graph.filter((j) => pos.has(j.a) && pos.has(j.b)).map((j) => {
      let a = pos.get(j.a)!, b = pos.get(j.b)!;
      if (a.x > b.x) [a, b] = [b, a];
      const ay = a.y + NODE.h / 2, by = b.y + NODE.h / 2;
      let path: string, x: number, y: number;
      if (b.x - a.x === COL) {
        x = (a.x + NODE.w + b.x) / 2; y = (ay + by) / 2;
        path = `M${a.x + NODE.w} ${ay} C${x} ${ay},${x} ${by},${b.x} ${by}`;
      } else {
        // Route same-column, looping and skipping edges through gutters, never through cards.
        y = base + lane++ * 24; x = (a.x + NODE.w + b.x + NODE.w) / 2 + 18;
        path = `M${a.x + NODE.w} ${ay} H${a.x + NODE.w + 18} V${y} H${b.x + NODE.w + 30} V${by} H${b.x + NODE.w}`;
      }
      return { ...j, path, x, y };
    });
    return { places, endings, pos, joins, width: Math.max(1, columns.length + (endings.length ? 1 : 0)) * COL + 24, height: base + lane * 24 + 12 };
  }, [status, story, graph, nearby, pick]);
  useEffect(() => {
    const at = pick && layout.pos.get(pick);
    if (at && viewport.current) viewport.current.scrollTo({ left: Math.max(0, (at.x + NODE.w / 2) * zoom - viewport.current.clientWidth / 2), top: Math.max(0, (at.y + NODE.h / 2) * zoom - viewport.current.clientHeight / 2) });
  }, [pick, nearby, zoom, layout]);
  const related = new Set(pick ? [pick, ...graph.filter((j) => j.a === pick || j.b === pick).flatMap((j) => [j.a, j.b])] : []);
  const nodes = [
    ...layout.places.map((p) => {
      const npcs = p.things.filter((t) => t.role === 'npc');
      const items = p.things.filter((t) => t.role === 'item');
      return { key: p.key, title: p.key, sub: [p.key === status.start && 'start', npcs.length && `${npcs.length} character${npcs.length === 1 ? '' : 's'}`, items.length && `${items.length} item${items.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'no characters or items', detail: npcs.map((t) => t.key).join(', '), ending: false };
    }),
    ...layout.endings.map((e) => ({ key: `ending:${e.key}`, title: e.title, sub: 'ending', detail: '', ending: true })),
  ];
  return (
    <section class="story-map" aria-label="Places, exits and endings">
      <div class="row map-tools">
        <label>Find a place or ending <select value={pick ?? ''} onChange={(e) => onPick(e.currentTarget.value)}>
          <option value="" disabled>Choose…</option>
          {status.places.map((p) => <option key={p.key} value={p.key}>{p.key}</option>)}
          {story.endings.map((e) => <option key={e.key} value={`ending:${e.key}`}>{e.title} · ending</option>)}
        </select></label>
        <button type="button" class="small" disabled={!pick} aria-pressed={nearby} onClick={() => setNearby(!nearby)}>{nearby ? 'Show whole map' : 'Show neighbourhood'}</button>
        <span class="grow" />
        <button type="button" class="small" aria-label="Zoom out" disabled={zoom <= 0.25} onClick={() => setZoom(Math.max(0.25, zoom - 0.25))}>−</button>
        <button type="button" class="small" title="Reset to reading size" onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" class="small" aria-label="Zoom in" disabled={zoom >= 2} onClick={() => setZoom(Math.min(2, zoom + 0.25))}>+</button>
        <button type="button" class="small" onClick={() => setZoom(Math.min(1, (viewport.current?.clientWidth ?? layout.width) / layout.width, (viewport.current?.clientHeight ?? layout.height) / layout.height))}>Fit map</button>
      </div>
      <div class="map" ref={viewport} tabIndex={0} role="region" aria-label="Scrollable story map">
        <svg width={layout.width * zoom} height={layout.height * zoom} viewBox={`0 0 ${layout.width} ${layout.height}`}>
          {layout.joins.map((j) => (
            <g key={`${j.a}>${j.b}`} class={`join ${j.locked.length ? 'locked' : ''} ${j.ending ? 'to-end' : ''} ${pick && j.a !== pick && j.b !== pick ? 'dim' : ''}`}>
              <title>{j.locked.length ? j.locked.join('\n') : `${j.a} — ${j.b}`}</title>
              <path d={j.path} />
              {j.locked.length > 0 && <g class="lock-label"><rect x={j.x - 24} y={j.y - 10} width="48" height="20" rx="10" /><text x={j.x} y={j.y + 4} text-anchor="middle">locked</text></g>}
            </g>
          ))}
          {nodes.map((n) => {
            const at = layout.pos.get(n.key)!;
            return (
              <g key={n.key} class={`node ${n.ending ? 'ending' : ''} ${pick === n.key ? 'on' : ''} ${n.key === status.start ? 'start' : ''} ${pick && !related.has(n.key) ? 'dim' : ''}`} transform={`translate(${at.x} ${at.y})`} tabIndex={0} role="button" aria-label={`${n.ending ? 'Ending' : 'Place'} ${n.title}`} aria-pressed={pick === n.key}
                onClick={() => onPick(n.key)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(n.key))}>
                <title>{[n.title, n.sub, n.detail].filter(Boolean).join('\n')}</title>
                <rect width={NODE.w} height={NODE.h} rx={n.ending ? 28 : 10} />
                <foreignObject x="14" y="12" width={NODE.w - 28} height={NODE.h - 20}>
                  <div class="map-name">{n.title}</div><div class="map-sub">{n.sub}</div>
                </foreignObject>
              </g>
            );
          })}
        </svg>
      </div>
      <p class="detail map-help">{layout.places.length} of {status.places.length} places · {layout.endings.length} endings. Select a place for its lines and lock conditions. Dotted lines lead to endings.</p>
    </section>
  );
}

/** A line of the story, saved when it loses focus; the word count shows once it runs over the limit. */
function Text({ path, value, limit, onSave, label }: { path: string; value: string; limit?: number; onSave: (path: string, text: string) => void; label: string }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const n = words(text);
  return (
    <span class="line">
      <textarea id={`story-${path}`} rows={Math.min(4, Math.max(1, Math.ceil(text.length / 70)))} value={text} aria-label={label} title="Reword it here; saved when you click away. Free (a spoken line needs speaking again)"
        onInput={(e) => setText(e.currentTarget.value)}
        onBlur={() => text.trim() && text.trim() !== value && onSave(path, text.trim())} />
      {limit !== undefined && n > limit && <span class="over">{n} words, keep to {limit}</span>}
    </span>
  );
}

const Facts = ({ when, lead = 'if' }: { when: string[]; lead?: string }) => (when.length ? <span class="facts">{lead} {when.map(fact).join(', ')}</span> : null);
const Effects = ({ effects }: { effects: Effect[] }) => (effects.length ? <span class="effects">→ {effects.map(effect).join(', ')}</span> : null);

function PlaceStory({ place, story, hero, unpainted, onSave }: { place: Place; story: Story; hero: string; unpainted: number[]; onSave: (path: string, text: string) => void }) {
  const locks = story.locks.map((l, i) => ({ ...l, i })).filter((l) => l.place === place.key);
  const acts = story.interactions.map((it, i) => ({ ...it, i })).filter((it) => it.place === place.key);
  const talks = story.dialogues.map((d, i) => ({ ...d, i })).filter((d) => d.place === place.key);
  const changes = story.changes.map((c, i) => ({ ...c, i })).filter((c) => c.place === place.key);
  const byThing = [...new Set(acts.map((a) => a.thing))];
  return (
    <section class="inspect story-place">
      <h2>{place.key}</h2>
      <p class="detail">{place.shows}</p>
      {locks.map((l) => (
        <div class="beat">
          <div class="row"><strong>{l.via}</strong><span class="badge">locked</span><Facts when={l.until} lead="opens when" /></div>
          <Text path={`locks.${l.i}.say`} value={l.say} limit={LIMIT.say} onSave={onSave} label={`What ${hero} says at the locked ${l.via}`} />
        </div>
      ))}
      {byThing.map((thing) => (
        <div class="beat">
          <strong>{thing}</strong>
          {acts.filter((a) => a.thing === thing).map((a) => (
            <div class="act">
              <div class="row"><span class="verb">{a.verb}{a.with ? ` with ${a.with}` : ''}</span><Facts when={a.when} />{a.once && <span class="detail">once</span>}<Effects effects={a.do} /></div>
              <Text path={`interactions.${a.i}.say`} value={a.say} limit={LIMIT.say} onSave={onSave} label={`What ${hero} says on ${a.verb} ${thing}`} />
            </div>
          ))}
        </div>
      ))}
      {talks.map((d) => (
        <div class="beat talk">
          <div class="row"><strong>Talking to {d.npc}</strong><Facts when={d.when} /></div>
          {d.lines.map((l, li) => (
            <div class={`act ${l.key === d.start ? 'first' : ''}`}>
              <span class="verb">{l.key}{l.key === d.start ? ' · first' : ''}</span>
              <Text path={`dialogues.${d.i}.lines.${li}.says`} value={l.says} limit={LIMIT.says} onSave={onSave} label={`${d.npc} says (${l.key})`} />
              <ul class="choices">
                {l.choices.map((c, ci) => (
                  <li>
                    <Text path={`dialogues.${d.i}.lines.${li}.choices.${ci}.text`} value={c.text} limit={LIMIT.choice} onSave={onSave} label={`${hero} answers`} />
                    <span class="row"><Facts when={c.when} /><Effects effects={c.do} /><span class="detail">{c.next ? `then ${c.next}` : 'ends the talk'}</span></span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ))}
      {changes.map((c) => (
        <div class="beat">
          <div class="row"><strong>{c.thing} changes</strong><Facts when={c.when} />{unpainted.includes(c.i) && <span class="badge">not painted yet</span>}</div>
          <Text path={`changes.${c.i}.looks`} value={c.looks} onSave={onSave} label={`How ${c.thing} looks once changed`} />
        </div>
      ))}
      {!locks.length && !acts.length && !talks.length && !changes.length && <p class="detail">Nothing happens here: it is a place to pass through.</p>}
    </section>
  );
}

function EndingStory({ story, ending, route, onSave }: { story: Story; ending: string; route: string[] | null; onSave: (path: string, text: string) => void }) {
  const i = story.endings.findIndex((e) => e.key === ending);
  const e = story.endings[i];
  return (
    <section class="inspect story-place">
      <h2>{e.title}</h2>
      <Text path={`endings.${i}.title`} value={e.title} onSave={onSave} label="Ending title" />
      <Text path={`endings.${i}.text`} value={e.text} limit={LIMIT.ending} onSave={onSave} label="What the narrator says at the end" />
      {route ? <><p class="detail">Shortest way there, {route.length} clicks:</p><ol class="route">{route.map((s) => <li>{s}</li>)}</ol></> : <p class="error">No way to reach it.</p>}
    </section>
  );
}

function Overview({ story, onSave }: { story: Story; onSave: (path: string, text: string) => void }) {
  return (
    <section class="inspect story-place">
      <h2>Opening</h2>
      <Text path="intro" value={story.intro} limit={LIMIT.intro} onSave={onSave} label="The intro the narrator reads" />
      {story.items.length > 0 && <>
        <strong>Items</strong>
        <ul class="items">{story.items.map((it, i) => <li><span class="verb">{it.key}</span><Text path={`items.${i}.name`} value={it.name} onSave={onSave} label={`Name of ${it.key}`} /></li>)}</ul>
      </>}
      <p class="detail">Pick a place or an ending on the map to read and reword what happens there. To change what happens (a puzzle, a lock, an ending), ask the agent in the panel: it rewrites the story and the checker plays it through.</p>
    </section>
  );
}
