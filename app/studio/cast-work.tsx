// A cast step at work, live: who is being painted, modelled or drawn as sprites, each picture as it lands, the
// stage it is at (TRELLIS, skeleton) and the time left; when one is done, it moves right there.
import { useEffect, useState } from 'preact/hooks';
import { call, fileUrl } from './api.ts';
import { FigurePreview, Sides } from './figure.tsx';
import { nice } from './world.tsx';
import { named, nowBy } from './build.tsx';
import { Icon } from './icons.tsx';

/** Per character: the files the running job wrote (world path → when) and what the build last said about them. */
export type CastWork = Record<string, { files: Record<string, number>; said: string; at: number; first: number }>;
export const CAST_STEPS = ['cast', 'model', 'sprites', 'faces'];

const FILE = /^cast\/([a-z0-9][\w-]*)(-painting\.png|\.png|\/model\/[\w-]+\.(?:png|json)|\/sprites\/[\w-]+\.(?:png|json)|\/face-[\w-]+\.(?:png|json)|\/face-work\/[\w-]+\.png)$/;
/** A file the cast steps write, as [character, step]. */
export function castFile(file: string): [string, string] | null {
  const m = FILE.exec(file);
  if (!m) return null;
  return [m[1], m[2].startsWith('/model/') ? 'model' : m[2].startsWith('/sprites/') ? 'sprites' : m[2].startsWith('/face') ? 'faces' : 'cast'];
}
/** A build line about one character ("hero: TRELLIS builds the body", "hero walk right: take 2 …"), as [character, words]. */
export function castLine(line: string): [string, string] | null {
  const m = /^([a-z0-9][\w-]*)((?: (?:walk|talk) [\w-]+(?: \[[^\]]*\])?)?): (.+)$/.exec(line.trim());
  return m ? [m[1], `${m[2].trim() ? `${m[2].trim()}: ` : ''}${m[3]}`] : null;
}

const VIEWS = ['front', 'back', 'left', 'right'];
const STAGES = [
  { word: '4 sides', by: 'Muse Image', tip: 'Muse Image paints the character from the front, back and both sides', s: 40 },
  { word: 'Body', by: 'TRELLIS', tip: 'TRELLIS builds a 3D body from the four sides (Hugging Face GPU)', s: 30 },
  { word: 'Skeleton', by: 'auto-rig', tip: 'A skeleton is fitted into the body so it can walk', s: 25 },
];
const WHAT: Record<string, string> = { cast: 'Painting the cast', model: 'Building 3D models', sprites: 'Painting sprites', faces: 'Preparing talking faces' };
/** The newest face picture the faces step wrote for one character: the mouth shapes so far. */
const newestFace = (key: string, w: CastWork[string]) => Object.entries(w.files).filter(([f]) => f.startsWith(`cast/${key}/face`) && f.endsWith('.png') && !f.endsWith('-reference.png')).sort((a, b) => b[1] - a[1])[0];

type Who = { key: string; role: string; looksNow: string; figure: { file: string; v: number } | null; painting: { file: string; v: number } | null; stamps: { rig: number | null; model: number | null; sprites: number | null }; body: { upright: boolean } | null };

const clock = (s: number) => (s < 60 ? `${Math.max(1, Math.round(s))} s` : `${Math.floor(s / 60)} min ${String(Math.round(s % 60)).padStart(2, '0')} s`);

/** Where one character is in this step: the stage index (STAGES for a model), done, or failed. */
function where(step: string, key: string, w: CastWork[string]) {
  const has = (f: string) => w.files[f] !== undefined;
  if (step === 'model') {
    if (has(`cast/${key}/model/model.json`)) return { at: STAGES.length, done: true };
    if (/no 3D model/.test(w.said)) return { at: STAGES.length, done: true, failed: w.said.replace(/^no 3D model: /, '') };
    return { at: /rigging/.test(w.said) ? 2 : /TRELLIS/.test(w.said) ? 1 : 0, done: false };
  }
  if (step === 'sprites') return { at: 0, done: has(`cast/${key}/sprites/sprites.json`) };
  if (step === 'faces') return { at: 0, done: has(`cast/${key}/face-attempt.json`) || /face (prepared|unchanged)/.test(w.said) };
  return { at: 0, done: has(`cast/${key}.png`) && /\.png · /.test(w.said) };
}

