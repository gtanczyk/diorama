import * as THREE from 'three';
import { expect, test } from 'vitest';
import { Figure3D } from '../web/hero3d.ts';

function fixture() {
  const root = new THREE.Group();
  const bones: Record<string, THREE.Bone> = {};
  const add = (name: string, x: number, y: number, z = 0) => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    bones[name] = bone;
    root.add(bone);
  };
  add('Hips', 0, 0.5);
  for (const [side, x] of [['Left', 0.08], ['Right', -0.08]] as const) {
    add(`${side}UpLeg`, x, 0.5);
    add(`${side}Leg`, x, 0.28);
    add(`${side}Foot`, x, 0.06);
    add(`${side}ToeBase`, x, 0, 0.1);
  }
  const skeleton = new THREE.Skeleton(Object.values(bones));
  const leg = skeleton.bones.indexOf(bones.LeftLeg);
  const hips = skeleton.bones.indexOf(bones.Hips);
  const geometry = new THREE.BufferGeometry();
  // Wide boot shaft, knee, sole, and coat hem: all outside the correction's narrow bone radius.
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([
    0.15, 0.15, 0, 0.15, 0.28, 0, 0.15, 0.03, 0, 0.20, 0.40, 0,
  ], 3));
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(Array.from({ length: 4 }, () => [leg, hips, hips, hips]).flat(), 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(Array.from({ length: 4 }, () => [1, 0, 0, 0]).flat(), 4));
  const mesh = new THREE.SkinnedMesh(geometry);
  root.add(mesh);
  root.updateMatrixWorld(true);
  mesh.bind(skeleton);
  skeleton.update();
  const correct = (Figure3D.prototype as unknown as { fixCoat(mesh: THREE.SkinnedMesh, radius: number): void }).fixCoat;
  return { geometry, run: () => correct.call({ bones }, mesh, 0.035), leg, hips };
}

test('coat correction leaves wide boot shafts, knees and soles attached to their leg', () => {
  const f = fixture();
  const beforeIndex = Array.from(f.geometry.attributes.skinIndex.array).slice(0, 12);
  const beforeWeight = Array.from(f.geometry.attributes.skinWeight.array).slice(0, 12);
  f.run();
  expect(Array.from(f.geometry.attributes.skinIndex.array).slice(0, 12)).toEqual(beforeIndex);
  expect(Array.from(f.geometry.attributes.skinWeight.array).slice(0, 12)).toEqual(beforeWeight);
});

test('coat vertices above the knee still transfer to the hips and keep normalized weights', () => {
  const f = fixture();
  f.run();
  const index = f.geometry.attributes.skinIndex, weight = f.geometry.attributes.skinWeight;
  let hipsWeight = 0, sum = 0;
  for (let j = 0; j < 4; j++) {
    const w = weight.getComponent(3, j);
    sum += w;
    if (index.getComponent(3, j) === f.hips) hipsWeight += w;
  }
  expect(hipsWeight).toBeGreaterThan(0.9);
  expect(sum).toBeCloseTo(1, 6);
});
