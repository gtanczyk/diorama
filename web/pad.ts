// Gamepads on the play page: read every frame through the Gamepad API, so a child can play with a pad alone.
// One pad or six, they all steer the same hero; a press is reported once, on the frame it goes down.

export type Point = [number, number];
/** What a press means on the page, whatever pad and layout it came from. */
export type PadButton = 'use' | 'back' | 'next' | 'prev' | 'start' | 'up' | 'down' | 'left' | 'right';

/** Where the stick or d-pad points, one of eight ways, or null; and the presses that began this frame. */
export type PadFrame = { dir: Point | null; pressed: PadButton[]; pads: number };

// The standard layout (Xbox names): A 0, B 1, X 2, Y 3, LB 4, RB 5, LT 6, RT 7, select 8, start 9, d-pad 12-15.
const STANDARD: Array<[number, PadButton]> = [[0, 'use'], [1, 'back'], [2, 'prev'], [3, 'next'], [4, 'prev'], [5, 'next'], [6, 'prev'], [7, 'next'], [9, 'start'], [12, 'up'], [13, 'down'], [14, 'left'], [15, 'right']];
// Another pad the browser does not map: the face buttons come first, in no fixed order, so the two lowest both use (a
// child presses whichever), the rest go through the bag (its last step is empty hands), and the highest start.
const LOOSE: Array<[number, PadButton]> = [[0, 'use'], [1, 'use'], [2, 'next'], [3, 'next'], [4, 'next'], [5, 'prev'], [6, 'prev'], [7, 'next'], [8, 'prev'], [9, 'next'], [10, 'start'], [11, 'start']];
const DEAD = 0.4;
const IDLE_S = 25;

const seen = new Map<number, Set<PadButton>>();

/** Reads every connected pad once, by gamepad index; call it once a frame (presses are edges since the last call). */
export function readEachPad(): Map<number, PadFrame> {
  const out = new Map<number, PadFrame>();
  for (const pad of navigator.getGamepads?.() ?? []) {
    if (!pad?.connected) continue;
    const down = new Set<PadButton>();
    // The 8BitDo Micro (D-input or the Mac's MFi profile) is seen as a standard pad, its buttons by face position.
    const micro = microButtons(pad);
    const map = pad.mapping === 'standard' || micro ? STANDARD : LOOSE;
    for (const [i, b] of map) if (micro ? micro[i] : pad.buttons[i]?.pressed) down.add(b);
    // The left stick (the Micro has none), then the d-pad as buttons, then a d-pad reported as one "hat" axis.
    let [x, y] = micro ? [0, 0] : [pad.axes[0] ?? 0, pad.axes[1] ?? 0];
    if (Math.hypot(x, y) < DEAD) [x, y] = [0, 0];
    if (down.has('left')) x = -1;
    if (down.has('right')) x = 1;
    if (down.has('up')) y = -1;
    if (down.has('down')) y = 1;
    const hat = pad.mapping === 'standard' || micro ? undefined : hatDir(pad.axes[9]);
    if (hat) [x, y] = hat;
    // Directions as presses too, for moving through answer cards.
    if (x < -0.5) down.add('left');
    if (x > 0.5) down.add('right');
    if (y < -0.5) down.add('up');
    if (y > 0.5) down.add('down');
    const was = seen.get(pad.index) ?? new Set();
    seen.set(pad.index, down);
    out.set(pad.index, { dir: Math.hypot(x, y) < DEAD ? null : eighth(x, y), pressed: [...down].filter((b) => !was.has(b)), pads: 1 });
  }
  return out;
}

/** All pads (or only pad `only`) as one: their directions summed, their presses together. */
export function readPads(only?: number): PadFrame {
  const each = readEachPad();
  const pressed = new Set<PadButton>();
  let [dx, dy] = [0, 0];
  for (const [index, f] of each) {
    if (only !== undefined && index !== only) continue;
    for (const b of f.pressed) pressed.add(b);
    if (f.dir) [dx, dy] = [dx + f.dir[0], dy + f.dir[1]];
  }
  const dir: Point | null = Math.hypot(dx, dy) < DEAD ? null : eighth(dx, dy);
  return { dir, pressed: [...pressed], pads: each.size };
}

// The 8BitDo Micro, as the gamedev.pl site projects it (apps/web/src/gamepad.ts): standard slot to raw button.
const MICRO_ORDER = {
  hid: [1, 0, 4, 3, 6, 7, 8, 9, 10, 11, 13, 14, -1, -1, -1, -1, 12],
  mfi: [0, 1, 5, 6, 11, 13, 12, 14, 4, 3, -1, -1, 10, 7, 8, 9, 2],
} as const;

