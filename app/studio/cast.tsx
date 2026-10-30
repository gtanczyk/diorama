// The cast: one card per character with their figure, how they look, what the runtime has for them and
// their voice. Every change is an action (cast_redo, voice_set) kept in cast/fixes.json.
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';
import { named } from './build.tsx';
import { FigurePreview } from './figure.tsx';
import { Icon, type IconName } from './icons.tsx';

type Pic = { file: string; v: number | null } | null;
type Character = {
  key: string; role: 'hero' | 'npc' | 'player' | 'narrator'; place: string | null; looks: string; looksNow: string;
  fix: { looks?: string; take?: number; voice?: { voice: string } } | null;
  figure: Pic; painting: Pic; rig: boolean; model: boolean; sprites: boolean; modelIssue: string | null;
  rigIssue?: string | null; spriteIssues?: string[]; moves?: string;
  modelJob: { id: string; state: 'queued' | 'running' } | null;
  modelAttempt: { state: 'ready' | 'fallback' | 'failed'; reason: string | null; at: string } | null;
  body: { height: number; upright: boolean } | null;
  stamps: { rig: number | null; model: number | null; sprites: number | null };
  voice: { voice: string; why: string; stability: number; style: number } | null;
  face?: { ready: boolean; image: boolean; rig: boolean; spriteViews: number; model3d?: {mouth:boolean;method?:string|null;views?:string[]} | null; attempt?: { state?: string; reason?: string } | null };
  lines: number; flagged: number; sample: { text: string; file: string } | null;
  voiceFailures?: Array<{ text: string; reason: string }>;
  voiceWarnings?: string[];
};
type Voice = { id: string; name: string; sounds: string; fits?: boolean };

