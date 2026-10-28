import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import '../src/commands/action.ts';
import { registry } from '../src/registry.ts';
import { defineAction } from '../src/actions/registry.ts';
import { Jobs, type Job } from '../src/studio/jobs.ts';
import { z } from 'zod';
import { scene } from './fixtures/scene.ts';
const cwd = process.cwd(); let root: string;
afterEach(() => { process.chdir(cwd); vi.restoreAllMocks(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('the CLI waits for nested jobs from thing_add and world_new style results', async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-action-')); await scene(path.join(root, 'worlds')); process.chdir(root);
  const job: Job = { id: 'nested-job', world: 'w', args: [], label: 'add token', state: 'done', queuedAt: '', tail: [], by: 'cli' };
  vi.spyOn(Jobs.prototype, 'start').mockReturnValue(job);
  const wait = vi.spyOn(Jobs.prototype, 'wait').mockResolvedValue(job);
  await registry.get('action')!.run(['thing_add', JSON.stringify({ slug: 'w', place: 'room', looks: 'a blue bench' })]);
  expect(wait).toHaveBeenLastCalledWith('nested-job');
  // world_new returns its slug beside the job; no real idea/model call is needed to check the CLI contract.
  defineAction({ name: 'nested_job_fixture', input: z.object({}), description: 'test', job: true, async run() { return { slug: 'w', job }; } });
  await registry.get('action')!.run(['nested_job_fixture', '{}']);
  expect(wait).toHaveBeenLastCalledWith('nested-job');
  defineAction({ name: 'job_estimate_fixture', input: z.object({}), description: 'test', job: true, async run() { return { estimate: 'No job started' }; } });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  await registry.get('action')!.run(['job_estimate_fixture', '{}']);
  expect(wait).toHaveBeenCalledTimes(2); expect(output).toHaveBeenCalledWith(expect.stringContaining('No job started'));
});
