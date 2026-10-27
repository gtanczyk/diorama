// The cast: one card per character with their figure, how they look, what the runtime has for them and
// their voice. Every change is an action (cast_redo, voice_set) kept in cast/fixes.json.
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';

type Pic = { file: string; v: number | null } | null;
type Character = {
  key: string; role: 'hero' | 'npc' | 'player' | 'narrator'; place: string | null; looks: string; looksNow: string;
  fix: { looks?: string; take?: number; voice?: { voice: string } } | null;
  figure: Pic; painting: Pic; rig: boolean; model: boolean; sprites: boolean;
  voice: { voice: string; why: string; stability: number; style: number } | null;
  lines: number; flagged: number; sample: { text: string; file: string } | null;
};
type Voice = { id: string; name: string; sounds: string; fits?: boolean };

export function CastView({ slug, version, onError }: { slug: string; version: number; onError: (m: string) => void }) {
  const [cast, setCast] = useState<Character[] | null>(null);
  useEffect(() => void call<Character[]>('cast_status', { slug }).then(setCast).catch((e) => onError(e.message)), [slug, version]);
  if (!cast) return <p class="detail">Reading the cast…</p>;
  return (
    <>
      <ul class="cast">
        {cast.map((c) => <Card key={c.key} slug={slug} c={c} onError={onError} />)}
      </ul>
      <Items slug={slug} version={version} onError={onError} />
    </>
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
              <span class="detail">{it.from ? `picked up: ${it.from.place} / ${it.from.thing}` : 'handed over'}{it.how ? ` · ${HOW[it.how]}` : ''}</span>
              <form class="row" onSubmit={(e) => (e.preventDefault(), (hints[it.key] ?? '').trim().length >= 3 && void act('icon_redo', { item: it.key, hint: hints[it.key].trim() }))}>
                <input value={hints[it.key] ?? it.fix?.hint ?? ''} placeholder="How it should look" aria-label={`How ${it.name} should look`} onInput={(e) => setHints({ ...hints, [it.key]: e.currentTarget.value })} />
                <button type="button" class="ghost small" onClick={() => act('icon_redo', { item: it.key, anotherTake: true })}>Another take</button>
                <button type="submit" class="primary small">Redraw</button>
              </form>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card({ slug, c, onError }: { slug: string; c: Character; onError: (m: string) => void }) {
  // The voices that fit this character (gender and age seen in the figure) come first; the rest are marked.
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const loadVoices = () => voices ?? call<{ voices: Voice[] } | Voice[]>('voice_list', { slug, key: c.key })
    .then((r) => setVoices(Array.isArray(r) ? r : r.voices)).catch((e) => onError(e.message));
  const [looks, setLooks] = useState(c.looksNow);
  const [busy, setBusy] = useState(false);
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
  const parts = [c.figure && 'figure', c.rig && 'rig', c.model && '3D model', c.sprites && 'sprites'].filter(Boolean);
  return (
    <li class={`who ${c.role}`}>
      {c.role !== 'narrator' && (c.figure ? <img src={fileUrl(slug, c.figure.file, c.figure.v)} alt={c.key} loading="lazy" /> : <div class="noimg">not painted yet</div>)}
      <div class="body">
        <div class="row">
          <strong>{c.key}</strong>
          <span class="badge">{c.role === 'hero' ? 'hero' : c.role === 'player' ? 'hero for another gamepad' : c.role === 'narrator' ? 'narrator' : `NPC · ${c.place}`}</span>
          <span class="grow" />
          {parts.length > 0 && <span class="detail">{parts.join(' · ')}</span>}
        </div>
        {c.role !== 'narrator' && (
          <form class="say" onSubmit={(e) => (e.preventDefault(), changed && void act('cast_redo', { looks: looks.trim() }))}>
            <textarea rows={3} value={looks} onInput={(e) => setLooks(e.currentTarget.value)} aria-label={`How ${c.key} looks`} />
            <div class="row">
              {c.fix?.looks && <span class="detail">your description{c.fix.take ? ` · take ${c.fix.take + 1}` : ''}</span>}
              <span class="grow" />
              <button type="button" class="ghost small" disabled={busy} onClick={() => act('cast_redo', { anotherTake: true })}>Another take</button>
              <button type="submit" class="primary small" disabled={busy || !changed}>Repaint</button>
            </div>
          </form>
        )}
        <div class="row voice">
          {c.voice
            ? <>
                <label>Voice <select onFocus={loadVoices} onMouseDown={loadVoices} disabled={busy} value={c.voice.voice} onChange={(e) => act('voice_set', { voice: e.currentTarget.value })}>
                  {(voices ?? [{ id: c.voice.voice, name: c.voice.why, sounds: '' }]).map((v) => <option value={v.id} title={v.sounds}>{v.fits === false ? '(does not fit) ' : ''}{v.name}{v.sounds ? ` · ${v.sounds.slice(0, 40)}` : ''}</option>)}
                </select></label>
                <span class="detail">{c.lines} line{c.lines === 1 ? '' : 's'}{c.flagged ? `, ${c.flagged} misheard` : ''}</span>
              </>
            : <span class="detail">{c.lines ? `${c.lines} lines, no voice yet` : 'no spoken lines'}</span>}
        </div>
        {c.sample && <div class="sample"><audio controls preload="none" src={fileUrl(slug, c.sample.file)} /><span class="detail">“{c.sample.text}”</span></div>}
      </div>
    </li>
  );
}
