import { expect, test } from 'vitest';
import { blockinSvg } from '../src/scene/blockin.ts';
import { layoutIssues, type Layout } from '../src/scene/layout.ts';
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
