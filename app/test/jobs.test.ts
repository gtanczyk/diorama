import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';

test('the same job asked again while it waits or runs is that job, not a second paid run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-jobs-'));
  const bin = path.join(dir, 'slow.mjs');
  fs.writeFileSync(bin, 'setTimeout(() => {}, 300);\n');
  const jobs = new Jobs(new Events(), { cwd: dir, bin });
  try {
    const a = jobs.start('w', ['cast', 'w', 'hedgehog', '--animate'], 'animate hedgehog', 'user');
    const b = jobs.start('w', ['cast', 'w', 'hedgehog', '--animate'], 'animate hedgehog', 'user');
    const c = jobs.start('w', ['cast', 'w', 'owl', '--animate'], 'animate owl', 'user');
    expect(b.id).toBe(a.id);
    expect(c.id).not.toBe(a.id);
    // A pending edit is its own job, even with the same arguments.
    const d = jobs.start('w', ['cast', 'w', 'owl', '--animate'], 'animate owl', 'user', () => {});
    expect(d.id).not.toBe(c.id);
    expect(jobs.list('w')).toHaveLength(3);
  } finally {
    for (const j of jobs.list('w')) jobs.cancel(j.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a place repair never waits behind speaking faces: a running face job stops and goes back to the queue', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-jobs-'));
  const bin = path.join(dir, 'slow.mjs');
  fs.writeFileSync(bin, 'setTimeout(() => {}, 400);\n');
  const jobs = new Jobs(new Events(), { cwd: dir, bin });
  try {
    const face = jobs.start('w', ['faces', 'w', 'ferryman'], 'calibrate speaking face ferryman', 'agent');
    expect(face.state).toBe('running');
    const later = jobs.start('w', ['faces', 'w', 'cat'], 'prepare speaking faces cat', 'agent');
    const repair = jobs.start('w', ['build', 'w', '--from', 'layout', '--to', 'verify', '--place', 'quay'], 'layout · quay', 'agent');
    const now = jobs.list('w');
    expect(now.find((j) => j.id === face.id)?.state).toBe('cancelled');
    expect(now.find((j) => j.id === repair.id)?.state).toBe('running');
    // Both face jobs wait for their turn after the repair.
    expect(now.filter((j) => j.args[0] === 'faces' && j.state === 'queued').map((j) => j.args[2]).sort()).toEqual(['cat', 'ferryman']);
    expect(later.state).toBe('queued');
    await jobs.wait(repair.id, 5000);
    expect(jobs.list('w').filter((j) => j.args[0] === 'faces' && j.state === 'running')).toHaveLength(1);
  } finally {
    for (const j of jobs.list('w')) jobs.cancel(j.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('job_wait ends early when the person writes to the agent, so the steer is not held behind the wait', async () => {
  const { runAction } = await import('../src/actions/registry.ts');
  await import('../src/actions/index.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-jobs-'));
  const bin = path.join(dir, 'slow.mjs');
  fs.writeFileSync(bin, 'setTimeout(() => {}, 30000);\n');
  const events = new Events();
  const jobs = new Jobs(events, { cwd: dir, bin });
  const listeners = new Set<(text: string) => void>();
  try {
    const job = jobs.start('w', ['cast', 'w', 'mara'], 'cast mara', 'agent');
    const ctx = { by: 'agent' as const, root: dir, jobs, events, onPersonSays: (l: (text: string) => void) => (listeners.add(l), () => listeners.delete(l)) };
    const started = Date.now();
    const waiting = runAction('job_wait', { id: job.id, timeoutSeconds: 60 }, ctx);
    setTimeout(() => listeners.forEach((l) => l('so what if she has freckles?')), 100);
    const result = (await waiting) as { state: string; personWrote?: string };
    expect(Date.now() - started).toBeLessThan(5000);
    expect(result.state).toBe('running');
    expect(result.personWrote).toBe('so what if she has freckles?');
    expect(listeners.size).toBe(0);
  } finally {
    for (const j of jobs.list('w')) jobs.cancel(j.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
