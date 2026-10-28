// How a creature moves that is not a person on two legs (a round eye, a frog, a teapot that lives): no legs to
// walk, so its whole body hops, squashes as it lands, stretches as it rises, leans the way it goes, breathes
// and now and then blinks (a quick squash). The 3D model (web/hero3d.ts) and the painted cut-out (web/main.ts)
// both move this way. No Node imports: the browser bundles this file.

/** lift: how high the feet are off the ground; stretch: height scale about the feet (width the inverse, so the
 * volume stays); lean: forward tilt in radians, towards where it goes. lift is in body heights. */
export type CreatureMotion = { lift: number; stretch: number; lean: number };

/** One hop per walk cycle (src/play/rig.ts CYCLE), this high in body heights. */
const HOP = 0.32;
/** Share of the cycle on the ground: the squash as it lands and pushes off. */
const CONTACT = 0.3;
const BLINK_EVERY = 3.7;
const BLINK = 0.16;

/**
 * phase: walk cycles (as the person's walk); time: seconds, for breathing and blinking; seed: so two creatures
 * side by side do not breathe in step. talk: speaking bounces, listening leans in a little.
 */
export function creatureMotion({ phase = 0, walking = false, time = 0, talk, seed = 0 }: {
  phase?: number; walking?: boolean; time?: number; talk?: 'speak' | 'listen'; seed?: number;
}): CreatureMotion {
  const breathe = 0.025 * Math.sin(time * 2.4 + seed);
  if (walking) {
    const p = ((phase % 1) + 1) % 1;
    // On the ground (landing, then pushing off): squashed most in the middle of it.
    if (p < CONTACT) return { lift: 0, stretch: 1 - 0.2 * Math.sin((Math.PI * p) / CONTACT), lean: 0.12 };
    const u = (p - CONTACT) / (1 - CONTACT);
    // In the air: up and down in an arc, stretched on the way up, round at the top, a little stretched falling.
    return { lift: HOP * Math.sin(Math.PI * u), stretch: 1 + 0.12 * Math.cos(Math.PI * u) ** 2, lean: 0.12 + 0.08 * Math.cos(Math.PI * u) };
  }
  const t = time + seed;
  // A blink: a quick squash and back.
  const b = t % BLINK_EVERY;
  const blink = b < BLINK ? 0.14 * Math.sin((Math.PI * b) / BLINK) : 0;
  if (talk === 'speak') {
    // Little bounces on the words.
    const s = Math.abs(Math.sin(t * 7));
    return { lift: 0.035 * s, stretch: 1 + 0.07 * s - blink + breathe, lean: 0.05 * Math.sin(t * 2.3) };
  }
  return { lift: 0, stretch: 1 + breathe - blink, lean: talk === 'listen' ? 0.06 : 0 };
}
