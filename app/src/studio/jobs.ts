// A job is a diorama command run as a child process, exactly as you would type it. One job per world runs
// at a time, the rest wait their turn. Output lines and `@@diorama` events go to the live feed, keys redacted.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { redact } from '../secrets.ts';
import type { Events } from './events.ts';
import type { ExtensionProgress } from '../world/extension-progress.ts';

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
  /** The steps running now, joined ("model + verify"): a build runs independent steps side by side. */
  step?: string;
  /** Each step running now, in the order it started. */
  steps?: string[];
  /** Last confirmed extension milestone, available when a client opens mid-job. */
  extension?: ExtensionProgress;
  error?: string;
  /** Optional stages completed with missing assets; distinct from a failed job. */
  warnings?: Record<string, string[]>;
  /** A queued addition reserves its key before its source correction is applied. */
  addedThing?: { place: string; key: string };
  /** Places verify found not playable, with why: the reason a build that finished still fails. */
  unplayable?: Array<{ place: string; errors: string[] }>;
  /** The last lines it printed. */
  tail: string[];
};

type Activity = { at: string; type: string; message?: string; stream?: string; kind?: string; label?: string; outcome?: string; ms?: number; error?: string };
type Operation = { id: string; kind: string; label: string; startedAt: string };
type Progress = { completed: number; total: number; failed: number; kept?: number };
type Diagnostics = { lastActivityAt: string; recent: Activity[]; failures: Activity[]; active: Map<string, Operation>; progress: Record<string, Progress>; operations: Record<string, { started: number; completed: number; failed: number }> };

export class Jobs {
  private readonly all: Job[] = [];
  private readonly children = new Map<string, ChildProcess>();
  private readonly waiters = new Map<string, Array<(job: Job) => void>>();
  private readonly prepare = new Map<string, () => void>();
  private readonly diagnostics = new Map<string, Diagnostics>();

  /** echo: also print the job's output (the CLI runs jobs in the foreground). */
  /** beforeStart runs as a job leaves the queue (the Studio snapshots the world there, for undo). */
  constructor(private readonly events: Events, private readonly opts: { cwd?: string; echo?: boolean; bin?: string; beforeStart?: (job: Job) => void } = {}) {}

  /** Whether a job for this world is running or waiting. */
  busy(world: string): Job | undefined {
    return this.all.find((j) => j.world === world && (j.state === 'running' || j.state === 'queued'));
  }

  /**
   * Polish that must never hold up the game: speaking faces. They run only when nothing else for the world is
   * waiting, and any other job stops a running one (face work is saved as it goes; it resumes on the next run).
   */
  static polish(args: readonly string[]): boolean {
    const at = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    return args[0] === 'faces' || (args[0] === 'build' && at('--from') === 'faces' && at('--to') === 'faces');
  }

  start(world: string, args: string[], label: string, by: string, prepare?: () => void, addedThing?: Job['addedThing']): Job {
    // The same job already waiting or running (a button pressed again, the agent asking twice) is that job:
    // a second run would only pay for the same model calls again. A pending edit is its own job.
    const same = prepare ? undefined : this.all.find((j) => j.world === world && (j.state === 'queued' || j.state === 'running') && !this.prepare.has(j.id) && j.args.join('\0') === args.join('\0'));
    if (same) return same;
    const job: Job = { id: randomBytes(4).toString('hex'), world, label, args, by, state: 'queued', queuedAt: new Date().toISOString(), tail: [], ...(addedThing && { addedThing }) };
    this.all.push(job);
    this.diagnostics.set(job.id, { lastActivityAt: job.queuedAt, recent: [], failures: [], active: new Map(), progress: {}, operations: {} });
    if (prepare) this.prepare.set(job.id, prepare);
    this.events.publish('job.queued', { world, job: { ...job } });
    if (!Jobs.polish(args)) for (const running of this.all.filter((j) => j.world === world && j.state === 'running' && Jobs.polish(j.args))) {
      running.error = `stopped so "${label}" can run first (speaking faces resume later)`;
      this.cancel(running.id);
      this.start(world, running.args, running.label, running.by);
    }
    this.next(world);
    return job;
  }

  list(world?: string): Job[] {
    return this.all.filter((j) => !world || j.world === world).map((j) => ({ ...j }));
  }

