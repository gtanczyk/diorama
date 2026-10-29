import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { Memo } from '../src/meta/memo.ts';
import * as registry from '../src/registry.ts';
import { Events } from '../src/studio/events.ts';
import { Jobs } from '../src/studio/jobs.ts';

test('memo announces live calls, failures and cache hits honestly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-telemetry-memo-'));
  const old = process.env.DIORAMA_EVENTS;
  const emit = vi.spyOn(registry, 'emit').mockImplementation(() => {});
  try {
    process.env.DIORAMA_EVENTS = '1';
    const memo = new Memo(dir);
    let finish!: (value: Buffer) => void;
    const pending = memo.remember('spark', 'draft', 'one', 'txt', () => new Promise<Buffer>(resolve => { finish = resolve; }));
    expect(emit.mock.calls.map(x => x[0])).toEqual(['operation.start']);
    finish(Buffer.from('ok'));
    await pending;
    expect(emit.mock.calls[1][1]).toMatchObject({ kind: 'spark', label: 'draft', outcome: 'ok' });
    const count = emit.mock.calls.length;
    await memo.remember('spark', 'draft', 'one', 'txt', async () => { throw new Error('cache missed'); });
    expect(emit).toHaveBeenCalledTimes(count);
    await expect(memo.remember('spark', 'bad', 'two', 'txt', async () => { throw new Error('provider failed'); })).rejects.toThrow('provider failed');
    expect(emit.mock.calls.at(-1)?.[1]).toMatchObject({ kind: 'spark', label: 'bad', outcome: 'failed', error: 'provider failed' });
  } finally {
    if (old === undefined) delete process.env.DIORAMA_EVENTS; else process.env.DIORAMA_EVENTS = old;
    emit.mockRestore(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('agent inspects timestamped concurrent operations, item progress and failures', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-telemetry-job-'));
  const bin = path.join(dir, 'job.mjs');
  fs.writeFileSync(bin, `const emit = (type, data) => console.log('@@diorama ' + JSON.stringify({type, ...data}));
    emit('step.start',{step:'voices'});
    emit('operation.start',{id:'a',kind:'voice',label:'first'});
    emit('operation.start',{id:'b',kind:'elevenlabs',label:'voices request'});
    emit('work.progress',{kind:'voices',completed:1,total:3,failed:1});
    console.log('FAIL one line');
    setTimeout(() => {emit('operation.end',{id:'a',outcome:'failed',ms:200,error:'request timed out'}); emit('step.end',{step:'voices'});}, 200);
    setTimeout(() => {emit('operation.end',{id:'b',outcome:'ok',ms:400});}, 400);
    setTimeout(() => process.exit(0), 700);`);
  const events = new Events(); const jobs = new Jobs(events, { cwd: dir, bin });
  const ctx = { root: dir, by: 'agent' as const, jobs, events };
  try {
    const observed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('no progress event')); }, 3000);
      const off = events.subscribe(e => { if (e.type === 'work.progress') { clearTimeout(timer); off(); resolve(); } });
    });
    const job = jobs.start('w', ['voices', 'w'], 'voices', 'agent');
    await observed;
    const active = await runAction('job_inspect', { id: job.id }, ctx) as ReturnType<Jobs['inspect']>;
    expect(active.state).toBe('running');
    expect(active.activeOperations.map(o => o.label)).toEqual(['first', 'voices request']);
    expect(active.progress.voices).toEqual({ completed: 1, total: 3, failed: 1 });
    expect(active.operations.voice).toEqual({ started: 1, completed: 0, failed: 0 });
    expect(active.recent.every(e => !!e.at)).toBe(true);
    const finished = await runAction('job_wait', { id: job.id, timeoutSeconds: 2 }, ctx) as { state: string; step?: string; telemetry: ReturnType<Jobs['inspect']> };
    expect(finished.state).toBe('done');
    expect(finished.step).toBeUndefined();
    expect(finished.telemetry.activeOperations).toEqual([]);
    expect(finished.telemetry.operations.voice).toEqual({ started: 1, completed: 0, failed: 1 });
    expect(finished.telemetry.recentFailures.map(e => e.error ?? e.message)).toEqual(expect.arrayContaining(['request timed out', 'FAIL one line']));
    expect(finished.telemetry.note).toContain('not proof');
    await expect(runAction('job_inspect', { id: 'missing' }, ctx)).rejects.toThrow('no job');
  } finally { jobs.stopAll(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 10_000);

test('Studio MCP exposes the live inspection to the agent', async () => {
  const { startStudio } = await import('../src/studio/server.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-telemetry-mcp-'));
  const bin = path.join(dir, 'job.mjs');
  fs.writeFileSync(bin, `console.log('@@diorama ' + JSON.stringify({type:'operation.start',id:'one',kind:'voice-design',label:'create and validate voice'})); setTimeout(()=>{}, 1500);`);
  const studio = await startStudio({ root: dir, bin });
  try {
    const observed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { off(); reject(new Error('no operation event')); }, 3000);
      const off = studio.events.subscribe(e => { if (e.type === 'operation.start') { clearTimeout(timer); off(); resolve(); } });
    });
    const job = studio.jobs.start('w', ['voices', 'w'], 'voices', 'agent');
    await observed;
    const response = await fetch(`${studio.url}mcp`, { method: 'POST', headers: { authorization: `Bearer ${studio.agentToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'job_inspect', arguments: { id: job.id } } }) });
    const body = await response.json() as { result: { isError: boolean; structuredContent: { state: string; activeOperations: Array<{ label: string }> } } };
    expect(body.result.isError).toBe(false);
    expect(body.result.structuredContent.state).toBe('running');
    expect(body.result.structuredContent.activeOperations[0].label).toBe('create and validate voice');
    expect(JSON.stringify(body)).not.toContain(studio.agentToken);
  } finally { await studio.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}, 10_000);
