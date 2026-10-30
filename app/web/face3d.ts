import * as THREE from 'three';
import { facialControl, faceWeight, isViseme, facialPriority, type FaceControl } from '../src/play/face3d.ts';
import type { FaceState } from '../src/play/lipsync.ts';

/** Only authored, recognized morph targets are driven. A body skeleton alone does not pretend to articulate. */
export class ModelFace {
  private bindings: Array<{ mesh: THREE.Mesh; index: number; control: FaceControl; name: string; selected: boolean }> = [];
  readonly mouth: boolean;
  readonly eyes: boolean;
  private nativeVisemes = new Map<THREE.Mesh, Set<FaceControl>>();
  constructor(root: THREE.Object3D) {
    root.traverse(object => {
      if (!(object as THREE.Mesh).isMesh) return;
      const mesh = object as THREE.Mesh;
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
        const control = facialControl(name);
        if (control && mesh.morphTargetInfluences) this.bindings.push({ mesh, index, control, name, selected: true });
      }
    });
    for (const binding of this.bindings.filter(b => isViseme(b.control))) {
      const group = this.bindings.filter(b => b.mesh === binding.mesh && b.control === binding.control).sort((a,b) => facialPriority(a.name) - facialPriority(b.name));
      binding.selected = group[0] === binding;
      if (binding.selected) {
        const controls = this.nativeVisemes.get(binding.mesh) ?? new Set<FaceControl>();
        controls.add(binding.control);
        this.nativeVisemes.set(binding.mesh, controls);
      }
    }
    this.mouth = [...this.nativeVisemes.values()].some(controls => [...controls].some(c => c !== 'sil')) || this.bindings.some(b => b.control === 'jaw');
    this.eyes = this.bindings.some(b => b.control.startsWith('blink'));
  }
  apply(state: FaceState) {
    for (const { mesh, index, control, selected } of this.bindings) mesh.morphTargetInfluences![index] = selected ? faceWeight(control, state, this.nativeVisemes.get(mesh) ?? false) : 0;
  }
}