  get(id: string): Job | undefined {
    return this.all.find((j) => j.id === id);
  }

  /** A bounded, timestamped view of this job, including work in flight in its own process. */
  inspect(id: string, limit = 40) {
    const job = this.get(id);
    const data = this.diagnostics.get(id);
    if (!job || !data) throw new Error(`no job ${id}`);
    const now = Date.now();
    const end = job.endedAt ? Date.parse(job.endedAt) : now;
    return {
      id: job.id, world: job.world, label: job.label, state: job.state,
      startedAt: job.startedAt ?? null, endedAt: job.endedAt ?? null,
      elapsedSeconds: job.startedAt ? Math.max(0, Math.round((end - Date.parse(job.startedAt)) / 1000)) : 0,
      lastActivityAt: data.lastActivityAt,
      quietSeconds: Math.max(0, Math.round((end - Date.parse(data.lastActivityAt)) / 1000)),
      steps: [...(job.steps ?? [])], extension: job.extension ?? null, error: job.error ?? null,
      activeOperations: [...data.active.values()].map(op => ({ ...op, elapsedSeconds: Math.max(0, Math.round((end - Date.parse(op.startedAt)) / 1000)) })),
      operations: { ...data.operations }, progress: { ...data.progress }, recentFailures: data.failures.slice(-20), recent: data.recent.slice(-limit),
      note: 'Active operations are observed in this process, not proof of the remote service state. Operations may be nested; their counts are not billing. Silence alone does not prove a hang.',
    };
  }

  private activity(job: Job, event: Omit<Activity, 'at'>, at = new Date().toISOString()) {
    const data = this.diagnostics.get(job.id);
    if (!data) return;
    data.lastActivityAt = at;
    const record = { at, ...event };
    data.recent.push(record);
    if (event.outcome === 'failed' || event.type === 'step.fail' || event.type === 'place.fail' || event.stream === 'err' || (event.type === 'log' && /^\s*(?:FAIL\b|warning:|.*\bFAILED\b)/i.test(event.message ?? ''))) {
      data.failures.push(record);
      if (data.failures.length > 20) data.failures.shift();
    }
    if (data.recent.length > 200) data.recent.splice(0, data.recent.length - 200);
  }

