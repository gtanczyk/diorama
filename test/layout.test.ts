import { expect, test } from 'vitest';
import { blockinSvg } from '../src/scene/blockin.ts';
import { closeUpIssues, layoutIssues, type Layout } from '../src/scene/layout.ts';
import type { Place } from '../src/world/schema.ts';

const place: Place = {
  key: 'yard', shows: 'an inn yard seen from above', mood: 'dusk', exits: [],
  things: [{ key: 'well', role: 'prop', looks: 'stone well' }, { key: 'innkeeper', role: 'npc', looks: 'a stout man' }],
};
const layout = (patch: Partial<Layout> = {}): Layout => ({
  horizon: 300, sky: '#8899aa', ground: '#556644',
  floors: [{ key: 'yard', is: 'packed earth', colour: '#776655', outline: [[0, 896], [0, 400], [1200, 400], [1200, 896]] }],
  things: [
    { key: 'well', colour: '#888888', x: 600, footY: 600, width: 120, height: 140, metres: 1.4 },
    { key: 'innkeeper', colour: '#aa6644', x: 300, footY: 700, width: 60, height: 160, metres: 1.7 },
  ],
  lights: [], ...patch,
});

test('a sound layout has no issues', () => {
  expect(layoutIssues(layout(), place)).toEqual([]);
});

test('floors above the horizon, missing and tiny things are caught', () => {
  const issues = layoutIssues(layout({
    floors: [{ key: 'yard', is: 'earth', colour: '#776655', outline: [[0, 700], [0, 200], [1200, 200]] }],
    things: [{ key: 'well', colour: '#888888', x: 600, footY: 600, width: 20, height: 140, metres: 1.4 }],
  }), place);
  expect(issues).toEqual(expect.arrayContaining([
    'floor yard rises above the horizon at 300',
    'floor yard is listed first, so it must reach the bottom edge (y >= 866)',
    'innkeeper is missing',
    'well: at least 40x40 px, so a player can click it',
  ]));
});

test('npcs get no mass in the block-in', () => {
  const svg = blockinSvg(layout(), place);
  expect(svg).toContain('#888888');
  expect(svg).not.toContain('#aa6644');
});

test('a quay across a canal, with the exit on it, is caught; a bridge floor joins it', () => {
  const canal: Place = { key: 'canal-steps', shows: 'steps, canal, houses', mood: 'night', exits: [], things: [{ key: 'bridge-stairs', role: 'exit', looks: 'stairs' }] };
  const floors: Layout['floors'] = [
    { key: 'fore-steps', is: 'steps', colour: '#555555', outline: [[0, 760], [1200, 740], [1200, 896], [0, 896]] },
    { key: 'fore-quay', is: 'quay', colour: '#555555', outline: [[0, 630], [1200, 610], [1200, 740], [0, 760]] },
    { key: 'far-quay', is: 'quay', colour: '#555555', outline: [[68, 410], [1132, 410], [1152, 492], [48, 492]] },
  ];
  const things = [{ key: 'bridge-stairs', colour: '#777777', x: 1020, footY: 488, width: 200, height: 260, metres: 4 }];
  const issues = layoutIssues(layout({ horizon: 400, floors, things }), canal);
  expect(issues).toEqual([expect.stringMatching(/^floor far-quay doesn't touch fore-steps/), 'bridge-stairs stands on far-quay, which the hero can\'t reach']);
  const bridge = { key: 'bridge', is: 'footbridge', colour: '#666666', outline: [[900, 490], [1000, 490], [1000, 615], [900, 615]] as [number, number][] };
  expect(layoutIssues(layout({ horizon: 400, floors: [...floors, bridge], things }), canal)).toEqual([]);
  expect(layoutIssues(layout({ horizon: 400, floors, things }), canal, false)).toEqual([]);
});

test('a close-up camera is caught from the things\' sizes', () => {

  const bakery = layout({ horizon: 420, things: [
    { key: 'oven', colour: '#888888', x: 300, footY: 540, width: 300, height: 340, metres: 2.4 },
    { key: 'rack', colour: '#888888', x: 700, footY: 560, width: 200, height: 310, metres: 1.9 },
    { key: 'door', colour: '#888888', x: 1000, footY: 630, width: 200, height: 350, metres: 2.1 },
  ] });
  expect(closeUpIssues(bakery)[0]).toMatch(/camera is too close/);
  expect(closeUpIssues(layout())).toEqual([]);
});
