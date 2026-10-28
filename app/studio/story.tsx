// The story at a glance: places as a map joined by their exits, locked exits marked, endings on the right,
// and the checker's verdict with a shortest route to each ending. Pick a place to read and reword what
// happens there; anything that changes what the player can do is asked of the agent (story_redo).
import { useEffect, useMemo, useState } from 'preact/hooks';
import { call } from './api.ts';

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

export function StoryView({ slug, version, onError }: { slug: string; version: number; onError: (m: string) => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const load = () => call<Status>('story_status', { slug }).then(setStatus).catch((e) => onError(e.message));
  useEffect(() => void load(), [slug, version]);
  if (!status) return <p class="detail">Reading the story…</p>;
  const { story } = status;
  if (!story) return <p class="detail">No story yet: it is written by the story step of the build.</p>;
  const save = (path: string, text: string) => call('story_text', { slug, path, text }).then(load).catch((e) => onError(e.message));
  const step = (name: string) => call('run_step', { slug, step: name }).catch((e) => onError(e.message));
  const place = status.places.find((p) => p.key === pick);
  const ending = story.endings.find((e) => `ending:${e.key}` === pick);
  return (
    <div class="story">
      <Verdict status={status} onStep={step} onFirst={() => call('story_redo', { slug }).catch((e) => onError(e.message))} />
      <StoryMap status={status} story={story} pick={pick} onPick={(k) => setPick(pick === k ? null : k)} />
      {place
        ? <PlaceStory place={place} story={story} hero={status.hero} unpainted={status.unpainted} onSave={save} />
        : ending
          ? <EndingStory story={story} ending={ending.key} route={status.routes.find((r) => r.ending === ending.key)?.steps ?? null} onSave={save} />
          : <Overview story={story} onSave={save} />}
    </div>
  );
}

function Verdict({ status, onStep, onFirst }: { status: Status; onStep: (step: string) => void; onFirst: () => void }) {
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
          {status.unvoiced.length > 0 && <button type="button" class="ghost small" title={`ElevenLabs speaks the new lines, 1 call each:\n${status.unvoiced.join('\n')}`} onClick={() => onStep('voices')}>Speak {status.unvoiced.length} new line{status.unvoiced.length === 1 ? '' : 's'}</button>}
          {status.unpainted.length > 0 && <button type="button" class="ghost small" title={`Muse paints how each changed thing looks after it changes. ${status.unpainted.length} Muse Image edit${status.unpainted.length === 1 ? '' : 's'}`} onClick={() => onStep('plates')}>Paint {status.unpainted.length} change{status.unpainted.length === 1 ? '' : 's'}</button>}
        </div>
      )}
      {(status.unseen?.length ?? 0) > 0 && <details open><summary class="detail">{status.unseen!.length} part{status.unseen!.length === 1 ? '' : 's'} of the story the painting will not show (ask the agent to redo)</summary><ul class="issues">{status.unseen!.map((l) => <li>{l}</li>)}</ul></details>}
      {(status.unanswerable?.length ?? 0) > 0 && <details open><summary class="detail">{status.unanswerable!.length} question{status.unanswerable!.length === 1 ? '' : 's'} the player cannot answer (ask the agent to reword)</summary><ul class="issues">{status.unanswerable!.map((l) => <li>{l}</li>)}</ul></details>}
      {status.long.length > 0 && <details><summary class="detail">{status.long.length} line{status.long.length === 1 ? ' is' : 's are'} over the word limit</summary><ul class="issues">{status.long.map((l) => <li>{l}</li>)}</ul></details>}
    </section>
  );
}

const COL = 300;
const ROW = 84;
const NODE = { w: 170, h: 58 };

