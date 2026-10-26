// Talking gestures: what a character does with the hands and head while a line is spoken. The story picks
// one per line; `diorama sprites` draws only those the story uses. No Node imports: the browser bundles this.

/**
 * A standing pose: where each upper arm points (world, the figure facing +z, its left at +x), how far
 * the elbow bends, and the head's nod and tilt. Elbows stay near the body: a long coat is skinned to
 * the upper arms and flares into a cape otherwise.
 */
export type Pose = { left?: [number, number, number, number]; right?: [number, number, number, number]; nod?: number; tilt?: number; lean?: number };

export const GESTURES = [
  { name: 'listen', means: 'hands down, listening or saying something plain', pose: {} },
  { name: 'open-hand', means: 'one hand raised, palm open: offering, greeting, a friendly point', pose: { right: [-0.2, -0.9, 0.35, 1.7] } },
  { name: 'explain', means: 'both hands forward: explaining, describing, reasoning', pose: { left: [0.25, -0.92, 0.3, 1.3], right: [-0.25, -0.92, 0.3, 1.3] } },
  { name: 'point', means: 'pointing ahead: directions, "over there", "that one"', pose: { right: [-0.1, -0.75, 0.65, 0.9], lean: 0.04 } },
  { name: 'shrug', means: 'shrug, forearms out: not knowing, doubt, "who knows"', pose: { left: [0.2, -0.95, 0.15, 1.4], right: [-0.2, -0.95, 0.15, 1.4], tilt: 0.15 } },
  { name: 'chest', means: 'hand on the chest: about oneself, a promise, feeling', pose: { left: [0.1, -0.95, 0.3, 2.1], nod: 0.1 } },
  { name: 'nod', means: 'nodding: yes, agreeing, thanks', pose: { right: [-0.2, -0.92, 0.3, 1.2], nod: 0.25 } },
  { name: 'together', means: 'hands together: asking, pleading, worried', pose: { left: [0.08, -0.92, 0.38, 1.5], right: [-0.08, -0.92, 0.38, 1.5] } },
] as const satisfies readonly { name: string; means: string; pose: Pose }[];

export type GestureName = (typeof GESTURES)[number]['name'];
export const gestureIndex = (name: string) => GESTURES.findIndex((g) => g.name === name);
