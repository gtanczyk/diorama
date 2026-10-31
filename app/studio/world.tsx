// A world in the atelier: the conversation with the agent that looks after it, told in cards (the story, the
// places, the cast, what waits for you, what a turn changed, the game), beside a stage that shows what the
// card is about. Click a thing on the stage and it opens; the agent is told what is open with each message.
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';
import { named } from './build.tsx';
import { Icon } from './icons.tsx';

export type StageView = { kind: 'build' | 'place' | 'cast' | 'story' | 'play' | 'work'; place?: string; step?: string; build?: { place?: string } };

type Pic = { file: string; v: number | null } | null;
export type CardPlace = { key: string; shows: string; image: Pic; stages: Record<string, number | null>; verdict: { ok: boolean } | null; trouble?: { why: string } | null };
type Character = { key: string; role: string; looksNow: string; figure: Pic };

/** A card in the conversation: what it shows decides the stage when clicked. */
export function Card({ kind, by, on, onClick, children, tone, opening }: { kind: string; by?: string; on?: boolean; onClick?: () => void; children: ComponentChildren; tone?: 'ask' | 'play'; opening?: boolean }) {
  return (
    <div class={`wcard${on ? ' on' : ''}${tone ? ` ${tone}` : ''}${onClick ? ' click' : ''}`} data-opening={opening ? kind.toLowerCase() : undefined} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => onClick && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}>
      <div class="k">{kind}{by && <span class="by">{named(by)}</span>}</div>
      {children}
    </div>
  );
}

const nice = (key: string) => key.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
export { nice };

/** The places as small paintings; one not painted yet shows its name. */
export function PlacesCard({ slug, places, pending = [], stage, onStage }: { slug: string; places: CardPlace[]; pending?: string[]; stage: StageView; onStage: (s: StageView) => void }) {
  return (
    <Card kind="Places" by="Muse Image · SAM 3.1" on={stage.kind === 'place'} opening>
      <div class="thumbs">
        {places.map((p) => (
          <button type="button" class={`thumb${stage.kind === 'place' && stage.place === p.key ? ' on' : ''}${p.trouble ? ' trouble' : p.verdict?.ok ? ' ready' : ''}`} title={`${nice(p.key)}: ${p.shows}${p.verdict?.ok ? ' (playable)' : ''}`} onClick={() => onStage({ kind: 'place', place: p.key })}
            style={p.image ? { backgroundImage: `url("${fileUrl(slug, p.image.file, p.image.v)}")` } : undefined}>
            {!p.image && <span>{nice(p.key)}</span>}
          </button>
        ))}
        {pending.map(key => <button type="button" class="thumb pending-place" title={`${nice(key)}: being built; not in the game yet. Show build progress`} onClick={() => onStage({ kind: 'build' })}><span>{nice(key)}<br />Building…</span></button>)}
      </div>
    </Card>
  );
}

/** The characters standing in a row, as cut out. */
export function CastCard({ slug, version, stage, onStage }: { slug: string; version: number; stage: StageView; onStage: (s: StageView) => void }) {
  const cast = useCast(slug, version);
  const shown = cast?.filter((c) => c.figure) ?? [];
  if (!shown.length) return null;
  return (
    <Card kind="Cast" by="Muse Image · 3D" on={stage.kind === 'cast'} onClick={() => onStage({ kind: 'cast' })} opening>
      <div class="lineup-mini">{shown.map((c) => <img src={fileUrl(slug, c.figure!.file, c.figure!.v)} alt={nice(c.key)} title={`${nice(c.key)}: ${c.looksNow}`} />)}</div>
    </Card>
  );
}

/**
 * The world at a glance, pinned over a long conversation once its first cards scrolled away: the story, the places
 * and the cast. The compact previews lead back to their full cards in the conversation.
 */
