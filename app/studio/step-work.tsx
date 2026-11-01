// A world-wide build step at work, live: what it works from and what it made so far, card by card. Item icons show
// where SAM cuts each item from (the painting around it, the mask lit) and the icon once it lands; plates show what
// goes and the place without it; weather and reactions show each place and what was read for it; sounds list every
// sound to listen to. The build bar opens it from that step's segment.
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';
import { named } from './build.tsx';
import { nice } from './world.tsx';

type Pic = { file: string; v: number | null };
type Shot = { painting: Pic; box?: [number, number, number, number]; mask?: Pic; over?: Pic };
type WorkCard = { key: string; title: string; place?: string; from: Shot | null; made: Shot | Pic | null; words: string[]; at: number | null };
type Sound = { id: string; kind: string; prompt: string; state: string; file?: string; seconds?: number; rejected?: string };

/** The steps this view shows; the cast steps have their own (cast-work.tsx). */
export const WORK_STEPS = ['icons', 'plates', 'weather', 'reactions', 'sound'];
const WHAT: Record<string, string> = { icons: 'Item icons', plates: 'Change plates', weather: 'Weather', reactions: 'Reactions', sound: 'Sounds' };
const FROM: Record<string, string> = { icons: 'cut from', plates: 'what changes', weather: 'reads', reactions: 'reads' };
const MADE: Record<string, string> = { icons: 'icon', plates: 'after', weather: 'weather', reactions: 'reactions' };
const WAIT: Record<string, string> = {
  icons: 'Reading the story\'s items…', plates: 'Reading what the hero takes and what changes…', weather: 'Reading the places…', reactions: 'Reading the places…', sound: 'Reading the sound plan…',
};
const NONE: Record<string, string> = {
  icons: 'The story has no items to pick up, so no icons.', plates: 'Nothing is taken or changed in any place, so no plates.',
  weather: 'No places painted yet.', reactions: 'No places painted yet.', sound: 'No sound plan yet: the sound step writes it.',
};
const FRAME = { width: 1200, height: 896 };

const clock = (s: number) => `${Math.floor(Math.max(0, s) / 60)}:${String(Math.round(Math.max(0, s)) % 60).padStart(2, '0')}`;

/** A place's painting cropped to a box, the SAM mask over it (the rest dimmed), or a plate laid over it. */
function Crop({ slug, shot, alt, title }: { slug: string; shot: Shot; alt: string; title: string }) {
  const [x0, y0, x1, y1] = shot.box ?? [0, 0, 1, 1];
  const [bw, bh] = [x1 - x0, y1 - y0];
  const place = { width: `${100 / bw}%`, left: `${(-x0 / bw) * 100}%`, top: `${(-y0 / bh) * 100}%` };
  const big = fileUrl(slug, (shot.over ?? shot.painting).file, (shot.over ?? shot.painting).v);
  return (
    <div class="sw-crop" style={{ aspectRatio: `${bw * FRAME.width} / ${bh * FRAME.height}` }} data-lightbox={shot.over ? undefined : big} title={title}>
      <img class={shot.mask ? 'dim' : ''} style={place} src={fileUrl(slug, shot.painting.file, shot.painting.v)} alt={alt} />
      {shot.over && <img style={place} src={fileUrl(slug, shot.over.file, shot.over.v)} alt="" />}
      {/* What SAM cut out, lit: the painting again, seen only through its mask. */}
      {shot.mask && <img class="cut" style={{ ...place, maskImage: `url("${fileUrl(slug, shot.mask.file, shot.mask.v)}")` }} src={fileUrl(slug, shot.painting.file, shot.painting.v)} alt="" />}
    </div>
  );
}

const isShot = (x: Shot | Pic): x is Shot => 'painting' in x;

