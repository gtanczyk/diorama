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

export function StyleMenu({ slug, places, version, onError }: { slug: string; places: string[]; version: number; onError: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<Styles | null>(null);
  const [style, setStyle] = useState('');
  const [scope, setScope] = useState('world');
  const [est, setEst] = useState<Estimate | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => void (open && call<Styles>('style_get', { slug }).then((s) => (setNow(s), setStyle((v) => v || s.style))).catch((e) => onError(e.message))), [open, slug, version]);
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
      if (go) (setOpen(false), setEst(null));
      else setEst(r);
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cast = Object.keys(now?.cast ?? {});
  return (
    <div class="share">
      <button type="button" class="ghost" aria-expanded={open} title="The style every place and character is painted in, and changing it: the pictures are repainted keeping where everything is. Shows the cost first" onClick={() => setOpen(!open)}>Style</button>
      {open && (
        <div class="share-menu style-menu" role="menu">
          <p class="menu-head">Painted in</p>
          <p class="detail">{now?.style ?? 'Reading the style…'}</p>
          {now?.kids && <p class="detail">Made from children's drawings: they stay the reference, so the children still know their things.</p>}
          <p class="menu-head">New style</p>
          <div class="row wrap">
            {PRESETS.map(([name, text]) => <button key={name} type="button" class={`${style === text ? 'primary' : 'ghost'} tiny`} title={text} onClick={() => setStyle(text)}>{name}</button>)}
          </div>
          <textarea rows={3} value={style} aria-label="New style" title="Medium, palette, light, in a few words. No artist names" onInput={(e) => setStyle(e.currentTarget.value)} />
          <select value={scope} aria-label="What to restyle" title="The whole world, one place, or the characters" onChange={(e) => setScope(e.currentTarget.value)}>
            <option value="world">The whole world</option>
            {places.map((p) => <option key={p} value={`place:${p}`}>Place: {p}</option>)}
            <option value="cast">All characters</option>
            {cast.map((k) => <option key={k} value={`cast:${k}`}>Character: {k}</option>)}
          </select>
          {est && <p class="detail">{est.line}</p>}
          <div class="row">
            <span class="grow" />
            {est
              ? <button type="button" class="primary small" disabled={busy} title={`Repaint now: ${est.line}. History takes it back`} onClick={() => ask(true)}>Restyle</button>
              : <button type="button" class="ghost small" disabled={busy || style.trim().length < 10 || style.trim() === now?.style} title="What it repaints and about what it costs. Free" onClick={() => ask(false)}>What it costs</button>}
          </div>
        </div>
      )}
    </div>
  );
}