export function WorldStrip({ slug, version, title, places, pending = [], castDone, stage, onStage }: { slug: string; version: number; title?: string; places: CardPlace[]; pending?: string[]; castDone: boolean; stage: StageView; onStage: (s: StageView) => void }) {
  const cast = useCast(slug, version)?.filter((c) => c.figure) ?? [];
  const goToCard = (button: HTMLButtonElement, kind: 'places' | 'cast') => {
    const scroller = button.closest('.agent')?.querySelector<HTMLElement>('.gc-scroll');
    const card = scroller?.querySelector<HTMLElement>(`[data-opening="${kind}"]`);
    if (!scroller || !card) return;
    const target = kind === 'places' ? card.querySelector<HTMLElement>('button') : card;
    target?.focus({ preventScroll: true });
    scroller.scrollTo({ top: scroller.scrollTop + card.getBoundingClientRect().top - scroller.getBoundingClientRect().top - 8, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const placesLabel = `${places.length} ${places.length === 1 ? 'place' : 'places'}${pending.length ? `, ${pending.length} building` : ''}. Show places in the conversation`;
  return (
    <div class="world-strip">
      {title && <button type="button" class={`ws-story${stage.kind === 'story' ? ' on' : ''}`} title="The story: places, items, people and endings" onClick={() => onStage({ kind: 'story' })}>{title}</button>}
      <button type="button" class="ws-places" title={placesLabel} aria-label={placesLabel} onClick={(e) => goToCard(e.currentTarget, 'places')}>
        <span class="ws-stack" aria-hidden="true">
          {places.slice(0, 3).map((p) => <span class="ws-sheet" key={p.key} style={p.image ? { backgroundImage: `url("${fileUrl(slug, p.image.file, p.image.v)}")` } : undefined} />)}
        </span>
        <span class="ws-count">{places.length}</span>
        {pending.length > 0 && <span class="ws-building" aria-hidden="true">+{pending.length} ◌</span>}
      </button>
      {castDone && cast.length > 0 && (
        <button type="button" class="ws-cast" title="Show the cast in the conversation" aria-label={`Show ${cast.length} ${cast.length === 1 ? 'character' : 'characters'} in the conversation`} onClick={(e) => goToCard(e.currentTarget, 'cast')}>
          {cast.slice(0, 5).map((c) => <img src={fileUrl(slug, c.figure!.file, c.figure!.v)} alt="" />)}
          {cast.length > 5 && <span class="ws-count">+{cast.length - 5}</span>}
        </button>
      )}
    </div>
  );
}

function useCast(slug: string, version: number) {
  const [cast, setCast] = useState<Character[] | null>(null);
  useEffect(() => void call<Character[]>('cast_status', { slug }).then(setCast).catch(() => setCast([])), [slug, version]);
  return cast;
}

type Box = [number, number, number, number];
type Masks = { things?: Record<string, { box?: Box; phrase?: string }> };

/**
 * The place as a framed painting. Every thing SAM cut out is a spot: hovering lights up its mask,
 * a click opens it (its mask, kind, stand spot: by hand).
 */
export function PlaceStage({ slug, place, version, onOpen, children }: { slug: string; place: CardPlace; version: number; onOpen?: (thing: string) => void; children?: ComponentChildren }) {
  const [masks, setMasks] = useState<Masks | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setMasks(null);
    setHover(null);
    fetch(fileUrl(slug, `places/${place.key}/masks.json`, Date.now()), { cache: 'no-store', signal: controller.signal }).then((r) => (r.ok ? r.json() : null)).then((m) => { if (!controller.signal.aborted) setMasks(m as Masks | null); }).catch(() => {});
    return () => controller.abort();
  }, [slug, place.key, version]);
  // Big things first, so a small one on top of a big one gets the pointer.
  const spots = Object.entries(masks?.things ?? {}).filter(([, t]) => t.box).sort(([, a], [, b]) => area(b.box!) - area(a.box!));
  return (
    <div class="mat">
      <div class="frame">
        <div class="pic">
          {place.image ? <img src={fileUrl(slug, place.image.file, place.image.v)} alt={place.shows} /> : <div class="empty"><strong>{nice(place.key)}</strong><span>{named('Muse Image paints it next')}</span></div>}
          {hover && (
            <div class="glow" style={{ maskImage: `url("${fileUrl(slug, `places/${place.key}/masks/${hover}.png`)}")`, WebkitMaskImage: `url("${fileUrl(slug, `places/${place.key}/masks/${hover}.png`)}")` }} />
          )}
          {spots.map(([key, t]) => {
            const [x0, y0, x1, y1] = t.box!;
            return (
              <button type="button" class="spot" aria-label={`Open the ${nice(key).toLowerCase()}`} title={`${nice(key)}: click to open it`}
                style={{ left: `${(x0 / 1200) * 100}%`, top: `${(y0 / 896) * 100}%`, width: `${((x1 - x0) / 1200) * 100}%`, height: `${((y1 - y0) / 896) * 100}%` }}
                onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(key)} onBlur={() => setHover(null)}
                onClick={() => onOpen?.(key)}>
                {hover === key && <span class="name">{nice(key).toLowerCase()}</span>}
              </button>
            );
          })}
        </div>
      </div>
      {children}
    </div>
  );
}
const area = (b: Box) => (b[2] - b[0]) * (b[3] - b[1]);