/** The pictures of this step for one character, landed or still to come. */
function slots(step: string, key: string, w: CastWork[string]): Array<{ name: string; file?: string; v?: number }> {
  if (step === 'model') return VIEWS.map((v) => ({ name: v, file: w.files[`cast/${key}/model/${v}.png`] ? `cast/${key}/model/${v}.png` : undefined, v: w.files[`cast/${key}/model/${v}.png`] }));
  if (step === 'sprites') {
    const painted = Object.keys(w.files).filter((f) => /\/sprites\/(?:talk-)?painted-[\w-]+\.png$/.test(f));
    return painted.length ? painted.map((f) => ({ name: f.split('/').at(-1)!.replace(/\.png$/, '').replace('painted-', ''), file: f, v: w.files[f] })) : [{ name: 'walk' }];
  }
  if (step === 'faces') {
    // What it works from (the painted figure) and the mouth shapes as they are painted and checked.
    const atlas = newestFace(key, w);
    return [{ name: 'works from', file: `cast/${key}.png`, v: 0 }, { name: 'mouth shapes', file: atlas?.[0], v: atlas?.[1] }];
  }
  return [`cast/${key}-painting.png`, `cast/${key}.png`].map((f, i) => ({ name: i ? 'cut out' : 'painted', file: w.files[f] ? f : undefined, v: w.files[f] }));
}

