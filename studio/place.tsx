// The place up close: the painting (or its masks or walk review), and tools to fix what the pipeline got
// wrong. Every tool is an action that writes corrections.json and rebuilds the place, so a fix survives
// the next build and the agent can do the same with words.
import { useEffect, useRef, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';

const W = 1200;
const H = 896;
const KINDS = ['standing', 'wall', 'on-top', 'walk-on', 'flat'] as const;

type Pic = { file: string; v: number | null } | null;
type ThingRow = { key: string; kind: string; phrase: string; source: string; coarse: boolean; brushed?: boolean; stand: [number, number] | null; removable?: boolean; why?: string };
type FloorRow = { key: string; source: string; coarse: boolean; brushed?: boolean };
type Stroke = { mode: 'add' | 'erase'; radius: number; points: [number, number][] };
type Fixes = {
  things: Record<string, { phrase?: string; box?: number[]; kind?: string; strokes: Stroke[]; stand?: [number, number]; removed?: boolean }>;
  added?: Record<string, { looks: string }>;
  floors: Record<string, { add: string[]; remove: string[]; strokes: Stroke[] }>;
  repaint: Array<{ region: number[]; fix: string }>;
};
export type PlaceStatus = {
  place: string;
  pictures: { painting: Pic; masks: Pic; walk: Pic };
  things: ThingRow[];
  floors: FloorRow[];
  flagged: string[];
  start: [number, number] | null;
  corrections: Fixes;
  npcs: { key: string; box: Rect; at: [number, number] }[];
};
type Tool = 'look' | 'note' | 'box' | 'repaint' | 'brush' | 'stand' | 'move';
type Rect = [number, number, number, number];

const TOOLS: Array<[Tool, string, string]> = [
  ['look', 'Look', 'Just look, clicks change nothing'],
  ['note', 'Note', 'Click a spot and say what is wrong; the note waits for you or the agent. Free'],
  ['box', 'Box', 'Drag a box around where a thing really is, so SAM finds it there. 1 SAM call'],
  ['brush', 'Brush', 'Paint onto or rub out of a thing\'s or a floor\'s mask. Free, saved answers are reused'],
  ['stand', 'Stand', 'Click where the hero should stand to use a thing. Free'],
  ['move', 'Move NPC', 'Click where an NPC should stand (its feet); it is sized for the depth there. Free, no repaint'],
  ['repaint', 'Repaint', 'Drag over a region and say how Muse should paint it. 1 Muse Image edit'],
];

const LAYER_TIPS: Record<string, string> = {
  painting: 'The painting Muse made',
  masks: 'What SAM cut out: each thing and floor in its own colour',
  walk: 'Where the hero can walk, and how big they are at each spot',
};
const KIND_TIPS: Record<string, string> = {
  standing: 'Standing: people walk around and behind it. Changing the kind is free',
  wall: 'Wall: part of the backdrop. Changing the kind is free',
  'on-top': 'On top of something else. Changing the kind is free',
  'walk-on': 'Walk-on: people walk over it. Changing the kind is free',
  flat: 'Flat: lies on the floor, never in front of anyone. Changing the kind is free',
};

const norm = ([a, b, c, d]: Rect): Rect => [Math.round(Math.min(a, c)), Math.round(Math.min(b, d)), Math.round(Math.max(a, c)), Math.round(Math.max(b, d))];

export function PlaceEditor({ slug, place, version, onError }: { slug: string; place: string; version: number; onError: (m: string) => void }) {
  const [st, setSt] = useState<PlaceStatus | null>(null);
  const [layer, setLayer] = useState<'painting' | 'masks' | 'walk'>('painting');
  const [tool, setTool] = useState<Tool>('look');
  const [target, setTarget] = useState('');
  const [mode, setMode] = useState<'add' | 'erase'>('add');
  const [radius, setRadius] = useState(14);
  const [strokes, setStrokes] = useState<Stroke[]>([]);
  const [drag, setDrag] = useState<Rect | null>(null);
  const [point, setPoint] = useState<[number, number] | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const svg = useRef<SVGSVGElement>(null);
  const down = useRef(false);

  const load = () => call<PlaceStatus>('place_status', { slug, place }).then(setSt).catch((e) => onError(e.message));
  useEffect(() => void load(), [slug, place, version]);
  useEffect(() => {
    setDrag(null);
    setPoint(null);
    setStrokes([]);
    setText('');
  }, [tool, place]);

  const things = st?.things ?? [];
  const floors = st?.floors ?? [];
  const isFloor = floors.some((f) => f.key === target);
  const npcs = st?.npcs ?? [];
  const targets = tool === 'brush' ? [...things.map((t) => t.key), ...floors.map((f) => f.key)] : tool === 'move' ? npcs.map((n) => n.key) : things.map((t) => t.key);
  useEffect(() => {
    if (targets.length && !targets.includes(target)) setTarget(targets[0]);
  }, [tool, st]);

  const at = (e: PointerEvent): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    return [Math.round(((e.clientX - r.left) / r.width) * W), Math.round(((e.clientY - r.top) / r.height) * H)];
  };
  const onDown = (e: PointerEvent) => {
    if (tool === 'look') return;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const p = at(e);
    down.current = true;
    if (tool === 'box' || tool === 'repaint') setDrag([p[0], p[1], p[0], p[1]]);
    if (tool === 'brush') setStrokes((s) => [...s, { mode, radius, points: [p] }]);
    if (tool === 'note' || tool === 'stand' || tool === 'move') setPoint(p);
  };
  const onMove = (e: PointerEvent) => {
    if (!down.current) return;
    const p = at(e);
    if (tool === 'box' || tool === 'repaint') setDrag((d) => d && [d[0], d[1], p[0], p[1]]);
    if (tool === 'brush') setStrokes((s) => s.map((k, i) => (i === s.length - 1 ? { ...k, points: [...k.points, p] } : k)));
  };
  const onUp = () => (down.current = false);

  const act = async (name: string, input: object, after?: () => void) => {
    setBusy(true);
    try {
      await call(name, { slug, place, ...input });
      after?.();
      setDrag(null);
      setPoint(null);
      setStrokes([]);
      setText('');
      void load();
    } catch (e) {
      onError((e as Error).message);
    }
    setBusy(false);
  };

  const pic = st?.pictures[layer] ?? st?.pictures.painting;
  const box = drag && norm(drag);
  const big = box && box[2] - box[0] > 8 && box[3] - box[1] > 8;
  const fixes = st?.corrections;
  const fixList = fixes ? [
    ...Object.entries(fixes.added ?? {}).map(([k, a]) => ({ key: k, what: `added: "${a.looks}"` })),
    ...Object.entries(fixes.things).map(([k, t]) => ({ key: k, what: [t.removed && 'taken off the list', t.phrase && `"${t.phrase}"`, t.kind, t.box && 'box', t.strokes.length && `${t.strokes.length} strokes`, t.stand && 'stand'].filter(Boolean).join(', ') })),
    ...Object.entries(fixes.floors).map(([k, f]) => ({ key: k, what: [f.add.length && `+${f.add.length} cells`, f.remove.length && `-${f.remove.length} cells`, f.strokes.length && `${f.strokes.length} strokes`].filter(Boolean).join(', ') })),
  ] : [];

  return (
    <section class="editor">
      <div class="row">
        <h2>{place}</h2>
        <span class="grow" />
        <div class="seg" role="group" aria-label="Picture">
          {(['painting', 'masks', 'walk'] as const).map((l) => <button type="button" title={LAYER_TIPS[l]} class={layer === l ? 'on' : ''} disabled={!st?.pictures[l]} onClick={() => setLayer(l)}>{l}</button>)}
        </div>
      </div>
      <div class="seg tools" role="group" aria-label="Tool">
        {TOOLS.map(([t, label, hint]) => <button type="button" title={hint} class={tool === t ? 'on' : ''} onClick={() => setTool(t)}>{label}</button>)}
      </div>
      {tool !== 'look' && <p class="detail">{TOOLS.find(([t]) => t === tool)![2]}.</p>}
      {(tool === 'box' || tool === 'brush' || tool === 'stand' || tool === 'move') && (
        <div class="row">
          <label title={tool === 'brush' ? 'The thing or floor whose mask the brush paints' : tool === 'move' ? 'The NPC to move' : 'The thing this tool fixes'}>{tool === 'brush' ? 'Mask of' : tool === 'move' ? 'NPC' : 'Thing'} <select value={target} onChange={(e) => setTarget(e.currentTarget.value)}>
            {tool === 'brush' && floors.length > 0 && <optgroup label="Things">{things.map((t) => <option value={t.key}>{t.key}</option>)}</optgroup>}
            {tool === 'brush' && floors.length > 0 ? <optgroup label="Floors">{floors.map((f) => <option value={f.key}>{f.key}</option>)}</optgroup> : targets.map((k) => <option value={k}>{k}</option>)}
          </select></label>
          {tool === 'brush' && <>
            <div class="seg" role="group" aria-label="Brush"><button type="button" class={mode === 'add' ? 'on' : ''} title="Strokes add to the mask" onClick={() => setMode('add')}>Add</button><button type="button" class={mode === 'erase' ? 'on' : ''} title="Strokes rub out of the mask" onClick={() => setMode('erase')}>Erase</button></div>
            <label title="How wide the brush is">Size <input type="range" min={3} max={60} value={radius} onInput={(e) => setRadius(Number(e.currentTarget.value))} /></label>
          </>}
        </div>
      )}
      <div class={`stage tool-${tool}`}>
        {pic ? <img src={fileUrl(slug, pic.file, pic.v)} alt={`${place}, ${layer}`} draggable={false} /> : <div class="noimg">no picture yet</div>}
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {things.map((t) => t.stand && <g><circle cx={t.stand[0]} cy={t.stand[1]} r={7} class="stand" /></g>)}
          {tool === 'move' && npcs.map((n) => <rect x={n.box[0]} y={n.box[1]} width={n.box[2] - n.box[0]} height={n.box[3] - n.box[1]} class={n.key === target ? 'sel npc on' : 'sel npc'} />)}
          {box && <rect x={box[0]} y={box[1]} width={box[2] - box[0]} height={box[3] - box[1]} class={tool === 'repaint' ? 'sel repaint' : 'sel'} />}
          {strokes.map((s) => <polyline points={s.points.map((p) => p.join(',')).join(' ')} class={`stroke ${s.mode}`} stroke-width={s.radius * 2} />)}
          {point && <circle cx={point[0]} cy={point[1]} r={10} class="pin" />}
        </svg>
      </div>
      {tool === 'box' && big && <div class="row"><span class="detail">{target} is in [{box!.join(', ')}]</span><span class="grow" /><button type="button" class="primary small" disabled={busy || !target} title="SAM looks for the thing inside this box only, then the place is checked again. 1 SAM call" onClick={() => act('mask_fix', { thing: target, box })}>Find it here</button></div>}
      {tool === 'stand' && point && <div class="row"><span class="detail">Stand at {point.join(', ')} to use {target}</span><span class="grow" /><button type="button" class="primary small" disabled={busy || !target} title="The hero walks here to use it. Kept across rebuilds. Free" onClick={() => act('stand_set', { thing: target, at: point })}>Set stand spot</button></div>}
      {tool === 'move' && npcs.length === 0 && <p class="detail">No one stands in this place.</p>}
      {tool === 'move' && point && <div class="row"><span class="detail">{target} stands with feet at {point.join(', ')}</span><span class="grow" /><button type="button" class="primary small" disabled={busy || !target} title="The NPC stands here, sized for the depth. Kept across rebuilds. Free, no repaint" onClick={() => act('npc_move', { npc: target, at: point })}>Move here</button></div>}
      {tool === 'brush' && strokes.length > 0 && <div class="row"><span class="detail">{strokes.length} stroke{strokes.length > 1 ? 's' : ''} on {target}</span><span class="grow" /><button type="button" class="ghost small" title="Take back the last stroke" onClick={() => setStrokes((s) => s.slice(0, -1))}>Undo stroke</button><button type="button" class="primary small" disabled={busy || !target} title="Keep the strokes and rebuild this place from its masks. Kept across rebuilds. Free, saved answers are reused" onClick={() => act('mask_brush', { layer: isFloor ? 'floor' : 'thing', key: target, strokes })}>Apply and rebuild</button></div>}
      {((tool === 'note' && point) || (tool === 'repaint' && big)) && (
        <form class="say" onSubmit={(e) => { e.preventDefault(); if (tool === 'note') void act('feedback_add', { point, text: text.trim() }); else void act('repaint_region', { region: box, fix: text.trim() }); }}>
          <textarea rows={2} placeholder={tool === 'note' ? 'What is wrong here?' : 'How should Muse paint this region?'} value={text} onInput={(e) => setText(e.currentTarget.value)} />
          <div class="row"><span class="grow" /><button type="submit" class="primary small" disabled={busy || text.trim().length < 3} title={tool === 'note' ? 'Keep the note on this spot, for you or the agent. Free' : 'Muse repaints only this region your way, then the place is measured again. 1 Muse Image edit'}>{tool === 'note' ? 'Leave note' : 'Repaint (1 Muse edit)'}</button></div>
        </form>
      )}
      {things.length > 0 && (
        <table class="things">
          <thead><tr><th>Thing</th><th>Kind</th><th>SAM looks for</th><th>Mask</th><th /></tr></thead>
          <tbody>
            {things.map((t) => <ThingLine key={t.key} t={t} busy={busy} fix={(input) => act('mask_fix', { thing: t.key, ...input })} remove={(paintOut) => act('thing_remove', { thing: t.key, paintOut })} />)}
            <AddThing busy={busy} add={(looks, kind) => act('thing_add', { looks, ...(kind && { kind }) })} />
          </tbody>
        </table>
      )}
      {floors.some((f) => f.coarse) && <p class="flag">Coarse floors: {floors.filter((f) => f.coarse).map((f) => f.key).join(', ')}. Brush them, or ask the agent to fix their cells.</p>}
      {(fixList.length > 0 || (fixes?.repaint.length ?? 0) > 0) && (
        <div class="fixes">
          <div class="row"><strong>Your fixes</strong><span class="detail">kept across rebuilds</span><span class="grow" /><button type="button" class="ghost small" disabled={busy} title={(fixes?.repaint.length ?? 0) > 0 ? 'Take back every fix of this place. It is painted again: 1 Muse Image call' : 'Take back every fix of this place and rebuild it from its masks. Free'} onClick={() => act('corrections_clear', {})}>Clear all</button></div>
          <ul>
            {fixList.map((f) => <li><code>{f.key}</code> {f.what}<button type="button" class="ghost small" disabled={busy} title={`Take back the fixes of ${f.key} and rebuild this place from its masks. Free`} onClick={() => act('corrections_clear', { key: f.key })}>Clear</button></li>)}
            {fixes!.repaint.map((r) => <li>repaint [{r.region.join(', ')}]: {r.fix}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

/** The last row of the things: something painted that should be a thing of its own. */
function AddThing({ busy, add }: { busy: boolean; add: (looks: string, kind: string) => void }) {
  const [looks, setLooks] = useState('');
  const [kind, setKind] = useState('');
  const ok = looks.trim().length >= 3;
  return (
    <tr class="add-thing">
      <td colSpan={2}><select value={kind} disabled={busy} title="How it meets the floor; Spark decides when left empty" onChange={(e) => setKind(e.currentTarget.value)}><option value="">kind: Spark decides</option>{KINDS.map((k) => <option value={k}>{k}</option>)}</select></td>
      <td><form class="row" onSubmit={(e) => (e.preventDefault(), ok && (add(looks.trim(), kind), setLooks('')))}><input value={looks} placeholder="Add a thing that is painted here, e.g. the red bench" onInput={(e) => setLooks(e.currentTarget.value)} />{ok && <button type="submit" class="primary small" disabled={busy} title="It becomes a thing of its own: Spark finds it, SAM cuts it out, the place is checked again. 1 Spark and 1 SAM call">Add</button>}</form></td>
      <td colSpan={2} />
    </tr>
  );
}

function ThingLine({ t, busy, fix, remove }: { t: ThingRow; busy: boolean; fix: (input: object) => void; remove: (paintOut: boolean) => void }) {
  const [asking, setAsking] = useState(false);
  const [phrase, setPhrase] = useState(t.phrase);
  useEffect(() => setPhrase(t.phrase), [t.phrase]);
  return (
    <tr>
      <td><code>{t.key}</code></td>
      <td><select value={t.kind} disabled={busy} title={KIND_TIPS[t.kind] ?? 'What kind of thing it is'} onChange={(e) => fix({ kind: e.currentTarget.value })}>{KINDS.map((k) => <option value={k}>{k}</option>)}</select></td>
      <td><form class="row" onSubmit={(e) => (e.preventDefault(), phrase.trim() !== t.phrase && fix({ phrase: phrase.trim() }))}><input value={phrase} title="The words SAM searches the painting for. Change them and press Search" onInput={(e) => setPhrase(e.currentTarget.value)} />{phrase.trim() !== t.phrase && phrase.trim().length > 1 && <button type="submit" class="primary small" disabled={busy} title="SAM looks for the thing by these words. 1 SAM call">Search</button>}</form></td>
      <td><span class={`badge ${t.coarse ? 'fail' : 'ok'}`} title={t.coarse ? 'SAM did not find it: the mask is only a box' : undefined}>{t.source}{t.brushed ? ' + brush' : ''}</span></td>
      <td class="remove">
        {asking
          ? <span class="row">
              <button type="button" class="ghost small" disabled={busy} title="It stays in the picture, but is no longer a thing of its own. Free" onClick={() => (setAsking(false), remove(false))}>Keep it painted</button>
              <button type="button" class="ghost small danger" disabled={busy} title="Muse paints it out of the picture, then the place is checked again. 1 Muse Image edit" onClick={() => (setAsking(false), remove(true))}>Paint it out</button>
              <button type="button" class="ghost small" onClick={() => setAsking(false)}>Cancel</button>
            </span>
          : <button type="button" class="ghost small" disabled={busy || t.removable === false} title={t.removable === false ? `Can't remove: ${t.why}` : 'Take it off the list'} aria-label={`Remove ${t.key}`} onClick={() => setAsking(true)}>Remove</button>}
      </td>
    </tr>
  );
}
