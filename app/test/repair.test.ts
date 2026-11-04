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
  expect(wantsRepair(job({ state: 'cancelled' }), on)).toBe(false);
});

test('a build that failed at a step, with every place playable, wakes the agent with the error and the last lines', () => {
  const failed = job({ unplayable: undefined, step: 'model', error: 'diorama build: 3D models failed: ticket-cat: trellis-community/TRELLIS download /tmp/gradio/x.png: 500', tail: ['keeper-owl: rigging the skeleton', 'ticket-cat: TRELLIS builds the body'] });
  expect(wantsRepair(failed, on)).toBe(true);
  const text = repairPrompt(failed);
  expect(text).toContain('failed at model: diorama build: 3D models failed: ticket-cat');
  expect(text).toContain('  ticket-cat: TRELLIS builds the body');
  expect(text).toMatch(/job_inspect/);
  expect(text).toMatch(/job_retry/);
  expect(text).not.toMatch(/place_view/);
});

test('the prompt names each place with its errors and the limits from the brief', () => {
  const text = repairPrompt(job());
  expect(text).toContain('przystan-barek: FLOOR_UNREACHABLE 0');
  expect(text).toMatch(/place_view/);
  expect(text).toMatch(/after three failed fixes of a place take a different path/);
});

test('a completed build with missing animation wakes one repair turn without calling the build failed',()=>{
  const done=job({state:'done',unplayable:[],warnings:{faces:['dozorca: Generated lip frame X uncertain']}});
  expect(wantsRepair(done,on)).toBe(true);
  expect(wantsRepair({...done,by:'agent'},on)).toBe(false);
  expect(wantsRepair({...done,state:'cancelled'},on)).toBe(false);
  expect(wantsRepair(done,{enabled:false})).toBe(false);
  expect(repairPrompt(done)).toContain('finished with incomplete speaking animation');
  expect(repairPrompt(done)).toContain('face_lips_set');
  expect(repairPrompt(done)).not.toContain('job_retry');
});
