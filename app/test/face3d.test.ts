import * as THREE from 'three';
import { expect, test } from 'vitest';
import { ModelFace } from '../web/face3d.ts';
import { faceAt, mouthAt } from '../src/play/lipsync.ts';

function model(names: string[]) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3));
  geometry.morphTargetsRelative = true;
  geometry.morphAttributes.position = names.map(name => {
    const attribute = new THREE.Float32BufferAttribute([0, 1, 0, 0, 0, 0, 0, 0, 0], 3); attribute.name = name; return attribute;
  });
  const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
  return { mesh, face: new ModelFace(mesh) };
}

test('authored 3D mouth poses deform geometry on the same clock and leave unrelated poses intact', () => {
  const { mesh, face } = model(['jawOpen', 'eyeBlinkLeft', 'unrelated']);
  mesh.morphTargetInfluences![2] = 0.2;
  const state = faceAt({ mouth: 'D', previous: 'D', mix: 1, energy: 0.5 }, 1.8);
  face.apply(state);
  expect(face.mouth).toBe(true); expect(face.eyes).toBe(true);
  expect(mesh.getVertexPosition(0, new THREE.Vector3()).y).toBeCloseTo(0.9 + 1 + 0.2);
  face.apply(faceAt(mouthAt(undefined, undefined), 0));
  expect(mesh.getVertexPosition(0, new THREE.Vector3()).y).toBeCloseTo(0.2);
  expect(mesh.morphTargetInfluences![2]).toBe(0.2);
});

test('a body without authored facial poses reports no mouth support; native visemes do not double-open a jaw', () => {
  expect(model([]).face.mouth).toBe(false);
  const { mesh, face } = model(['jawOpen', 'viseme_aa', 'viseme_U']);
  face.apply(faceAt({ mouth: 'F', previous: 'D', mix: 0.25, energy: 0 }, 0));
  expect(mesh.morphTargetInfluences).toEqual([0, 0.75, 0.25]);
});

test('grouped consonants select one native shape, and missing vowels can fall back to the authored jaw', () => {
  const {mesh,face}=model(['viseme_ss','viseme_I','viseme_kk','jawOpen']);
  face.apply(faceAt({mouth:'B',previous:'B',mix:1,energy:0},0));
  expect(mesh.morphTargetInfluences).toEqual([0,1,0,0]);
  face.apply(faceAt({mouth:'D',previous:'D',mix:1,energy:0},0));
  expect(mesh.morphTargetInfluences).toEqual([0,0,0,0.9]);
});


test('a separate teeth mesh does not suppress the face mesh jaw fallback', () => {
  const head = model(['jawOpen']).mesh;
  const teeth = model(['viseme_aa']).mesh;
  const root = new THREE.Group();
  root.add(head, teeth);
  const face = new ModelFace(root);
  face.apply(faceAt({ mouth: 'D', previous: 'D', mix: 1, energy: 0 }, 0));
  expect(head.morphTargetInfluences).toEqual([0.9]);
  expect(teeth.morphTargetInfluences).toEqual([1]);
});
