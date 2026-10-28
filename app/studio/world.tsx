// A world in the atelier: the conversation with the agent that looks after it, told in cards (the story, the
// places, the cast, what waits for you, what a turn changed, the game), beside a stage that shows what the
// card is about. Click a thing on the stage and it goes into the next message as "this".
import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';

export type StageView = { kind: 'build' | 'place' | 'cast' | 'story' | 'play'; place?: string };
export type Picked = { place?: string; thing: string; name: string };

type Pic = { file: string; v: number | null } | null;
export type CardPlace = { key: string; shows: string; image: Pic; stages: Record<string, number | null>; verdict: { ok: boolean } | null; trouble?: { why: string } | null };
type Character = { key: string; role: string; looksNow: string; figure: Pic };

/** A card in the conversation: what it shows decides the stage when clicked. */
export function Card({ kind, by, on, onClick, children, tone }: { kind: string; by?: string; on?: boolean; onClick?: () => void; children: ComponentChildren; tone?: 'ask' | 'play' }) {
  return (
    <div class={`wcard${on ? ' on' : ''}${tone ? ` ${tone}` : ''}${onClick ? ' click' : ''}`} onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => onClick && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), onClick())}>
      <div class="k">{kind}{by && <span class="by">{by}</span>}</div>
      {children}
    </div>
  );
}

const nice = (key: string) => key.replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase());
export { nice };

/** The places as small paintings; one not painted yet shows its name. */
export function PlacesCard({ slug, places, stage, onStage }: { slug: string; places: CardPlace[]; stage: StageView; onStage: (s: StageView) => void }) {
  return (
    <Card kind="Places" by="Muse Image · SAM 3.1" on={stage.kind === 'place'}>
      <div class="thumbs">
        {places.map((p) => (
          <button type="button" class={`thumb${stage.kind === 'place' && stage.place === p.key ? ' on' : ''}${p.trouble ? ' trouble' : p.verdict?.ok ? ' ready' : ''}`} title={`${nice(p.key)}: ${p.shows}${p.verdict?.ok ? ' (playable)' : ''}`} onClick={() => onStage({ kind: 'place', place: p.key })}
            style={p.image ? { backgroundImage: `url("${fileUrl(slug, p.image.file, p.image.v)}")` } : undefined}>
            {!p.image && <span>{nice(p.key)}</span>}
          </button>
        ))}
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
    <Card kind="Cast" by="Muse Image · 3D" on={stage.kind === 'cast'} onClick={() => onStage({ kind: 'cast' })}>
      <div class="lineup-mini">{shown.map((c) => <img src={fileUrl(slug, c.figure!.file, c.figure!.v)} alt={nice(c.key)} title={`${nice(c.key)}: ${c.looksNow}`} />)}</div>
    </Card>
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
 * The place as a framed painting. Every thing SAM cut out is a spot to point at: hovering lights up its mask,
 * a click puts it into the next message. "Fix by hand" opens the old tools for whoever wants them.
 */
export function PlaceStage({ slug, place, version, picked, onPick, children }: { slug: string; place: CardPlace; version: number; picked: Picked | null; onPick: (p: Picked) => void; children?: ComponentChildren }) {
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
          {place.image ? <img src={fileUrl(slug, place.image.file, place.image.v)} alt={place.shows} /> : <div class="empty"><strong>{nice(place.key)}</strong><span>Muse Image paints it next</span></div>}
          {(hover ?? (picked?.place === place.key ? picked.thing : null)) && (
            <div class="glow" style={{ maskImage: `url("${fileUrl(slug, `places/${place.key}/masks/${hover ?? picked!.thing}.png`)}")`, WebkitMaskImage: `url("${fileUrl(slug, `places/${place.key}/masks/${hover ?? picked!.thing}.png`)}")` }} />
          )}
          {spots.map(([key, t]) => {
            const [x0, y0, x1, y1] = t.box!;
            return (
              <button type="button" class={`spot${picked?.place === place.key && picked.thing === key ? ' picked' : ''}`} aria-label={`Talk about the ${nice(key).toLowerCase()}`}
                style={{ left: `${(x0 / 1200) * 100}%`, top: `${(y0 / 896) * 100}%`, width: `${((x1 - x0) / 1200) * 100}%`, height: `${((y1 - y0) / 896) * 100}%` }}
                onMouseEnter={() => setHover(key)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(key)} onBlur={() => setHover(null)}
                onClick={() => onPick({ place: place.key, thing: key, name: nice(key).toLowerCase() })}>
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

/** The cast standing in a row; a click puts them into the next message. */
export function CastStage({ slug, version, picked, onPick }: { slug: string; version: number; picked: Picked | null; onPick: (p: Picked) => void }) {
  const cast = useCast(slug, version);
  if (!cast) return <div class="mat"><p class="detail">Reading the cast…</p></div>;
  const shown = cast.filter((c) => c.figure);
  if (!shown.length) return <div class="mat"><p class="detail">Nobody is cast yet: the build paints them after the places.</p></div>;
  return (
    <div class="mat lineup">
      {shown.map((c) => (
        <button type="button" class={`who${picked && !picked.place && picked.thing === c.key ? ' picked' : ''}`} title={`${c.looksNow}. Click to talk about ${nice(c.key)}`} onClick={() => onPick({ thing: c.key, name: nice(c.key) })}>
          <img src={fileUrl(slug, c.figure!.file, c.figure!.v)} alt="" />
          <span>{nice(c.key)}{c.role === 'hero' ? ' · hero' : ''}</span>
        </button>
      ))}
    </div>
  );
}

/** The message prefix a pick adds, and how a sent message with one is shown again. */
export const pickPrefix = (p: Picked) => `[Looking at: ${p.place ? `${p.place} / ` : ''}${p.thing}]\n`;
export function shownPick(text: string): { pick: string | null; rest: string } {
  const m = /^\[Looking at: ([^\]]+)\]\n?/.exec(text);
  if (!m) return { pick: null, rest: text };
  const thing = m[1].split(' / ').at(-1)!;
  return { pick: nice(thing).toLowerCase(), rest: text.slice(m[0].length) };
}
