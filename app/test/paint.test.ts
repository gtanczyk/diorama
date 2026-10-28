import { expect, test } from 'vitest';
import type { Layout } from '../src/scene/layout.ts';
import { paintPrompt } from '../src/scene/paint.ts';
import type { Place, World } from '../src/world/schema.ts';

const place: Place = {
  key: 'dock', shows: 'a small dock in fog', mood: 'dawn', exits: [],
  things: [{ key: 'boat', role: 'prop', looks: 'a blue rowing boat' }, { key: 'jory', role: 'npc', looks: 'an old net-mender' }],
};
const layout: Layout = {
  horizon: 300, sky: '#99aabb', ground: '#556677', lights: [],
  floors: [{ key: 'planks', is: 'wet planks', colour: '#665544', outline: [[0, 896], [0, 500], [1200, 500], [1200, 896]] }],
  things: [
    { key: 'boat', colour: '#3355aa', x: 1000, footY: 700, width: 300, height: 120, metres: 1 },
    { key: 'jory', colour: '#aa5533', x: 200, footY: 750, width: 60, height: 170, metres: 1.7 },
  ],
};
const world = { style: 'gouache on rough paper' } as World;

test('the prompt names each shape by what it is and where it stands, not by colour, and leaves npcs out', () => {
  const prompt = paintPrompt(world, place, layout);
  expect(prompt).toContain('the low wide box at the front, on the far right: a blue rowing boat');
  expect(prompt).toContain('the tiled floor area: wet planks, open floor to walk on');
  expect(prompt).not.toContain('#3355aa');
  expect(prompt).not.toContain('net-mender');
});

test('a brief look replaces the short one, and a missing look is an issue', async () => {
  const { briefIssues } = await import('../src/scene/brief.ts');
  const brief = { looks: { boat: 'a clinker-built rowing boat with flaking blue paint' }, alive: [] };
  expect(paintPrompt(world, place, layout, brief)).toContain('flaking blue paint');
  expect(briefIssues(brief, place, layout)).toEqual(['no look for planks']);
});