export function CastWorkStage({ slug, step, work, running, failed, since, took, version, only, onOpen }: {
  slug: string; step: string; work: CastWork; running: boolean; since?: number; took: number; version: number;
  /** Why the step stopped, in plain words, when it failed. */
  failed?: string;
  /** The character a job of one was started for (cast_animate, cast_redo). */
  only?: string;
  onOpen: (key: string) => void;
}) {
  const [cast, setCast] = useState<Who[] | null>(null);
  useEffect(() => void call<Who[]>('cast_status', { slug }).then(setCast).catch(() => setCast([])), [slug, version]);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const known = new Set((cast ?? []).map((c) => c.key));
  // Who this step touched, newest first; a job for one character shows that one from the start.
  const keys = Object.entries(work)
    .filter(([k, w]) => known.has(k) && (Object.keys(w.files).some((f) => castFile(f)?.[1] === step) || (step === 'model' && /sides|TRELLIS|rigging|3D model/.test(w.said)) || (step === 'faces' && /face|mouth|facial|lips/.test(w.said))))
    .sort((a, b) => b[1].at - a[1].at).map(([k]) => k);
  if (only && known.has(only) && !keys.includes(only)) keys.unshift(only);
  const [pick, setPick] = useState<string | null>(null);
  const focus = pick && keys.includes(pick) ? pick : keys[0];
  const empty = { files: {}, said: '', at: 0, first: 0 };
  const elapsed = since ? (now - since) / 1000 : 0;
  // A job for one character takes about one character's time, not the build's whole model step.
  const left = Math.max(0, (only && step === 'model' ? STAGES.reduce((sum, x) => sum + x.s, 0) : took) - elapsed);

  return (
    <div class="cast-work" data-lightbox-group>
      <div class="cw-head">
        <strong>{WHAT[step] ?? step}</strong>
        <span class="detail">
          {running ? (since ? `${clock(elapsed)} so far · ${left > 5 ? `about ${clock(left)} left` : 'a little longer than usual'}` : 'starting…') : failed ? `stopped: ${failed}` : 'done'}
          {keys.length > 1 ? ` · ${keys.length} characters` : ''}
        </span>
      </div>
      {!focus && step === 'faces' && cast && cast.some((c) => c.figure) && (
        // Before the first mouth lands: who will get a talking face, from the figures it works from.
        <div class="cw-slots">
          {cast.filter((c) => c.figure).map((c) => (
            <figure class="in">
              <img src={fileUrl(slug, c.figure!.file, c.figure!.v)} data-lightbox={fileUrl(slug, c.figure!.file, c.figure!.v)} title={`${nice(c.key)}: its mouth shapes are painted from this figure. Click: large`} alt={c.key} />
              <figcaption>{nice(c.key)}</figcaption>
            </figure>
          ))}
        </div>
      )}
      {!focus && (step !== 'faces' || !cast?.some((c) => c.figure)) && <div class="cw-wait"><span>{cast === null ? 'Reading the cast…' : named(step === 'model' ? 'Muse Image is about to paint the first character from four sides…' : step === 'sprites' ? 'Muse Image is about to paint the first sprite sheet…' : step === 'faces' ? 'Muse Image is about to paint the first mouth shapes…' : 'Muse Image is painting the cast…')}</span></div>}
      {focus && (() => {
        const w = work[focus] ?? empty;
        const c = cast?.find((x) => x.key === focus);
        const st = { ...where(step, focus, w), ...(failed && !where(step, focus, w).done && { stopped: true }) } as ReturnType<typeof where> & { stopped?: boolean };
        const mine = w.first ? (now - w.first) / 1000 : 0;
        return (
          <section class={`cw-focus${st.done ? ' done' : ''}`}>
            <div class="cw-who">
              {c?.figure ? <img src={fileUrl(slug, c.figure.file, w.files[c.figure.file] ?? c.figure.v)} data-lightbox={fileUrl(slug, c.figure.file, w.files[c.figure.file] ?? c.figure.v)} title="Click: large" alt="" /> : <div class="noimg" />}
              <div class="cw-text">
                <h3>{nice(focus)}{c?.role === 'hero' ? ' · hero' : ''}</h3>
                <span class="detail">{st.stopped ? `Stopped at: ${w.said || 'the start'}` : st.failed ? `No 3D model: ${st.failed}` : st.done ? (step === 'model' ? 'The 3D model is ready' : 'Done') : w.said || 'waiting for the first picture…'}{!st.done && !st.stopped && mine > 1 ? ` · ${clock(mine)}` : ''}</span>
                {step === 'model' && (
                  <ol class="cw-stages">
                    {STAGES.map((s, i) => <li class={i < st.at ? 'ok' : i === st.at && !st.done ? (st.stopped ? 'stop' : 'on') : ''} title={named(s.tip)}>{i < st.at ? '✓' : i === st.at && !st.done ? (st.stopped ? '✕' : '●') : '○'} {s.word} <small>{nowBy(s.by)}</small></li>)}
                  </ol>
                )}
                <div class="row">
                  {st.done && c && (c.stamps.model || c.stamps.rig || c.stamps.sprites) && <button type="button" class="ghost small" title="Looks, voice, 3D model and sprites of this character. Free to look" onClick={() => onOpen(focus)}><Icon name="pencil" /> Details</button>}
                </div>
              </div>
            </div>
            {step !== 'faces' && st.done && c && (c.stamps.model || c.stamps.sprites || c.stamps.rig)
              ? <>
                  {/* The sides stay in sight after the step: what TRELLIS built the body from. */}
                  {step === 'model' && c.stamps.model && <Sides slug={slug} dir={`cast/${focus}/model`} v={c.stamps.model} />}
                  <FigurePreview key={`${focus}-${c.stamps.model}-${c.stamps.sprites}`} slug={slug} who={focus} stamps={c.stamps} sides={step !== 'model'} />
                </>
              : (
                <div class="cw-slots">
                  {slots(step, focus, w).map((s) => s.name === 'works from' && c?.figure ? { ...s, file: c.figure.file, v: c.figure.v } : s).map((s) => (
                    <figure class={s.file ? 'in' : ''}>
                      {s.file ? <img src={fileUrl(slug, s.file, s.v)} data-lightbox={fileUrl(slug, s.file, s.v)} title="Click: large" alt={s.name} /> : <div class={`to-come${failed ? ' still' : ''}`} />}
                      <figcaption>{s.name}</figcaption>
                    </figure>
                  ))}
                </div>
              )}
          </section>
        );
      })()}
      {keys.length > 1 && (
        <ul class="cw-others" aria-label="Others in this step">
          {keys.filter((k) => k !== focus).map((k) => {
            const w = work[k] ?? empty;
            const c = cast?.find((x) => x.key === k);
            const st = where(step, k, w);
            return (
              <li>
                <button type="button" class="ghost" title={`Watch ${nice(k)}`} onClick={() => setPick(k)}>
                  {c?.figure ? <img src={fileUrl(slug, c.figure.file, w.files[c.figure.file] ?? c.figure.v)} alt="" /> : <span class="noimg" />}
                  <span>{nice(k)}</span>
                  <small>{st.failed ? '✕ no model' : st.done ? '✓ done' : step === 'model' ? `● ${STAGES[st.at].word}` : '● working'}</small>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