/** The cast standing in a row and their items on a shelf; a click opens one. */
export function CastStage({ slug, version, onOpen }: { slug: string; version: number; onOpen?: (key: string) => void }) {
  const cast = useCast(slug, version);
  const [items, setItems] = useState<Item[]>([]);
  useEffect(() => void call<Item[]>('icons_status', { slug }).then(setItems).catch(() => setItems([])), [slug, version]);
  if (!cast) return <div class="mat"><p class="detail">Reading the cast…</p></div>;
  const shown = cast.filter((c) => c.figure);
  if (!shown.length) return <div class="mat"><p class="detail">Nobody is cast yet: the build paints them after the places.</p></div>;
  return (
    <div class="mat lineup">
      {/* Any cast fits the stage: up to 6 a row, more rows when there are more, each figure smaller then. */}
      <div class="figures" style={{ '--per-row': Math.min(shown.length, Math.ceil(shown.length / Math.ceil(shown.length / 6))), '--rows': Math.ceil(shown.length / 6) }}>
      {shown.map((c) => (
        <div class="who-at">
          <button type="button" class="who" title={`${c.looksNow}. Click to open: looks, voice, 3D model and sprites`} onClick={() => onOpen?.(c.key)}>
            <img src={fileUrl(slug, c.figure!.file, c.figure!.v)} alt="" />
            <span>{nice(c.key)}{c.role === 'hero' ? ' · hero' : ''}</span>
          </button>
        </div>
      ))}
      </div>
      {/* The story's items on a shelf: what the hero picks up or is handed; a click opens one. */}
      {items.length > 0 && (
        <div class="shelf" aria-label="Items">
          {items.map((it) => (
            <button type="button" class="item" title={`${it.name}: ${it.from ? `picked up in ${nice(it.from.place)}` : 'handed over'}. Click to open its icon`} onClick={() => onOpen?.(`item-${it.key}`)}>
              {it.icon ? <img src={fileUrl(slug, it.icon.file, it.icon.v)} alt="" /> : <span class="noicon">?</span>}
              <span>{it.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
type Item = { key: string; name: string; from: { place: string; thing: string } | null; icon: Pic };

/**
 * What the person has open, sent ahead of each message so "this" means something to the agent; never shown.
 * "[Looking at: …]" is the same from older conversations.
 */
export const screenPrefix = (on: string) => `[On screen: ${on}]\n`;
export const shownScreen = (text: string) => text.replace(/^\[(?:On screen|Looking at): [^\]]+\]\n?/, '');
