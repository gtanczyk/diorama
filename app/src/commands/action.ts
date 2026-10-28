// diorama action <name> ['<json>']: any Studio action from a terminal, with the same input the GUI and the
// agent send. A job action runs in the foreground here and prints its output.
import path from 'node:path';
import '../actions/index.ts';
import { actions, describeActions, runAction } from '../actions/registry.ts';
import { defineCommand } from '../registry.ts';
import { Events } from '../studio/events.ts';
import { snapshotBeforeJob } from '../studio/history.ts';
import { Jobs, type Job } from '../studio/jobs.ts';

defineCommand({
  name: 'action',
  usage: 'action <name> [\'<json>\'] run a Studio action (the same ones the GUI and Muse Code use); no name lists them',
  async run([name, json]) {
    if (!name) {
      for (const a of describeActions()) console.log(`  ${a.name.padEnd(14)} ${a.description}\n  ${''.padEnd(14)} input ${JSON.stringify(a.input.properties ?? {})}`);
      return;
    }
    const events = new Events();
    const root = path.resolve('worlds');
    const ctx = { by: 'cli' as const, root, events, jobs: new Jobs(events, { echo: true, beforeStart: snapshotBeforeJob(root, events) }) };
    let input: unknown = {};
    try {
      input = json ? JSON.parse(json) : {};
    } catch {
      throw new Error(`the input must be JSON, e.g. diorama action ${name} '{"slug":"foghorn"}'`);
    }
    const result = await runAction(name, input, ctx);
    const started = result && typeof result === 'object' ? ('job' in result ? (result as { job: Job }).job : actions.get(name)?.job ? result as Job : undefined) : undefined;
    if (started && typeof started.id === 'string') {
      const job = await ctx.jobs.wait(started.id);
      if (job.state !== 'done') throw new Error(`${job.label}: ${job.state}${job.error ? `, ${job.error}` : ''}`);
      return;
    }
    // Pictures are for the agent; here their file is enough.
    const { images: _, ...shown } = (result && typeof result === 'object' && !Array.isArray(result) ? result : { result }) as { images?: unknown };
    console.log(JSON.stringify(Array.isArray(result) || !result || typeof result !== 'object' ? result : shown, null, 2));
  },
});
