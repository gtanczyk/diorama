// A job is a diorama command run as a child process, exactly as you would type it. One job per world runs
// at a time, the rest wait their turn. Output lines and `@@diorama` events go to the live feed, keys redacted.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redact } from '../secrets.ts';
import type { Events } from './events.ts';

const BIN = fileURLToPath(new URL('../../bin/diorama.mjs', import.meta.url));

export type Job = {
  id: string;
  world: string;
  label: string;
  args: string[];
  by: string;
  state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  step?: string;
  error?: string;
  /** The last lines it printed. */
  tail: string[];
};

export class Jobs {
  private readonly all: Job[] = [];
  private readonly children = new Map<string, ChildProcess>();
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();

  /** echo: also print the job's output (the CLI runs jobs in the foreground). */
  /** beforeStart runs as a job leaves the queue (the Studio snapshots the world there, for undo). */
  constructor(private readonly events: Events, private readonly opts: { cwd?: string; echo?: boolean; bin?: string; beforeStart?: (job: Job) => void } = {}) {}

  /** Whether a job for this world is running or waiting. */
  busy(world: string): Job | undefined {
    return this.all.find((j) => j.world === world && (j.state === 'running' || j.state === 'queued'));
  }

  start(world: string, args: string[], label: string, by: string): Job {
    const job: Job = { id: randomBytes(4).toString('hex'), world, label, args, by, state: 'queued', queuedAt: new Date().toISOString(), tail: [] };
    this.all.push(job);
    this.events.publish('job.queued', { world, job: { ...job } });
    this.next(world);
    return job;
  }

  list(world?: string): Job[] {
    return this.all.filter((j) => !world || j.world === world).map((j) => ({ ...j }));
  }

  get(id: string): Job | undefined {
    return this.all.find((j) => j.id === id);
  }

  cancel(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`no job ${id}`);
    if (job.state === 'queued') this.finish(job, 'cancelled');
    else if (job.state === 'running') {
      job.state = 'cancelled';
      this.children.get(id)?.kill('SIGTERM');
    }
    return { ...job };
  }

  /** Resolves when the job has ended, however it ended. */
  wait(id: string, timeoutMs?: number): Promise<Job> {
    const job = this.get(id);
    if (!job) return Promise.reject(new Error(`no job ${id}`));
    if (!['queued', 'running'].includes(job.state)) return Promise.resolve({ ...job });
    return new Promise((resolve) => {
      const done = (j: Job) => {
        clearTimeout(timer);
        resolve(j);
      };
      // Past the timeout it answers with the job as it stands, still running.
      const timer = timeoutMs === undefined ? undefined : setTimeout(() => {
        this.waiters.set(id, (this.waiters.get(id) ?? []).filter((w) => w !== done));
        resolve({ ...job });
      }, timeoutMs);
      this.waiters.set(id, [...(this.waiters.get(id) ?? []), done]);
    });
  }

  stopAll() {
    for (const job of this.all) if (job.state === 'queued' || job.state === 'running') this.cancel(job.id);
  }

  private next(world: string) {
    if (this.all.some((j) => j.world === world && j.state === 'running')) return;
    const job = this.all.find((j) => j.world === world && j.state === 'queued');
    if (!job) return;
    try {
      this.opts.beforeStart?.(job);
    } catch (error) {
      this.events.publish('log', { world, job: job.id, stream: 'err', line: `snapshot failed: ${error instanceof Error ? error.message : error}` });
    }
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    this.events.publish('job.start', { world, job: { ...job } });
    const child = spawn(process.execPath, [this.opts.bin ?? BIN, ...job.args], {
      cwd: this.opts.cwd,
      env: { ...process.env, DIORAMA_EVENTS: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.children.set(job.id, child);
    const lines = (stream: 'out' | 'err') => {
      let rest = '';
      return (chunk: Buffer) => {
        const parts = (rest + chunk.toString('utf8')).split('\n');
        rest = parts.pop() ?? '';
        for (const line of parts) this.line(job, stream, line);
      };
    };
    child.stdout!.on('data', lines('out'));
    child.stderr!.on('data', lines('err'));
    child.on('error', (error) => (job.error = error.message));
    child.on('close', (code) => {
      this.children.delete(job.id);
      if (job.state === 'cancelled') this.finish(job, 'cancelled');
      else this.finish(job, code === 0 ? 'done' : 'failed', code === 0 ? undefined : job.error ?? `exited with ${code}`);
    });
  }

  private line(job: Job, stream: 'out' | 'err', raw: string) {
    const line = redact(raw);
    if (line.startsWith('@@diorama ')) {
      try {
        const { type, ...data } = JSON.parse(line.slice('@@diorama '.length)) as { type: string };
        if (type === 'step.start') job.step = (data as { step?: string }).step;
        if (type === 'step.fail') job.error = String((data as { error?: unknown }).error ?? '');
        this.events.publish(type, { ...data, world: job.world, job: job.id });
        return;
      } catch {}
    }
    if (stream === 'err' && line.startsWith('diorama ')) job.error = line;
    job.tail.push(line);
    if (job.tail.length > 40) job.tail.shift();
    if (this.opts.echo) (stream === 'out' ? process.stdout : process.stderr).write(`${line}\n`);
    this.events.publish('log', { world: job.world, job: job.id, stream, line });
  }

  private finish(job: Job, state: Job['state'], error?: string) {
    job.state = state;
    job.endedAt = new Date().toISOString();
    if (error) job.error = error;
    this.events.publish('job.end', { world: job.world, job: { ...job } });
    for (const resolve of this.waiters.get(job.id) ?? []) resolve({ ...job });
    this.waiters.delete(job.id);
    this.next(job.world);
  }
}
