import { expect, test } from 'vitest';
import type { Job } from '../src/studio/jobs.ts';
import { repairPrompt, wantsRepair } from '../src/studio/repair.ts';

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1', world: 'w', label: 'build world > verify', args: ['build', 'w'], by: 'user', state: 'failed', queuedAt: '', tail: [],
  unplayable: [{ place: 'przystan-barek', errors: ['FLOOR_UNREACHABLE 0: floor 0 has walkable cells but none reachable'] }],
  ...over,
});
const on = { enabled: true };

test('a build someone else started that leaves places unplayable wakes the agent', () => {
  expect(wantsRepair(job(), on)).toBe(true);
  expect(wantsRepair(job({ by: 'cli' }), on)).toBe(true);
});

test('the agent is not woken by its own jobs, a switched-off setting, other jobs or a playable world', () => {
  expect(wantsRepair(job({ by: 'agent' }), on)).toBe(false);
  expect(wantsRepair(job(), { enabled: false })).toBe(false);
  expect(wantsRepair(job({ args: ['playthrough', 'w'] }), on)).toBe(false);
  expect(wantsRepair(job({ state: 'done', unplayable: [] }), on)).toBe(false);
  expect(wantsRepair(job({ unplayable: undefined }), on)).toBe(false);
});

test('the prompt names each place with its errors and the limits from the brief', () => {
  const text = repairPrompt(job());
  expect(text).toContain('przystan-barek: FLOOR_UNREACHABLE 0');
  expect(text).toMatch(/place_view/);
  expect(text).toMatch(/at most three fixes a place/);
});
