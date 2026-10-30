import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { ReactionTriggers, Reactions, type ReactionEvent } from '../src/play/reactions.ts';
import type { Geometry } from '../src/play/geometry.ts';
import { startState } from '../src/story/engine.ts';
import { bindReactions, ReactionPlan } from '../src/scene/reactions.ts';
import { reactionInput } from '../src/commands/reactions.ts';
import { worldData } from '../src/commands/play.ts';
import { WorldFiles } from '../src/world/files.ts';
import { needs, PLACE_STEPS } from '../src/world/schedule.ts';
import { scene } from './fixtures/scene.ts';

const dust = { kind: 'dust' as const, colour: '#ac9168', strength: .4 };
const state = { place: 'room', flags: [], items: [], spent: [] };
const geometry = { cell: 8, things: [{ key: 'box', box: [32, 0, 48, 16] }] } as Geometry;
function runtime(extra = {}) {
  const events: ReactionEvent[] = [];
  const rules = Reactions.parse({ version: 1, source: '', scene: '', areas: [{ key: 'patch', cells: ['..##....'], step: dust, enter: dust, ...extra }], interactions: [] });
  return { events, fx: new ReactionTriggers(rules, geometry, (e) => events.push(e)) };
}
test('actual steps fire on material cells, including arrival; standing emits nothing', () => {
  const { fx, events } = runtime();
  fx.move({}, { x: 17, y: 4, phase: 0 }, { x: 25, y: 4, phase: .5 }, state);
  expect(events.map((e) => e.trigger)).toEqual(['step']);
  fx.move({}, { x: 25, y: 4, phase: .5 }, { x: 25, y: 4, phase: .5 }, state);
  fx.move({}, { x: 40, y: 4, phase: .5 }, { x: 50, y: 4, phase: 1 }, state);
  expect(events).toHaveLength(1);
});
test('entry is an edge crossing, catches a narrow patch at low FPS, and respects cooldown/once', () => {
  const { fx, events } = runtime({ once: true });
  fx.move({}, { x: 0, y: 4, phase: 0 }, { x: 55, y: 4, phase: 0 }, state);
  expect(events.map((e) => e.trigger)).toEqual(['enter']);
  fx.update(10); fx.reset();
  fx.move({}, { x: 0, y: 4, phase: 0 }, { x: 55, y: 4, phase: 0 }, state);
  expect(events).toHaveLength(1);
  const second = runtime();
  for (let i = 0; i < 2; i++) second.fx.move({}, { x: 0, y: 4, phase: 0 }, { x: 55, y: 4, phase: 0 }, state);
  expect(second.events).toHaveLength(1);
  second.fx.update(2);
  second.fx.move({}, { x: 0, y: 4, phase: 0 }, { x: 55, y: 4, phase: 0 }, state);
  expect(second.events).toHaveLength(2);
});
test('conditions gate both step and entry; different actors retain their own movement', () => {
  const { fx, events } = runtime({ when: ['active'] });
  const a = {}, b = {};
  fx.move(a, { x: 0, y: 4, phase: 0 }, { x: 25, y: 4, phase: .5 }, state);
  expect(events).toHaveLength(0);
  fx.move(b, { x: 17, y: 4, phase: 0 }, { x: 25, y: 4, phase: .5 }, { ...state, flags: ['active'] });
  expect(events).toHaveLength(1); expect(events[0].actor).toBe(b);
});
test('binding uses actual reachable material cells, rejects invalid/overlapping proposals, and disables stale plans', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reactions-'));
  try {
    const { put, world } = await scene(root);
    const files = new WorldFiles('w', root), input = reactionInput(files, 'room');
    const plan = ReactionPlan.parse({ scene: 'dusty floor', areas: [{ key: 'floor', floor: 'floor', step: dust }], interactions: [{ key: 'token', interaction: 0, at: [.5, .5], burst: dust }] });
    const rules = bindReactions(plan, input);
    expect(rules.areas[0].cells[0]).not.toContain('#');
    expect(rules.areas[0].cells[80]).toContain('#');
    const events: ReactionEvent[] = [], fx = new ReactionTriggers(rules, input.geometry, (e) => events.push(e));
    fx.interact('unmatched action', {}, () => 560); expect(events).toHaveLength(0);
    fx.interact(JSON.stringify(input.story!.interactions[0]), {}, () => 560); expect(events).toHaveLength(1);
    expect(() => bindReactions({ ...plan, areas: [{ ...plan.areas[0], floor: 'missing' }] }, input)).toThrow('unknown floor');
    expect(() => bindReactions({ ...plan, areas: [...plan.areas, { ...plan.areas[0], key: 'duplicate' }] }, input)).toThrow('overlap');
    expect(() => bindReactions({ ...plan, areas: [{ ...plan.areas[0], polygon: [[0, 0], [30, 0], [30, 30]] }] }, input)).toThrow('no reachable');
    expect(() => bindReactions({ ...plan, interactions: [{ ...plan.interactions[0], interaction: 999 }] }, input)).toThrow('use or take');
    put('places/room/reactions.json', rules);
    expect(worldData(files).places.room.reactions).toEqual(rules);
    put('world.json', { ...world, style: 'changed scene palette' });
    expect(worldData(files).places.room.reactions).toBeUndefined();
    expect(startState(world).flags).toEqual([]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('normal build automatically plans reactions after weather and story, before verification', () => {
  expect(needs('reactions')).toEqual(['weather', 'story']);
  expect(PLACE_STEPS.indexOf('reactions')).toBe(PLACE_STEPS.indexOf('verify') - 1);
});