/** Columns by distance from the start through exits; endings in a last column, joined to where they fire. */
function StoryMap({ status, story, pick, onPick }: { status: Status; story: Story; pick: string | null; onPick: (key: string) => void }) {
  const layout = useMemo(() => {
    const depth = new Map<string, number>([[status.start, 0]]);
    const queue = [status.start];
    while (queue.length) {
      const at = queue.shift()!;
      for (const e of status.places.find((p) => p.key === at)?.exits ?? []) if (!depth.has(e.to)) { depth.set(e.to, depth.get(at)! + 1); queue.push(e.to); }
    }
    let last = Math.max(0, ...depth.values());
    for (const p of status.places) if (!depth.has(p.key)) depth.set(p.key, ++last);
    const rows = new Map<number, number>();
    const pos = new Map<string, { x: number; y: number }>();
    for (const p of status.places) {
      const col = depth.get(p.key)!;
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      pos.set(p.key, { x: 12 + col * COL, y: 12 + row * ROW });
    }
    const endCol = last + 1;
    story.endings.forEach((e, i) => pos.set(`ending:${e.key}`, { x: 12 + endCol * COL, y: 12 + i * ROW }));
    const height = 12 + Math.max(story.endings.length, ...rows.values()) * ROW;
    // One line per pair of places; locked if a lock sits on either side's exit.
    const joins: { a: string; b: string; locked: string[] }[] = [];
    for (const p of status.places) for (const e of p.exits) {
      const lock = story.locks.find((l) => l.place === p.key && l.via === e.via);
      const known = joins.find((j) => (j.a === e.to && j.b === p.key) || (j.a === p.key && j.b === e.to));
      if (known) { if (lock) known.locked.push(lock.until.map(fact).join(', ')); }
      else joins.push({ a: p.key, b: e.to, locked: lock ? [lock.until.map(fact).join(', ')] : [] });
    }
    const ends = new Set<string>();
    for (const it of story.interactions) for (const d of it.do) if (d.ending) ends.add(`${it.place}>${d.ending}`);
    for (const dl of story.dialogues) for (const l of dl.lines) for (const c of l.choices) for (const d of c.do) if (d.ending) ends.add(`${dl.place}>${d.ending}`);
    return { pos, joins, ends: [...ends].map((s) => s.split('>')), width: 12 + (endCol + 1) * COL - (COL - NODE.w), height };
  }, [status, story]);
  const mid = (k: string) => { const p = layout.pos.get(k)!; return { x: p.x + NODE.w / 2, y: p.y + NODE.h / 2 }; };
  const things = (p: Place, role: string) => p.things.filter((t) => t.role === role).map((t) => t.key);
  return (
    <div class="map" role="group" aria-label="Places, exits and endings">
      <svg style={`width:100%;max-width:${layout.width}px;min-width:${Math.round(layout.width * 0.6)}px;height:auto`} viewBox={`0 0 ${layout.width} ${layout.height}`}>
        {layout.joins.map((j) => {
          const a = mid(j.a);
          const b = mid(j.b);
          return (
            <g class={`join ${j.locked.length ? 'locked' : ''}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              {j.locked.length > 0 && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 6} text-anchor="middle">until {j.locked.join(' / ')}</text>}
            </g>
          );
        })}
        {layout.ends.map(([from, end]) => {
          const a = mid(from);
          const b = layout.pos.get(`ending:${end}`)!;
          return <path class="to-end" d={`M${a.x + NODE.w / 2} ${a.y} C ${a.x + NODE.w / 2 + 40} ${a.y}, ${b.x - 40} ${b.y + NODE.h / 2}, ${b.x} ${b.y + NODE.h / 2}`} />;
        })}
        {status.places.map((p) => {
          const at = layout.pos.get(p.key)!;
          const npcs = things(p, 'npc');
          const items = things(p, 'item');
          return (
            <g class={`node ${pick === p.key ? 'on' : ''} ${p.key === status.start ? 'start' : ''}`} transform={`translate(${at.x} ${at.y})`} tabIndex={0} role="button" aria-label={`Place ${p.key}`} title="See this place's lines"
              onClick={() => onPick(p.key)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onPick(p.key))}>
              <rect width={NODE.w} height={NODE.h} rx="10" />
              <text x="12" y="22" class="name">{p.key}{p.key === status.start ? ' · start' : ''}</text>
              <text x="12" y="42" class="sub">{[npcs.length && `${npcs.join(', ')}`, items.length && `${items.length} item${items.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || 'no one here'}</text>
            </g>
          );
        })}
        {story.endings.map((e) => {
          const at = layout.pos.get(`ending:${e.key}`)!;
          const k = `ending:${e.key}`;
          return (
            <g class={`node ending ${pick === k ? 'on' : ''}`} transform={`translate(${at.x} ${at.y})`} tabIndex={0} role="button" aria-label={`Ending ${e.title}`} title="See this ending and the shortest way to it"
              onClick={() => onPick(k)} onKeyDown={(ev) => (ev.key === 'Enter' || ev.key === ' ') && (ev.preventDefault(), onPick(k))}>
              <rect width={NODE.w} height={NODE.h} rx="29" />
              <text x="16" y="22" class="name">{e.title.length > 22 ? `${e.title.slice(0, 21)}…` : e.title}</text>
              <text x="16" y="42" class="sub">ending</text>
            </g>
          );
        })}
      </svg>
    </div>
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
