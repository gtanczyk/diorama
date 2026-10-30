// Named facial poses shared by the GLB capability report and its browser renderer.
import { mouthOpening, mouthRoundness, type FaceState, type Mouth } from './lipsync.ts';
export type FaceControl = 'jaw' | 'blink' | 'blinkLeft' | 'blinkRight' | 'brow' | 'funnel' | 'pucker' | 'sil' | 'mbp' | 'ih' | 'eh' | 'aa' | 'oh' | 'ou' | 'fv' | 'l';
const aliases: Record<string, FaceControl> = {
  jawopen: 'jaw', mouthopen: 'jaw', eyeblink: 'blink', blink: 'blink', eyeblinkleft: 'blinkLeft', blinkleft: 'blinkLeft', eyeblinkright: 'blinkRight', blinkright: 'blinkRight',
  browinnerup: 'brow', browouterupleft: 'brow', browouterupright: 'brow', mouthfunnel: 'funnel', mouthpucker: 'pucker',
  visemesil: 'sil', vrcvsil: 'sil', visemepp: 'mbp', vrcvpp: 'mbp', visemembp: 'mbp',
  visemess: 'ih', vrcvss: 'ih', visemekk: 'ih', vrcvkk: 'ih', visemett: 'ih', vrcvtt: 'ih', visemech: 'ih', vrcvch: 'ih', visemeih: 'ih', visemei: 'ih', vrcvih: 'ih', vrcvi: 'ih', visemedd: 'ih', vrcvdd: 'ih', visemeth: 'ih', vrcvth: 'ih', visemerr: 'ih', vrcvrr: 'ih', i: 'ih', ih: 'ih',
  visemee: 'eh', vrcve: 'eh', visemeeh: 'eh', e: 'eh', eh: 'eh',
  visemeaa: 'aa', vrcvaa: 'aa', a: 'aa', aa: 'aa',
  visemeo: 'oh', visemeoh: 'oh', vrcvoh: 'oh', vrcvo: 'oh', o: 'oh', oh: 'oh',
  visemeu: 'ou', visemeou: 'ou', vrcvou: 'ou', vrcvu: 'ou', u: 'ou', ou: 'ou',
  visemeff: 'fv', vrcvff: 'fv', visemefv: 'fv', visemenn: 'l', vrcvnn: 'l', visemel: 'l',
};
export const facialControl = (name: string): FaceControl | undefined => aliases[name.toLowerCase().replace(/[^a-z]/g, '')];
const viseme: Record<Mouth, FaceControl> = { X: 'sil', A: 'mbp', B: 'ih', C: 'eh', D: 'aa', E: 'oh', F: 'ou', G: 'fv', H: 'l' };
export const isViseme = (control: FaceControl) => ['sil', 'mbp', 'ih', 'eh', 'aa', 'oh', 'ou', 'fv', 'l'].includes(control);
export function faceWeight(control: FaceControl, state: FaceState, nativeVisemes: boolean | ReadonlySet<FaceControl> = false): number {
  if (control.startsWith('blink')) return state.blink;
  if (control === 'brow') return state.brow;
  const native = (mouth: Mouth) => typeof nativeVisemes === 'boolean' ? nativeVisemes : nativeVisemes.has(viseme[mouth]);
  const fallback = (amount: (mouth: Mouth) => number) => (native(state.previous) ? 0 : amount(state.previous) * (1 - state.mix)) + (native(state.mouth) ? 0 : amount(state.mouth) * state.mix);
  if (control === 'jaw') return fallback(mouth => mouthOpening[mouth]);
  if (control === 'funnel') return fallback(mouthRoundness) * 0.65;
  if (control === 'pucker') return fallback(mouthRoundness) * 0.4;
  return (viseme[state.previous] === control ? 1 - state.mix : 0) + (viseme[state.mouth] === control ? state.mix : 0);
}

/** Rhubarb groups consonants; choose one representative pose instead of adding SS, KK and CH together. */
export function facialPriority(name: string): number {
  const normal = name.toLowerCase().replace(/[^a-z]/g, '');
  if (facialControl(name) !== 'ih') return 0;
  return /(?:ih|visemei|vrcvi)$/.test(normal) || normal === 'i' ? 0 : /ss$/.test(normal) ? 1 : 2;
}