export function CastView({ slug, version, onError, focus }: { slug: string; version: number; onError: (m: string) => void; focus?: string }) {
  const [cast, setCast] = useState<Character[] | null>(null);
  useEffect(() => void call<Character[]>('cast_status', { slug }).then(setCast).catch((e) => onError(e.message)), [slug, version]);
  // Opened on one character: scroll to their card once it is there.
  // Pictures above it load late and push it down: scroll again once they have.
  useEffect(() => {
    if (!cast || !focus) return;
    const go = () => document.getElementById(`cast-${focus}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    go();
    const again = setTimeout(go, 450);
    return () => clearTimeout(again);
  }, [!!cast, focus]);
  if (!cast) return <p class="detail">Reading the cast…</p>;
  return (
    <div class="cast-view">
      <ul class="cast">
        {cast.map((c) => <Card key={c.key} slug={slug} c={c} onError={onError} focused={c.key === focus} />)}
      </ul>
      <Items slug={slug} version={version} onError={onError} />
    </div>
  );
}

type Item = { key: string; name: string; from: { place: string; thing: string } | null; how: 'cut' | 'redraw' | 'paint' | null; icon: Pic; fix: { how?: string; hint?: string; take?: number } | null };
const HOW = { cut: 'cut from the painting', redraw: 'redrawn by Muse', paint: 'painted by Muse' };

/** The inventory: one icon per story item, with where it comes from; a hint or another take is icon_redo. */
function Items({ slug, version, onError }: { slug: string; version: number; onError: (m: string) => void }) {
  const [items, setItems] = useState<Item[] | null>(null);
  const [hints, setHints] = useState<Record<string, string>>({});
  useEffect(() => void call<Item[]>('icons_status', { slug }).then(setItems).catch(() => setItems([])), [slug, version]);
  if (!items?.length) return null;
  const act = (name: string, input: object) => call(name, { slug, ...input }).catch((e) => onError((e as Error).message));
  return (
    <section class="items">
      <h3>Inventory</h3>
      <ul>
        {items.map((it) => (
          <li key={it.key}>
            {it.icon ? <img src={fileUrl(slug, it.icon.file, it.icon.v)} alt={it.name} /> : <div class="noimg">no icon yet</div>}
            <div class="body">
              <strong>{it.name}</strong>
              <span class="detail">{it.from ? `picked up: ${it.from.place} / ${it.from.thing}` : 'handed over'}{it.how ? ` · ${named(HOW[it.how])}` : ''}</span>
              <form class="row" onSubmit={(e) => (e.preventDefault(), (hints[it.key] ?? '').trim().length >= 3 && void act('icon_redo', { item: it.key, hint: hints[it.key].trim() }))}>
                <input value={hints[it.key] ?? it.fix?.hint ?? ''} placeholder="How it should look" title="Your words for the icon, e.g. 'a rusty brass key'. Press Redraw to use them" aria-label={`How ${it.name} should look`} onInput={(e) => setHints({ ...hints, [it.key]: e.currentTarget.value })} />
                <button type="button" class="ghost small" title={named(it.how === 'cut' ? 'This icon is cut from the painting, so another take comes out the same. Write how it should look and press Redraw.' : `Muse ${it.how === 'paint' ? 'paints' : 'redraws'} the icon again, a new version of the same thing. 1 Muse Image call`)} onClick={() => act('icon_redo', { item: it.key, anotherTake: true })}>Another take</button>
                <button type="submit" class={`${(hints[it.key] ?? '').trim().length >= 3 ? 'primary' : 'ghost'} small`} title={named('Muse redraws the icon the way you wrote, kept across rebuilds. 1 Muse Image call')}>Redraw</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ slug, c, onError, focused }: { slug: string; c: Character; onError: (m: string) => void; focused?: boolean }) {
  // The voices that fit this character (gender and age seen in the figure) come first; the rest are marked.
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const loadVoices = () => voices ?? call<{ voices: Voice[] } | Voice[]>('voice_list', { slug, key: c.key })
    .then((r) => setVoices(Array.isArray(r) ? r : r.voices)).catch((e) => onError(e.message));
  const [looks, setLooks] = useState(c.looksNow);
  const [busy, setBusy] = useState(false);
  // Opened on this character: it moves right away.
  const [moving, setMoving] = useState(!!focused && !!(c.rig || c.model || c.sprites));
  useEffect(() => setLooks(c.looksNow), [c.looksNow]);
  const act = async (name: string, input: object) => {
    setBusy(true);
    try {
      await call(name, { slug, key: c.key, ...input });
    } catch (e) {
      onError((e as Error).message);
    }
    setBusy(false);
  };
  const changed = looks.trim() !== c.looksNow && looks.trim().length >= 10;
  const creature = c.body?.upright === false;
  // What the game has of this character, as small signs; each says what it is on hover.
  const parts = ([
    creature && ['paw', 'A creature: moves as one body (hops, squashes, leans), no skeleton'],
    c.figure && ['figure', `Figure: painted by Muse Image and cut out by SAM${c.moves ? `. In the game it ${c.moves.replace(/^the /, 'is the ')}` : ''}`],
    c.rig && ['bone', '2D rig: the figure cut into parts that walk; used when there is no 3D model or sprites'],
    c.model && ['cube', '3D model: built by TRELLIS from four painted sides'],
    c.sprites && ['film', 'Sprites: painted walk and talk frames, what the game draws first'],
  ].filter(Boolean)) as Array<[IconName, string]>;
  return (
    <li id={`cast-${c.key}`} class={`who ${c.role}${focused ? ' focus' : ''}`}>
      {c.role !== 'narrator' && (c.figure ? <img src={fileUrl(slug, c.figure.file, c.figure.v)} alt={c.key} loading="lazy" /> : <div class="noimg">not painted yet</div>)}
      <div class="body">
        <div class="row">
          <strong>{c.key}</strong>
          <span class="badge">{c.role === 'hero' ? 'hero' : c.role === 'player' ? 'hero for another gamepad' : c.role === 'narrator' ? 'narrator' : `NPC · ${c.place}`}</span>
          <span class="grow" />
          {parts.length > 0 && <span class="has">{parts.map(([sign, what]) => <span class="sign" title={named(what)}><Icon name={sign} /></span>)}</span>}
          {c.modelIssue && <span class="detail">Using 2D: {c.modelIssue}</span>}
          {c.rigIssue && !c.model && !c.sprites && <span class="detail">No 2D walk: {c.rigIssue}</span>}
          {!!c.spriteIssues?.length && <button type="button" class="ghost small" disabled={busy} title={named(`${c.spriteIssues.join('; ')}. Muse paints new walk and talk sheets over the 3D model, the character stays as painted. Kept across rebuilds. About 2-10 Muse Image calls per direction`)} onClick={() => act('sprites_redo', {})}>New walk sheets</button>}
          {c.model && c.modelAttempt?.state === 'failed' && <span class="detail">Keeping previous model: {c.modelAttempt.reason}</span>}
          {c.role !== 'narrator' && c.figure && !c.model && <button type="button" class="ghost small" disabled={busy || !!c.modelJob} title={named(`Muse paints ${c.key} from 4 sides and TRELLIS builds a 3D model${creature ? ': no skeleton, in the game it hops, squashes, leans and blinks as one body' : ''}. Animation settings are chosen automatically and kept across rebuilds.`)} onClick={() => act('cast_animate', {})}>{c.modelJob ? c.modelJob.state === 'queued' ? '3D queued…' : 'Building 3D…' : c.modelIssue ? 'Retry 3D' : 'Animate in 3D'}</button>}
          {(c.rig || c.model || c.sprites) && <button type="button" class={`ghost small round${moving ? ' on' : ''}`} aria-label={moving ? 'Close the preview' : 'See it move'} title={moving ? 'Close the preview' : 'See it move: walk, stand and talk as the game draws it. Free'} onClick={() => setMoving(!moving)}>{moving ? '■' : '▶'}</button>}
        </div>
        {c.role !== 'narrator' && (<>
          <div class="row" style="margin-bottom:8px">
            <button type="button" class="ghost small" disabled={busy || !c.figure} onClick={() => void act('faces_prepare', {})}>{c.face?.ready ? 'Refresh speech animation' : 'Prepare speech animation'}</button>
            {c.face?.ready && <small>{c.face.model3d?.mouth ? `2D + 3D speech ready (${c.face.model3d.method === 'morphs' ? 'facial morphs' : 'painted surfaces'})` : '2D speaking face ready'}</small>}
            {c.face?.attempt?.state === 'failed' && <details class="detail"><summary>Speech animation incomplete · previous appearance kept</summary><p>{c.face.attempt.reason}</p></details>}
          </div>
          <form class="say" onSubmit={(e) => (e.preventDefault(), changed && void act('cast_redo', { looks: looks.trim() }))}>
            <textarea rows={3} value={looks} title="How the character looks. Change it and press Repaint" onInput={(e) => setLooks(e.currentTarget.value)} aria-label={`How ${c.key} looks`} />
            <div class="row">
              {c.fix?.looks && <span class="detail">your description{c.fix.take ? ` · take ${c.fix.take + 1}` : ''}</span>}
              <span class="grow" />
              <button type="button" class="ghost small" disabled={busy} title={named('Muse paints this character again from the same description and SAM cuts the figure out. 1 Muse Image + 1 SAM call. Sprites and the 3D model are not remade')} onClick={() => act('cast_redo', { anotherTake: true })}>Another take</button>
              <button type="submit" class="primary small" disabled={busy || !changed} title={named(changed ? 'Muse paints the character from your new description, kept across rebuilds. 1 Muse Image + 1 SAM call' : 'Change the description first (at least 10 letters)')}>Repaint</button>
            </div>
          </form>
        </>)}
        <div class="row voice">
          {c.voice
            ? <>
                <label title="Pick another voice. Their lines are spoken again: ElevenLabs, one call per line of this character">Voice <select onFocus={loadVoices} onMouseDown={loadVoices} disabled={busy} value={c.voice.voice} onChange={(e) => act('voice_set', { voice: e.currentTarget.value })}>
                  {(voices ?? [{ id: c.voice.voice, name: c.voice.why, sounds: '' }]).map((v) => <option value={v.id} title={[v.name, v.sounds].filter(Boolean).join(' · ')}>{v.fits === false ? '(does not fit) ' : ''}{short(v.name, 32)}{v.sounds ? ` · ${short(v.sounds, 40)}` : ''}</option>)}
                </select></label>
                <span class="detail">{c.lines} line{c.lines === 1 ? '' : 's'}{c.flagged ? `, ${c.flagged} misheard` : ''}</span>
              </>
            : <span class="detail">{c.lines ? `${c.lines} lines, no voice yet` : 'no spoken lines'}</span>}
        </div>
        {c.sample && <div class="sample"><audio controls preload="none" src={fileUrl(slug, c.sample.file)} /><span class="detail">“{c.sample.text}”</span></div>}
        {!!c.voiceFailures?.length && <p class="detail" role="status">{c.voiceFailures.length} spoken lines unavailable: {c.voiceFailures[0].reason}</p>}
        {c.voiceWarnings?.map((w) => <p class="detail" role="status">{w}</p>)}
      </div>
      {moving && <FigurePreview slug={slug} who={c.key} stamps={c.stamps} />}
    </li>
  );
}

// A designed voice is named by its description; keep the select readable and the whole text in the tooltip.
function short(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(','), cut.lastIndexOf(' '));
  return `${(stop > max / 2 ? cut.slice(0, stop) : cut).replace(/[,\s]+$/, '')}…`;
}