export function StepWorkStage({ slug, step, running, failed, since, took, version }: {
  slug: string; step: string; running: boolean; failed?: string; since?: number; took: number; version: number;
}) {
  const [cards, setCards] = useState<WorkCard[] | null>(null);
  const [sounds, setSounds] = useState<Sound[] | null>(null);
  useEffect(() => {
    if (step === 'sound') void call<Sound[]>('sound_status', { slug }).then(setSounds).catch(() => setSounds([]));
    else void call<WorkCard[]>('step_work', { slug, step }).then(setCards).catch(() => setCards([]));
  }, [slug, step, version]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const elapsed = since ? (now - since) / 1000 : 0;
  const left = took - elapsed;
  // While the step runs, a result older than its start is the earlier build's: it is being made again.
  const fresh = (at: number | null) => !!at && (!running || !since || at >= since);
  const list = step === 'sound' ? sounds : cards;
  const doneCount = step === 'sound' ? (sounds ?? []).filter((s) => s.state === 'made').length : (cards ?? []).filter((c) => c.made && fresh(c.at)).length;

  return (
    <div class="cast-work step-work" data-lightbox-group>
      <div class="cw-head">
        <strong>{WHAT[step] ?? step}</strong>
        <span class="detail">
          {running ? (since ? `${clock(elapsed)} so far · ${left > 5 ? `about ${clock(left)} left` : 'a little longer than usual'}` : 'starting…') : failed ? `stopped: ${failed}` : 'done'}
          {list && list.length > 0 ? ` · ${doneCount} of ${list.length} made` : ''}
        </span>
      </div>
      {list === null && <div class="cw-wait"><span>{WAIT[step] ?? 'Reading…'}</span></div>}
      {list !== null && list.length === 0 && <div class="cw-wait"><span>{NONE[step] ?? 'Nothing here.'}</span></div>}
      {step === 'sound' && sounds && sounds.length > 0 && (
        <ul class="sw-sounds">
          {sounds.map((s) => (
            <li class={s.state === 'made' ? 'ok' : s.state === 'rejected' ? 'fail' : ''}>
              <span class="kind">{s.kind}</span>
              <span class="what" title={s.prompt}><strong>{nice(s.id.replace(/^[a-z]+:/, ''))}</strong> <span class="detail">{s.prompt}</span></span>
              {s.state === 'made' && s.file
                ? <audio controls preload="none" src={fileUrl(slug, s.file, version)} title={`${s.seconds ?? ''} s. Free to listen`} />
                : <span class="detail">{s.state === 'rejected' ? `✕ ${s.rejected}` : running ? '○ waiting its turn' : `○ ${s.state}`}</span>}
            </li>
          ))}
        </ul>
      )}
      {step !== 'sound' && cards && cards.length > 0 && (
        <ul class="sw-cards">
          {cards.map((c) => {
            const made = c.made && fresh(c.at) ? c.made : null;
            // Weather and reactions: the words are what was read, so the earlier build's wait for this run's.
            const words = (step === 'weather' || step === 'reactions') && !made ? [] : c.words;
            return (
              <li class={made ? 'ok' : ''}>
                <div class="pair">
                  <figure>
                    {c.from
                      ? <Crop slug={slug} shot={c.from} alt={c.title} title={`${c.title}: ${step === 'icons' ? 'the painting where it is picked up; SAM\'s mask lit, the rest dimmed' : 'what the step works from'}. Click: large`} />
                      : <div class="sw-none">{named(step === 'icons' ? 'Muse Image paints it' : 'not painted yet')}</div>}
                    <figcaption>{FROM[step] ?? 'from'}</figcaption>
                  </figure>
                  {(step === 'icons' || step === 'plates') && (
                    <figure>
                      {made
                        ? isShot(made)
                          ? <Crop slug={slug} shot={made} alt={c.title} title={`${c.title}: ${MADE[step]}`} />
                          : <img class="sw-icon" src={fileUrl(slug, made.file, made.v)} data-lightbox={fileUrl(slug, made.file, made.v)} title={`${c.title}: the icon in the hero's bag. Click: large`} alt={c.title} />
                        : <div class={`to-come${failed || !running ? ' still' : ''}`} title={running ? 'Being made now' : 'Not made'} />}
                      <figcaption>{MADE[step]}</figcaption>
                    </figure>
                  )}
                </div>
                <div class="words">
                  <strong>{step === 'weather' || step === 'reactions' ? nice(c.title) : c.title}</strong>
                  {words.length
                    ? words.map((w) => <span class="detail">{named(w)}</span>)
                    : <span class="detail">{running ? '○ waiting its turn' : '○ not made'}</span>}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
