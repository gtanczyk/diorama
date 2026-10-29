// The world's look: the style it is painted in, and style_set to change it for the whole world, one place or the
// cast. It asks for the estimate first (what is repainted, the calls, the dollars), then runs it as one job.
import { useEffect, useState } from 'preact/hooks';
import { call } from './api.ts';

type Estimate = { estimate: { places: string[]; cast: string[]; models: string[]; sprites: string[] }; line: string; was: string; note?: string };
type Styles = { style: string; kids: boolean; places: Record<string, string | null>; cast: Record<string, string | null> };

const PRESETS: Array<[string, string]> = [
  ['Realistic painterly', 'realistic hand-painted oil painting, natural proportions, soft natural light and long gentle shadows, rich but muted palette, visible brushwork, no outlines'],
  ['Watercolour', 'loose watercolour with ink lines, soft washes and paper texture, light airy palette, gentle daylight'],
  ['Gouache storybook', 'matte gouache storybook illustration, simple rounded shapes, warm limited palette, soft even light'],
  ['Cartoon', 'bright flat cartoon with thick dark outlines, bold simple shapes, saturated colours, even sunny light'],
];

/** The world's style in its own drawer: what it is painted in now beside a picture of it, the presets as cards, a wide
 * field for your own words, what to repaint, and the cost before anything runs. */
export function StyleView({ slug, places, version, sample, onError, onDone }: { slug: string; places: string[]; version: number; sample?: string; onError: (m: string) => void; onDone: () => void }) {
  const [now, setNow] = useState<Styles | null>(null);
  const [style, setStyle] = useState('');
  const [scope, setScope] = useState('world');
  const [est, setEst] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void call<Styles>('style_get', { slug }).then((s) => (setNow(s), setStyle((v) => v || s.style))).catch((e) => onError(e.message)), [slug, version]);
  // A new style or scope needs a new estimate before it runs.
  useEffect(() => setEst(null), [style, scope]);
  const input = () => {
    const [kind, key] = scope.split(':');
    return { slug, style: style.trim(), scope: kind, ...(key && { key }) };
  };
  const ask = async (go: boolean) => {
    setBusy(true);
    try {
      const r = await call<Estimate>('style_set', { ...input(), go });
      if (go) (setEst(null), onDone());
      else setEst(r);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cast = Object.keys(now?.cast ?? {});
  return (
    <div class="style-view">
      <section class="sv-now">
        {sample && <img src={sample} alt="" data-lightbox={sample} title="Click: large" />}
        <div>
          <p class="menu-head">Painted in now</p>
          <p>{now?.style ?? 'Reading the style…'}</p>
          {now?.kids && <p class="detail">Made from children's drawings: they stay the reference, so the children still know their things.</p>}
        </div>
      </section>
      <p class="menu-head">A new style</p>
      <div class="sv-presets">
        {PRESETS.map(([name, text]) => (
          <button key={name} type="button" class={`sv-card${style === text ? ' on' : ''}`} title="Use this style: you can still change the words below" onClick={() => setStyle(text)}>
            <strong>{name}</strong>
            <span>{text}</span>
          </button>
        ))}
      </div>
      <label class="sv-words">Or in your own words (medium, palette, light; no artist names)
        <textarea rows={3} value={style} aria-label="New style" onInput={(e) => setStyle(e.currentTarget.value)} />
      </label>
      <div class="row wrap">
        <label>Repaint <select value={scope} aria-label="What to restyle" title="The whole world, one place, or the characters" onChange={(e) => setScope(e.currentTarget.value)}>
          <option value="world">the whole world</option>
          {places.map((p) => <option key={p} value={`place:${p}`}>place: {p}</option>)}
          <option value="cast">all characters</option>
          {cast.map((k) => <option key={k} value={`cast:${k}`}>character: {k}</option>)}
        </select></label>
        <span class="grow" />
        {est
          ? <button type="button" class="primary" disabled={busy} title={`Repaint now: ${est.line}. History takes it back`} onClick={() => ask(true)}>Restyle</button>
          : <button type="button" class="ghost" disabled={busy || style.trim().length < 10 || style.trim() === now?.style} title="What it repaints and about what it costs. Free" onClick={() => ask(false)}>{busy ? 'Counting…' : 'What it costs'}</button>}
      </div>
      {est && <p class="sv-est">{est.line}{est.note ? ` · ${est.note}` : ''}. Everything keeps its place; History takes it back.</p>}
    </div>
  );
}
