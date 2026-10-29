// A walk-cycle (or talking) sheet of the 3D figure for `diorama sprites`: one facing, the frames in a grid on a
// transparent canvas, each figure's feet at the same spot of its cell. Muse paints over it later.
import { Figure3D, type ModelInfo } from './hero3d.ts';

export type SheetAsk = { info: ModelInfo; base: string; yaw: number; cols: number; rows: number; width: number; height: number; feetAt: number; px: number; elevation: number;
  /** Talking: the gesture (index into src/play/gestures.ts) for each cell, in order; cells past the end stay empty. */
  gestures?: number[];
  /** Walk cycle length, independent of spare grid cells. Omitted: fill the grid (legacy guides). */
  frames?: number;
  /** Append a standing pose after the walk; remaining grid cells stay transparent. */
  stand?: boolean;
  /** Plain grey clay with one key light instead of the painted textures. */
  plain?: boolean };

let figure: Promise<Figure3D> | undefined;
const CLAY = { sky: 0xffffff, ground: 0x777777, ambient: 1.1, key: { dir: [-1, 2, 3] as [number, number, number], color: 0xffffff, intensity: 2.2 } };

(window as unknown as { renderSheet: (a: SheetAsk) => Promise<string> }).renderSheet = async (a) => {
  figure ??= Figure3D.load(a.info, (f) => `${a.base}/${f}`, 2);
  const fig = await figure;
  if (a.plain) fig.plain();
  const out = document.createElement('canvas');
  [out.width, out.height] = [a.width, a.height];
  const ctx = out.getContext('2d')!;
  const [cw, ch] = [a.width / a.cols, a.height / a.rows];
  const n = a.frames ?? a.cols * a.rows;
  const count = a.gestures?.length ?? n + (a.stand ? 1 : 0);
  if (!Number.isInteger(n) || n < 1 || count > a.cols * a.rows) throw new Error('Sprite poses do not fit the sheet');
  for (let i = 0; i < count; i++) {
    const c = fig.draw({ phase: i < n ? i / n : 0, walking: !a.gestures && i < n, time: 0, gesture: a.gestures?.[i], yaw: a.yaw, elevation: a.elevation, px: a.px, light: a.plain ? CLAY : undefined });
    const [x, y] = [(i % a.cols) * cw + cw / 2, Math.floor(i / a.cols) * ch + ch * a.feetAt];
    ctx.drawImage(c, x - c.width / 2, y - c.height * fig.feetAt);
  }
  return out.toDataURL('image/png');
};
