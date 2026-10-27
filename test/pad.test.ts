import { afterEach, describe, expect, it, vi } from 'vitest';
import { microButtons, readEachPad } from '../web/pad.ts';

// The 8BitDo Micro as browsers report it, after the gamedev.pl site's own tests.
function micro(index: number, pressed: number[] = [], hat = 9 / 7): Gamepad {
  return {
    id: '8BitDo Micro gamepad (Vendor: 2dc8 Product: 9020)',
    index,
    connected: true,
    mapping: '',
    axes: [-1 / 255, -1 / 255, -1 / 255, 0, -1, -1 / 255, 0, 0, 0, hat],
    buttons: Array.from({ length: 16 }, (_, n) => ({ pressed: pressed.includes(n), value: pressed.includes(n) ? 1 : 0 })),
  } as unknown as Gamepad;
}
const on = (slots: boolean[] | undefined) => slots?.flatMap((b, i) => (b ? [i] : []));

afterEach(() => vi.unstubAllGlobals());

describe('8BitDo Micro', () => {
  it('puts D-input buttons in the standard slots by face position, idle when nothing is held', () => {
    expect(on(microButtons(micro(0)))).toEqual([]);
    // Raw 1 is A, 0 is B, 4 X, 3 Y, 11 Start, 7 R; the hat at -1 is up.
    expect(on(microButtons(micro(0, [1, 0, 4, 3, 11, 7], -1)))).toEqual([0, 1, 2, 3, 5, 9, 12]);
  });

  it('reads the cross from axes 0/1 (Chrome on a Mac) when the hat is let go', () => {
    const raw = micro(0);
    expect(on(microButtons({ ...raw, axes: [1, ...raw.axes.slice(1)] }))).toEqual([15]);
  });

  it('reads the MFi profile and leaves other pads alone', () => {
    const mfi = { ...micro(3), axes: [], buttons: Array.from({ length: 15 }, (_, n) => ({ pressed: [10, 13].includes(n), value: 0 })) } as unknown as Gamepad;
    expect(on(microButtons(mfi))).toEqual([5, 12]);
    expect(microButtons({ ...micro(1), id: 'Unknown raw pad' })).toBeUndefined();
    expect(microButtons({ ...micro(1), mapping: 'standard' })).toBeUndefined();
  });

  it('walks and uses on the play page: d-pad right walks right, A uses', () => {
    let pad = micro(0);
    vi.stubGlobal('navigator', { getGamepads: () => [pad] });
    expect(readEachPad().get(0)).toEqual({ dir: null, pressed: [], pads: 1 });
    pad = { ...micro(0, [1]), axes: [1, ...micro(0).axes.slice(1)] } as unknown as Gamepad;
    const f = readEachPad().get(0)!;
    expect(f.dir).toEqual([1, 0]);
    expect(f.pressed).toEqual(expect.arrayContaining(['use', 'right']));
  });
});
