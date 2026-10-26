// A walk-cycle (or talking) sheet of the 3D figure for `diorama sprites`: one facing, the frames in a grid on a
// transparent canvas, each figure's feet at the same spot of its cell. Muse paints over it later.
import { Figure3D, type ModelInfo } from './hero3d.ts';

export type SheetAsk = { info: ModelInfo; base: string; yaw: number; cols: number; rows: number; width: number; height: number; feetAt: number; px: number; elevation: number;
  /** Talking: the gesture (index into src/play/gestures.ts) for each cell, in order; cells past the end stay empty. */
  gestures?: number[] };

let figure: Promise<Figure3D> | undefined;

(window as unknown as { renderSheet: (a: SheetAsk) => Promise<string> }).renderSheet = async (a) => {
  figure ??= Figure3D.load(a.info, (f) => `${a.base}/${f}`, 2);
  const fig = await figure;
  const out = document.createElement('canvas');
  [out.width, out.height] = [a.width, a.height];
  const ctx = out.getContext('2d')!;
  const [cw, ch] = [a.width / a.cols, a.height / a.rows];
  const n = a.cols * a.rows;
  for (let i = 0; i < (a.gestures?.length ?? n); i++) {
    const c = fig.draw({ phase: i / n, walking: !a.gestures, gesture: a.gestures?.[i], yaw: a.yaw, elevation: a.elevation, px: a.px });
    const [x, y] = [(i % a.cols) * cw + cw / 2, Math.floor(i / a.cols) * ch + ch * a.feetAt];
    ctx.drawImage(c, x - c.width / 2, y - c.height * fig.feetAt);
  }
  return out.toDataURL('image/png');
};
