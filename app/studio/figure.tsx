// What the runtime will move for a character, seen without opening the game: the 3D model turned by hand
// (walking, standing or talking with the same posing as the page), the 2D cut-out rig walking, and the
// sprite sheets Muse painted playing as loops. Everything loads only when the preview opens.
import { useEffect, useRef, useState } from 'preact/hooks';
import { GESTURES } from '../src/play/gestures.ts';
import { pose, sheetCell, type PartName, type Rig } from '../src/play/rig.ts';
import type { Figure3D, ModelInfo } from '../web/hero3d.ts';
import { fileUrl } from './api.ts';
import { named } from './build.tsx';

type Stamps = { rig: number | null; model: number | null; sprites: number | null };
type Facing = { sheet: string; yaw: number; stand?: number; off?: number[]; gestures?: string[] };
type SpriteInfo = { cols: number; rows: number; frames: number; facings: Record<string, Facing>; talk?: Record<string, Facing> };
type Mode = 'walk' | 'stand' | 'talk';

/** Seconds per walk cycle and per talking gesture: about what the game shows at a stroll. */
const STRIDE = 1.1;
const GESTURE = 1.4;
const TALL = 320;

const json = <T,>(url: string): Promise<T> => fetch(url).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${url}: ${r.status}`))));
async function image(src: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

/** Calls `draw` every animation frame with the seconds since the preview opened, until it unmounts. */
function useFrames(draw: (t: number) => void, deps: unknown[]) {
  useEffect(() => {
    const t0 = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      draw((now - t0) / 1000);
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, deps);
}

const FIGURE_TIPS = {
  model: 'The model that supplies the animation poses. Drag to turn it',
  rig: 'The painting itself, walking: bent by its bones as one piece, so clothes stretch and never tear',
  sprites: 'The generated sprites for each facing, looping',
};

export function FigurePreview({ slug, who, stamps, sides = true }: { slug: string; who: string; stamps: Stamps; sides?: boolean }) {
  const tabs = ([['sprites', 'Sprites'], ['rig', '2D walk'], ['model', '3D model']] as const).filter(([k]) => stamps[k]);
  const [tab, setTab] = useState(tabs[0]?.[0]);
  if (!tab) return <p class="detail">No animation yet. Build the character to generate its animation.</p>;
  return (
    <div class="figure-preview">
      <div class="tabs">
        {tabs.map(([k, label]) => <button type="button" class={`ghost small${tab === k ? ' on' : ''}`} title={FIGURE_TIPS[k]} onClick={() => setTab(k)}>{label}</button>)}
      </div>
      {tab === 'model' && <ModelView slug={slug} dir={`cast/${who}/model`} v={stamps.model} />}
      {tab === 'rig' && stamps.sprites && <p class="detail">The game walks this character with its sprites; this walk is the fallback.</p>}
      {tab === 'model' && <p class="detail">This model supplies the animation poses. The game uses its sprites when available.</p>}
      {tab === 'model' && sides && <Sides slug={slug} dir={`cast/${who}/model`} v={stamps.model} />}
      {tab === 'rig' && <RigView slug={slug} who={who} v={stamps.rig} />}
      {tab === 'sprites' && <SpritesView slug={slug} dir={`cast/${who}/sprites`} v={stamps.sprites} />}
    </div>
  );
}

/** The four painted sides the 3D body was built from, kept after the build; a click opens them large. */
export function Sides({ slug, dir, v }: { slug: string; dir: string; v: number | null }) {
  const [gone, setGone] = useState<string[]>([]);
  const sides = ['front', 'back', 'left', 'right'].filter((s) => !gone.includes(s));
  if (!sides.length) return null;
  return (
    <div class="fig-sides" data-lightbox-group>
      <span class="detail">{named('The 4 sides Muse Image painted for TRELLIS')}</span>
      <div class="row">
        {sides.map((s) => (
          <figure>
            <img src={fileUrl(slug, `${dir}/${s}.png`, v)} data-lightbox={fileUrl(slug, `${dir}/${s}.png`, v)} title="Click: large" alt={s} loading="lazy" onError={() => setGone((g) => [...g, s])} />
            <figcaption>{s}</figcaption>
          </figure>
        ))}
      </div>
    </div>
  );
}

function Modes({ modes, mode, set }: { modes: Mode[]; mode: Mode; set: (m: Mode) => void }) {
  return (
    <div class="tabs">
      {modes.map((m) => <button type="button" class={`ghost small${mode === m ? ' on' : ''}`} title={`Show the ${m} animation`} onClick={() => set(m)}>{m}</button>)}
    </div>
  );
}

/** The rigged model in its own WebGL canvas; drag turns it (and tilts the camera), left alone it turns slowly. */
function ModelView({ slug, dir, v }: { slug: string; dir: string; v: number | null }) {
  const host = useRef<HTMLDivElement>(null);
  const label = useRef<HTMLSpanElement>(null);
  const [fig, setFig] = useState<Figure3D | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('walk');
  const [spin, setSpin] = useState(true);
  const view = useRef({ yaw: 0.6, elevation: 0.18, drag: null as { x: number; y: number } | null, last: 0 });
  useEffect(() => {
    let gone = false;
    let loaded: Figure3D | undefined;
    const url = (f: string) => fileUrl(slug, `${dir}/${f}`, v);
    (async () => {
      const info = await json<ModelInfo>(url('model.json'));
      const { Figure3D } = await import('../web/hero3d.ts');
      loaded = await Figure3D.load(info, url);
      if (gone) return loaded.dispose();
      host.current!.append(loaded.canvas);
      setFig(loaded);
    })().catch((e) => !gone && setError((e as Error).message));
    return () => {
      gone = true;
      loaded?.canvas.remove();
      loaded?.dispose();
    };
  }, [slug, dir, v]);
  useFrames((t) => {
    if (!fig) return;
    const s = view.current;
    if (spin && !s.drag) s.yaw += Math.max(0, t - s.last) * 0.5;
    s.last = t;
    const gesture = mode === 'talk' ? Math.floor(t / GESTURE) % GESTURES.length : undefined;
    // A creature has no arms for gestures: it bounces on its words.
    if (label.current) label.current.textContent = gesture === undefined || fig.creatureBody ? '' : GESTURES[gesture].name;
    try {
      const c = fig.draw({ phase: t / STRIDE, walking: mode === 'walk', gesture, yaw: s.yaw, elevation: s.elevation, px: TALL * devicePixelRatio, time: t });
      c.style.height = `${(c.height / devicePixelRatio).toFixed(0)}px`;
    } catch (e) {
      fig.canvas.remove();
      setError((e as Error).message);
      setFig(null);
    }
  }, [fig, mode, spin]);
  const drag = {
    onPointerDown: (e: PointerEvent) => ((view.current.drag = { x: e.clientX, y: e.clientY }), (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)),
    onPointerMove: (e: PointerEvent) => {
      const s = view.current;
      if (!s.drag) return;
      s.yaw += (e.clientX - s.drag.x) * 0.012;
      s.elevation = Math.max(-0.2, Math.min(1.2, s.elevation + (e.clientY - s.drag.y) * 0.006));
      s.drag = { x: e.clientX, y: e.clientY };
    },
    onPointerUp: () => void (view.current.drag = null),
  };
  return (
    <div class="moves">
      <div class="row">
        <Modes modes={['walk', 'stand', 'talk']} mode={mode} set={setMode} />
        <label class="detail" title="Keep turning the model round by itself"><input type="checkbox" checked={spin} onChange={(e) => setSpin(e.currentTarget.checked)} /> turn</label>
        <span class="grow" />
        <span class="detail" ref={label} />
      </div>
      <div class="turntable" ref={host} {...drag} title="Drag to turn">
        {!fig && <span class="detail">{error ?? 'Loading the model…'}</span>}
      </div>
    </div>
  );
}

/** The cut-out rig (rig.json and its part images) posed by src/play/rig.ts, as the 2D page draws it. */
function RigView({ slug, who, v }: { slug: string; who: string; v: number | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [rig, setRig] = useState<{ rig: Rig; parts: Map<PartName, HTMLImageElement>; sheet?: HTMLImageElement } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>('walk');
  useEffect(() => {
    let gone = false;
    (async () => {
      const r = await json<Rig>(fileUrl(slug, `cast/${who}/rig.json`, v));
      const parts = new Map<PartName, HTMLImageElement>();
      await Promise.all(r.parts.map(async (p) => parts.set(p.name, await image(fileUrl(slug, `cast/${who}/${p.file}`, v)))));
      const sheet = r.sheet ? await image(fileUrl(slug, `cast/${who}/${r.sheet.file}`, v)) : undefined;
      if (!gone) setRig({ rig: r, parts, sheet });
    })().catch((e) => !gone && setError((e as Error).message));
    return () => void (gone = true);
  }, [slug, who, v]);
  useFrames((t) => {
    const c = canvas.current?.getContext('2d');
    if (!rig || !c) return;
    [c.canvas.width, c.canvas.height] = rig.rig.size;
    const sheet = rig.rig.sheet;
    if (sheet && rig.sheet) {
      const i = sheetCell(sheet, t / STRIDE, mode === 'walk');
      const [cw, ch] = sheet.cell;
      c.drawImage(rig.sheet, (i % sheet.cols) * cw, Math.floor(i / sheet.cols) * ch, cw, ch, 0, 0, c.canvas.width, c.canvas.height);
    } else {
      const at = pose(rig.rig, t / STRIDE, mode === 'walk');
      for (const part of rig.rig.parts) {
        const img = rig.parts.get(part.name);
        const p = at[part.name];
        if (!img || !p) continue;
        c.save();
        c.translate(p.to[0], p.to[1]);
        c.rotate(p.turn);
        c.translate(-p.from[0], -p.from[1]);
        c.drawImage(img, part.at[0], part.at[1]);
        c.restore();
      }
    }
    c.fillStyle = 'rgba(255,255,255,0.25)';
    c.fillRect(0, rig.rig.ground, c.canvas.width, 2);
  }, [rig, mode]);
  return (
    <div class="moves">
      <Modes modes={['walk', 'stand']} mode={mode} set={setMode} />
      {rig?.rig.check && !rig.rig.check.ok && <p class="detail">This walk tore when it was made ({rig.rig.check.why}), so the game slides the painted figure as one piece.</p>}
      {rig && !rig.rig.sheet && <p class="detail">An old cut-out rig: run `diorama rig {slug}` (no Muse calls) for a walk that does not tear.</p>}
      {rig ? <canvas ref={canvas} class="rig" /> : <span class="detail">{error ?? 'Loading the rig…'}</span>}
    </div>
  );
}

/** Every painted sheet as a loop: the walk facings (left ones are these mirrored in the game) and the talking cells. */
function SpritesView({ slug, dir, v }: { slug: string; dir: string; v: number | null }) {
  const [sheets, setSheets] = useState<Array<{ name: string; talk: boolean; f: Facing; img: HTMLImageElement }> | null>(null);
  const [info, setInfo] = useState<SpriteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Walk, stand or talk: each shows only its own sheets (an NPC who only speaks has talk sheets and no walk).
  const [picked, setMode] = useState<Mode | null>(null);
  useEffect(() => {
    let gone = false;
    (async () => {
      const i = await json<SpriteInfo>(fileUrl(slug, `${dir}/sprites.json`, v));
      const list = [...Object.entries(i.facings ?? {}).map(([name, f]) => ({ name, talk: false, f })), ...Object.entries(i.talk ?? {}).map(([name, f]) => ({ name: `talk ${name}`, talk: true, f }))];
      const loaded = await Promise.all(list.map(async (s) => ({ ...s, img: await image(fileUrl(slug, `${dir}/${s.f.sheet}`, v)) })));
      if (!gone) (setInfo(i), setSheets(loaded));
    })().catch((e) => !gone && setError((e as Error).message));
    return () => void (gone = true);
  }, [slug, dir, v]);
  const canvases = useRef<Array<HTMLCanvasElement | null>>([]);
  const labels = useRef<Array<HTMLSpanElement | null>>([]);
  const modes: Mode[] = sheets ? [...(sheets.some((s) => !s.talk) ? ['walk', 'stand'] as Mode[] : []), ...(sheets.some((s) => s.talk) ? ['talk'] as Mode[] : [])] : [];
  const mode: Mode | undefined = picked && modes.includes(picked) ? picked : modes[0];
  const walking = mode === 'walk';
  const shown = (sheets ?? []).filter((s) => s.talk === (mode === 'talk'));
  useFrames((t) => {
    if (!info || !sheets) return;
    shown.forEach((s, k) => {
      const c = canvases.current[k]?.getContext('2d');
      if (!c) return;
      const [cw, ch] = [s.img.width / info.cols, s.img.height / info.rows];
      [c.canvas.width, c.canvas.height] = [cw, ch];
      let cell: number;
      if (s.talk) {
        const n = s.f.gestures?.length ?? 1;
        cell = Math.floor(t / GESTURE) % n;
        if (labels.current[k]) labels.current[k]!.textContent = s.f.gestures?.[cell] ?? '';
      } else {
        const steps = [...Array(info.frames).keys()].filter((i) => !s.f.off?.includes(i));
        cell = walking ? steps[Math.floor(((t / STRIDE) % 1) * steps.length) % steps.length] : s.f.stand ?? 0;
      }
      c.drawImage(s.img, (cell % info.cols) * cw, Math.floor(cell / info.cols) * ch, cw, ch, 0, 0, cw, ch);
    });
  }, [info, sheets, mode]);
  if (!sheets) return <span class="detail">{error ?? 'Loading the sheets…'}</span>;
  return (
    <div class="moves">
      {mode && <Modes modes={modes} mode={mode} set={setMode} />}
      {info && mode !== 'talk' && sheets.some((s) => !s.talk) && <p class="detail">{info.frames} frames per walking direction</p>}
      {!sheets.some((s) => !s.talk) && <p class="detail">No walk sheets: this character only talks in the game, so only talking was drawn.</p>}
      <ul class="sheets">
        {shown.map((s, k) => (
          <li key={s.name}>
            <canvas ref={(el) => void (canvases.current[k] = el)} data-lightbox={fileUrl(slug, `${dir}/${s.f.sheet}`, v)} title="Click: the whole sheet, large" />
            <span class="detail">{s.name} <span ref={(el) => void (labels.current[k] = el)} /></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const MOUTH_SAYS: Record<string, string> = { X: 'rest', A: 'M B P', B: 'teeth (S, K)', C: 'EH', D: 'AH', E: 'OH', F: 'OO', G: 'F V', H: 'L' };

/** The mouth shapes a character speaks with (cast/<key>/face.json atlas), each cut out with what it says. */
export function MouthShapes({ slug, who, v }: { slug: string; who: string; v?: number | null }) {
  const [face, setFace] = useState<{ img: HTMLImageElement; views: Array<[string, Record<string, [number, number, number, number]>]>; file: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let gone = false;
    (async () => {
      const info = await json<{ image: string; mouths: Record<string, [number, number, number, number]>; atlases?: Record<string, Record<string, [number, number, number, number]>> }>(fileUrl(slug, `cast/${who}/face.json`, v));
      const file = `cast/${who}/${info.image}`;
      const img = await image(fileUrl(slug, file, v));
      // Mouth patches in atlas pixels: the painting's own (mouths), then one set per sprite view that has its own heads.
      const views: Array<[string, Record<string, [number, number, number, number]>]> = [['painting', info.mouths], ...Object.entries(info.atlases ?? {}).filter(([, m]) => Object.keys(m).length)];
      if (!gone) setFace({ img, file, views: views.filter(([, m]) => m && Object.keys(m).length) });
    })().catch((e) => !gone && setError((e as Error).message));
    return () => void (gone = true);
  }, [slug, who, v]);
  if (!face) return <span class="detail">{error ? `No mouth shapes to show: ${error}` : 'Loading the mouth shapes…'}</span>;
  return (
    <div class="mouths">
      {face.views.map(([view, boxes]) => (
        <div>
          {face.views.length > 1 && <span class="detail">{view}</span>}
          <ul class="sheets">
            {Object.entries(boxes).map(([m, [x, y, w, h]]) => (
              <li key={`${view}-${m}`}>
                <canvas width={w} height={h} style={`width:${Math.min(120, w)}px;height:auto`} ref={(el) => el?.getContext('2d')?.drawImage(face.img, x, y, w, h, 0, 0, w, h)}
                  data-lightbox={fileUrl(slug, face.file, v)} title={`${m}: ${MOUTH_SAYS[m] ?? ''}. Click: the whole atlas`} />
                <span class="detail">{m} · {MOUTH_SAYS[m] ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