  /** A cancelled queued edit has not changed its source yet; retry keeps that pending edit. */
  retry(id: string, args: string[], by: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`no job ${id}`);
    const prepare = this.prepare.get(id);
    this.prepare.delete(id);
    return this.start(job.world, args, job.label, by, prepare, job.addedThing);
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
    const queued = this.all.filter((j) => j.world === world && j.state === 'queued');
    const job = queued.find((j) => !Jobs.polish(j.args)) ?? queued[0];
    if (!job) return;
    try {
      this.opts.beforeStart?.(job);
    } catch (error) {
      this.finish(job, 'failed', `snapshot failed: ${error instanceof Error ? error.message : error}`);
      return;
    }
    try {
      this.prepare.get(job.id)?.();
      this.prepare.delete(job.id);
    } catch (error) {
      this.finish(job, 'failed', error instanceof Error ? error.message : String(error));
      return;
    }
    job.state = 'running';
    job.startedAt = new Date().toISOString();
    this.activity(job, { type: 'job.start' }, job.startedAt);
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
      else this.finish(job, code === 0 ? 'done' : 'failed', code === 0 ? undefined : job.error ?? (job.unplayable?.length ? `not playable: ${job.unplayable.map((u) => `${u.place} (${u.errors.join('; ') || 'see verify.json'})`).join(', ')}` : `exited with ${code}`));
    });
  }

  private line(job: Job, stream: 'out' | 'err', raw: string) {
    const line = redact(raw);
    if (line.startsWith('@@diorama ')) {
      try {
        const { type, ...data } = JSON.parse(line.slice('@@diorama '.length)) as { type: string } & Record<string, unknown>;
        const step = (data as { step?: string }).step;
        const diagnostics = this.diagnostics.get(job.id);
        const at = new Date().toISOString();
        if (diagnostics && type === 'operation.start' && typeof data.id === 'string' && typeof data.kind === 'string' && typeof data.label === 'string') {
          const operation = { id: data.id, kind: data.kind.slice(0, 80), label: data.label.slice(0, 160), startedAt: at };
          diagnostics.active.set(data.id, operation);
          (diagnostics.operations[operation.kind] ??= { started: 0, completed: 0, failed: 0 }).started++;
          this.activity(job, { type, kind: operation.kind, label: operation.label }, at);
        } else if (diagnostics && type === 'operation.end' && typeof data.id === 'string') {
          const op = diagnostics.active.get(data.id);
          diagnostics.active.delete(data.id);
          if (op) {
            const count = diagnostics.operations[op.kind];
            if (data.outcome === 'failed') count.failed++;
            else count.completed++;
          }
          this.activity(job, { type, ...(op && { kind: op.kind, label: op.label }), ...(typeof data.outcome === 'string' && { outcome: data.outcome }), ...(typeof data.ms === 'number' && { ms: data.ms }), ...(typeof data.error === 'string' && { error: data.error.slice(0, 500) }) }, at);
        } else if (diagnostics && type === 'work.progress' && typeof data.kind === 'string' && typeof data.completed === 'number' && typeof data.total === 'number' && typeof data.failed === 'number') {
          diagnostics.progress[data.kind] = { completed: data.completed, total: data.total, failed: data.failed, ...(typeof data.kept === 'number' && { kept: data.kept }) };
          this.activity(job, { type, kind: data.kind, message: `${data.completed}/${data.total}, ${data.failed} failed` }, at);
        } else if (['step.start', 'step.end', 'step.fail', 'extension.progress', 'place.fail', 'place.verdict', 'repair.start', 'repair.end'].includes(type)) {
          const failure = (type === 'place.verdict' || type === 'repair.end') && data.ok === false;
          const reason = typeof data.error === 'string' ? data.error : failure && Array.isArray(data.errors) ? data.errors.join('; ') : undefined;
          this.activity(job, { type, message: String(step ?? data.phase ?? data.place ?? '').slice(0, 160), ...(failure && { outcome: 'failed' }), ...(reason && { error: reason.slice(0, 500) }) }, at);
        }
        if (type === 'extension.progress') {
          const next = data as ExtensionProgress;
          job.extension = { ...next, newPlaces: next.newPlaces ?? job.extension?.newPlaces };
        }
        if (step && type === 'step.end' && data.status === 'incomplete' && Array.isArray(data.warnings)) (job.warnings ??= {})[step] = data.warnings.filter((v): v is string => typeof v === 'string');
        if (step && type === 'step.start') job.steps = [...(job.steps ?? []).filter((s) => s !== step), step];
        if (step && (type === 'step.end' || type === 'step.fail')) job.steps = (job.steps ?? []).filter((s) => s !== step);
        // A failed step stays shown, so the job says where it broke; a finished one leaves the steps still running.
        if (step && type === 'step.fail') job.step = step;
        else if (type === 'step.start' || type === 'step.end') job.step = job.steps?.length ? job.steps.join(' + ') : job.error ? job.step : undefined;
        if (type === 'step.fail') job.error = String((data as { error?: unknown }).error ?? '');
        if (type === 'place.verdict') {
          const v = data as { place: string; ok: boolean; errors?: string[] };
          if (!v.ok) (job.unplayable ??= []).push({ place: v.place, errors: v.errors ?? [] });
        }
        this.events.publish(type, { ...data, world: job.world, job: job.id });
        return;
      } catch {}
    }
    if (stream === 'err' && line.startsWith('diorama ')) job.error = line;
    if (line.trim()) this.activity(job, { type: 'log', stream, message: line.slice(0, 1200) });
    job.tail.push(line);
    if (job.tail.length > 40) job.tail.shift();
    if (this.opts.echo) (stream === 'out' ? process.stdout : process.stderr).write(`${line}\n`);
    this.events.publish('log', { world: job.world, job: job.id, stream, line });
  }

  private finish(job: Job, state: Job['state'], error?: string) {
    job.state = state;
    job.endedAt = new Date().toISOString();
    if (error) job.error = error;
    this.diagnostics.get(job.id)?.active.clear();
    this.activity(job, { type: 'job.end', outcome: state, ...(error && { error }) }, job.endedAt);
    this.events.publish('job.end', { world: job.world, job: { ...job } });
    for (const resolve of this.waiters.get(job.id) ?? []) resolve({ ...job });
    this.waiters.delete(job.id);
    this.next(job.world);
  }
}
