// Lip-sync is timed against the playing audio, independent of the simulation clock.
export type Mouth = 'X' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H';
export type MouthCue = { start: number; end: number; value: Mouth };
export type LipSync = { cues: MouthCue[]; envelope?: number[]; step?: number };
export type Box = [number, number, number, number]; // x, y, width, height within a sprite cell
export type FacePose = { mouth: Box; eyes: Box[]; lips?: Box; suggestedLips?: Box; lipConfidence?: number; sourceOpen?: boolean; atlas?: string };
export type Articulation = { mouth: Mouth; previous: Mouth; mix: number; energy: number };
export type FaceState = Articulation & { blink: number; brow: number; jaw: number; round: number };
export type FaceDefinition = {
  image: string;
  /** Source rectangles for X, A..H; the generated heads need individual registration. */
  mouths: Record<Mouth, Box>;
  sheets: Record<string, Array<FacePose | null>>;
  atlases?: Record<string, Record<Mouth, Box>>;
  /** Neutral lip corners in each atlas patch, normalized to that patch. */
  anchors?: Record<string, Box>;
  frames?: Record<string, Record<Mouth, Box>>;
  imagePose?: FacePose;
  rigPose?: FacePose;
  rigHash?: string;
  imageHash?: string;
  seed?: number;
  sourceVersions?: Record<string, string>;
  sheetHashes?: Record<string, string>;
};

export const MOUTHS: Mouth[] = ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];

/** Gaps, missing sound and completion use the relaxed mouth. Crossfade over the first 35 ms. */
export function mouthAt(sync: LipSync | undefined, seconds: number | undefined): { mouth: Mouth; previous: Mouth; mix: number; energy: number } {
  const rest = { mouth: 'X' as Mouth, previous: 'X' as Mouth, mix: 1, energy: 0 };
  if (!sync || seconds === undefined || seconds < 0 || !Number.isFinite(seconds)) return rest;
  let low = 0, high = sync.cues.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (sync.cues[mid].start <= seconds) low = mid + 1;
    else high = mid;
  }
  const index = low - 1, cue = sync.cues[index];
  if (!cue || seconds >= cue.end) return rest;
  const before = sync.cues[index - 1];
  const previous = before && Math.abs(before.end - cue.start) < 0.002 ? before.value : 'X';
  const mix = Math.min(1, (seconds - cue.start) / Math.min(0.035, (cue.end - cue.start) / 2));
  const energy = sync.envelope?.[Math.floor(seconds / (sync.step ?? 0.04))] ?? 0;
  return { mouth: cue.value, previous, mix, energy };
}

/** Two short eyelid movements with a variable interval, including while listening. */
export function blinkAt(seconds: number): number {
  const cycle = seconds % 5.3;
  const blink = (at: number) => Math.max(0, 1 - Math.abs(cycle - at) / 0.095);
  return Math.max(blink(1.8), blink(5.0) * 0.85);
}

export const mouthOpening: Record<Mouth, number> = { X: 0, A: 0, B: 0.12, C: 0.5, D: 0.9, E: 0.55, F: 0.28, G: 0.05, H: 0.4 };
export const mouthRoundness = (mouth: Mouth) => mouth === 'E' || mouth === 'F' ? 1 : 0;

/** One performance state, consumed by the painted and native 3D renderers. */
export function faceAt(articulation: Articulation, seconds: number, seed = 0): FaceState {
  return { ...articulation, blink: blinkAt(seconds + seed), brow: Math.max(0, Math.min(1, articulation.energy)) * 0.35,
    jaw: mouthOpening[articulation.previous] * (1 - articulation.mix) + mouthOpening[articulation.mouth] * articulation.mix,
    round: mouthRoundness(articulation.previous) * (1 - articulation.mix) + mouthRoundness(articulation.mouth) * articulation.mix };
}

/** Rigged paintings keep their face on the torso as it rises and falls. */
export function offsetFace(pose: FacePose, dx: number, dy: number): FacePose {
  const offset = ([x, y, w, h]: Box): Box => [x + dx, y + dy, w, h];
  return { ...pose, mouth: offset(pose.mouth), eyes: pose.eyes.map(offset), ...(pose.lips ? { lips: offset(pose.lips) } : {}), ...(pose.suggestedLips ? {suggestedLips:offset(pose.suggestedLips)} : {}) };
}
