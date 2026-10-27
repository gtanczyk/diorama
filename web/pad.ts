// Gamepads on the play page: read every frame through the Gamepad API, so a child can play with a pad alone.
// One pad or six, they all steer the same hero; a press is reported once, on the frame it goes down.

export type Point = [number, number];
/** What a press means on the page, whatever pad and layout it came from. */
export type PadButton = 'use' | 'back' | 'next' | 'prev' | 'start' | 'up' | 'down' | 'left' | 'right';

/** Where the stick or d-pad points, one of eight ways, or null; and the presses that began this frame. */
export type PadFrame = { dir: Point | null; pressed: PadButton[]; pads: number };

// The standard layout (Xbox names): A 0, B 1, X 2, Y 3, LB 4, RB 5, LT 6, RT 7, select 8, start 9, d-pad 12-15.
const STANDARD: Array<[number, PadButton]> = [[0, 'use'], [1, 'back'], [2, 'prev'], [3, 'next'], [4, 'prev'], [5, 'next'], [6, 'prev'], [7, 'next'], [9, 'start'], [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
// A pad the browser does not map (an 8BitDo in D-input on a Mac): the face buttons come first, in no fixed order, so the
// two lowest both use (a child presses whichever), the rest go through the bag (its last step is empty hands), and the
// highest start.
const LOOSE: Array<[number, PadButton]> = [[0, 'use'], [1, 'use'], [2, 'next'], [3, 'next'], [4, 'next'], [5, 'prev'], [6, 'prev'], [7, 'next'], [8, 'prev'], [9, 'next'], [10, 'start'], [11, 'start']];
const DEAD = 0.4;

const seen = new Map<number, Set<PadButton>>();

/** Reads all connected pads once; call it each frame. */
export function readPads(): PadFrame {
  const pressed = new Set<PadButton>();
  let [dx, dy] = [0, 0];
  let pads = 0;
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad?.connected) continue;
    pads++;
    const down = new Set<PadButton>();
    const map = pad.mapping === 'standard' ? STANDARD : LOOSE;
    for (const [i, b] of map) if (pad.buttons[i]?.pressed) down.add(b);
    // The left stick, then the d-pad as buttons, then a d-pad reported as one "hat" axis (D-input pads).
    let [x, y] = [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
    if (Math.hypot(x, y) < DEAD) [x, y] = [0, 0];
    if (down.has('left')) x = -1;
    if (down.has('right')) x = 1;
    if (down.has('up')) y = -1;
    if (down.has('down')) y = 1;
    const hat = pad.mapping === 'standard' ? undefined : hatDir(pad.axes[9]);
    if (hat) [x, y] = hat;
    // Directions as presses too, for moving through answer cards.
    if (x < -0.5) down.add('left');
    if (x > 0.5) down.add('right');
    if (y < -0.5) down.add('up');
    if (y > 0.5) down.add('down');
    const was = seen.get(pad.index) ?? new Set();
    for (const b of down) if (!was.has(b)) pressed.add(b);
    seen.set(pad.index, down);
    [dx, dy] = [dx + x, dy + y];
  }
  const dir: Point | null = Math.hypot(dx, dy) < DEAD ? null : eighth(dx, dy);
  return { dir, pressed: [...pressed], pads };
}

/** The nearest of the eight ways (straight or diagonal), so a wobbly thumb does not turn the hero every frame. */
function eighth(x: number, y: number): Point {
  const a = Math.round(Math.atan2(y, x) / (Math.PI / 4)) * (Math.PI / 4);
  return [Math.round(Math.cos(a)), Math.round(Math.sin(a))];
}

/** A hat axis: -1 up, then clockwise in steps of 2/7 to 1 up-left; anything above that is let go. */
function hatDir(v: number | undefined): Point | null {
  if (v === undefined || v > 1.05 || v < -1.05) return null;
  const step = Math.round((v + 1) / (2 / 7));
  return ([[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]] as Point[])[step] ?? null;
}