/** An 8BitDo Micro's buttons in the standard slots (A 0, B 1, ... d-pad 12-15); undefined for any other pad. */
export function microButtons(pad: Pick<Gamepad, 'id' | 'mapping' | 'axes' | 'buttons'>): boolean[] | undefined {
  if (pad.mapping === 'standard') return undefined;
  if (!/^8bitdo micro(?: gamepad)?(?:$|[ (])/i.test(pad.id) && !/vendor:\s*2dc8\s+product:\s*9020/i.test(pad.id)) return undefined;
  // D-input reports 10 axes and 16 buttons; the Mac's MFi profile no axes and 15 buttons.
  const layout = pad.axes.length === 10 && pad.buttons.length === 16 ? 'hid' : pad.axes.length === 0 && pad.buttons.length === 15 ? 'mfi' : undefined;
  if (!layout) return undefined;
  const slots = MICRO_ORDER[layout].map((n) => n >= 0 && !!pad.buttons[n]?.pressed);
  if (layout === 'hid') {
    // Chrome on a Mac puts the cross on the first two axes; others use the hat.
    const cross: number[] = [];
    if (pad.axes[0] < -0.5) cross.push(14);
    if (pad.axes[0] > 0.5) cross.push(15);
    if (pad.axes[1] < -0.5) cross.push(12);
    if (pad.axes[1] > 0.5) cross.push(13);
    for (const n of cross.length ? cross : microHat(pad.axes[9])) slots[n] = true;
  }
  return slots;
}

/** A hat value as d-pad slots (12 up, 13 down, 14 left, 15 right); none when let go (the value is then outside -1..1). */
function microHat(value: number | undefined): number[] {
  if (value === undefined || !Number.isFinite(value) || value < -1.01 || value > 1.01) return [];
  const step = (value + 1) * 3.5;
  const n = Math.round(step);
  if (Math.abs(step - n) > 0.08 || n < 0 || n > 7) return [];
  return [[12], [12, 15], [15], [13, 15], [13], [13, 14], [14], [12, 14]][n];
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

/** Colours for players 1 to 6, the same on the badge and the hand-over card; stickers on the pads can match. */
export const PLAYER_COLOURS = ['#d9534f', '#3b7dd8', '#3fa34d', '#e8b923', '#9b59b6', '#e67e22'];

/**
 * Pads take turns with one hero (?pads=turns): only the pad whose turn it is steers. The turn passes to the next
 * connected pad after a conversation ends, or after `seconds` from the player's first press (a player who never
 * presses loses the turn after IDLE_S), never in the middle of a line or a talk.
 */
export class Turns {
  /** The gamepad index whose turn it is; undefined until a pad is pressed. */
  active: number | undefined;
  /** When the turn began, and when its player first pressed (undefined until then). */
  private given = 0;
  private started: number | undefined;

  constructor(private readonly seconds: number) {}

  /** Connected pads, by index. */
  connected(): number[] {
    return [...(navigator.getGamepads?.() ?? [])].filter((p): p is Gamepad => !!p?.connected).map((p) => p.index).sort((a, b) => a - b);
  }

  /** Who plays now: keeps the turn while its pad is there, else the first pad that presses anything takes it. */
  current(now: number): number | undefined {
    const pads = this.connected();
    if (this.active !== undefined && pads.includes(this.active)) return this.active;
    this.active = undefined;
    for (const p of navigator.getGamepads?.() ?? []) {
      if (p?.connected && p.buttons.some((b) => b.pressed)) {
        [this.active, this.given, this.started] = [p.index, now, now];
        break;
      }
    }
    return this.active;
  }

  /** The player whose turn it is pressed or steered. */
  touched(now: number) {
    this.started ??= now;
  }

  /** Whether the time is up (only counted while more than one pad is there). */
  due(now: number): boolean {
    if (this.active === undefined || this.connected().length < 2) return false;
    return this.started === undefined ? now - this.given > IDLE_S * 1000 : now - this.started > this.seconds * 1000;
  }

  /** Passes the turn to the next connected pad; returns it when it changed. */
  pass(now: number): number | undefined {
    const pads = this.connected();
    if (pads.length < 2 || this.active === undefined) return undefined;
    const next = pads.find((i) => i > this.active!) ?? pads[0];
    [this.active, this.given, this.started] = [next, now, undefined];
    return next;
  }

  /** "Player N" is the pad's place among the connected ones, so it stays 1 to 6 whatever indexes the browser gave. */
  player(index: number): number {
    return this.connected().indexOf(index) + 1 || index + 1;
  }
}
