import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { Memo } from '../src/meta/memo.ts';
import { transcribe } from '../src/meta/voice.ts';

vi.mock('../src/meta/http.ts', () => ({ apiKey: () => 'test' }));
type Outcome = 'ok' | 'backlog' | 'unauthorized' | 'silent' | 'early-close' | 'malformed' | 'buffered';
let root: string, memo: Memo, plan: Outcome[], sockets: FakeSocket[], active: number, maxActive: number;
class FakeSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType = '';
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: (e: { code: number; reason: string }) => void;
  onerror?: () => void;
  frames: number[] = [];
  lateSends = 0;
  outcome: Outcome;
  constructor() {
    this.outcome = plan.shift() ?? 'ok'; sockets.push(this);
    active++; maxActive = Math.max(maxActive, active);
    setTimeout(() => { this.readyState = 1; this.onopen?.(); }, 0);
  }
  message(data: object) { this.onmessage?.({ data: JSON.stringify(data) }); }
  send(data: string | Buffer) {
    if (this.readyState !== 1) { this.lateSends++; throw new Error('socket closed'); }
    if (typeof data === 'string') {
      const msg = JSON.parse(data);
      if (msg.authorization) {
        if (this.outcome === 'silent') return;
        if (this.outcome === 'unauthorized') return this.message({ type: 'error', message: 'unauthorized' });
        if (this.outcome === 'malformed') return this.onmessage?.({ data: 'invalid json' });
        this.message({ sessionId: 'session' });
      } else if (msg.type === 'endStream') {
        this.message({ type: 'transcript', transcript: 'Cześć!', final: true }); this.close(1000);
      }
    } else {
      this.frames.push(Date.now());
      if (this.frames.length === 1 && this.outcome === 'buffered') {
        this.bufferedAmount = 3840 * 8;
        setTimeout(() => { this.bufferedAmount = 0; }, 300);
      }
      if (this.frames.length === 2 && this.outcome === 'backlog') this.message({ type: 'error', message: 'Audio processing backlog too large' });
      if (this.frames.length === 2 && this.outcome === 'early-close') this.close(1000);
    }
  }
  close(code: number) {
    if (this.readyState === 3) return;
    this.readyState = 3; active--; this.onclose?.({ code, reason: '' });
  }
}
beforeEach(() => {
  vi.useFakeTimers();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-asr-'));
  vi.stubEnv('DIORAMA_CACHE', root);
  memo = new Memo(path.join(root, 'memo'));
  sockets = []; plan = []; active = 0; maxActive = 0;
  vi.stubGlobal('WebSocket', FakeSocket);
});
afterEach(() => {
  expect(sockets.every((s) => s.readyState === 3 && s.lateSends === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  fs.rmSync(root, { recursive: true, force: true });
});

test('backlog slows the next stream, clamps legacy 10x callers, and cancels the failed sender', async () => {
  plan = ['backlog', 'ok'];
  const result = transcribe(memo, 'preview', Buffer.alloc(3840 * 3), 10);
  await vi.runAllTimersAsync();
  expect(await result).toBe('Cześć!');
  expect(sockets).toHaveLength(2);
  expect(sockets[0].frames[1] - sockets[0].frames[0]).toBe(80);
  expect(sockets[1].frames[1] - sockets[1].frames[0]).toBe(160);
  expect(sockets[0].frames).toHaveLength(2);
  expect(maxActive).toBe(1);
});

test('preview and line validation share one stream slot, which is released after failure', async () => {
  plan = ['unauthorized', 'ok'];
  const failed = expect(transcribe(memo, 'preview', Buffer.alloc(3840))).rejects.toThrow('unauthorized');
  const good = transcribe(memo, 'line', Buffer.alloc(7680));
  await vi.runAllTimersAsync(); await failed;
  expect(await good).toBe('Cześć!'); expect(maxActive).toBe(1); expect(sockets).toHaveLength(2);
});

test('persistent backlog is bounded to four attempts with decreasing rates', async () => {
  plan = Array(4).fill('backlog');
  const failed = expect(transcribe(memo, 'preview', Buffer.alloc(7680))).rejects.toThrow('backlog');
  await vi.runAllTimersAsync(); await failed;
  expect(sockets).toHaveLength(4);
  expect(sockets.map((s) => s.frames[1] - s.frames[0])).toEqual([80, 160, 320, 320]);
});

test('a long preview has enough time to finish real-time transmission', async () => {
  const good = transcribe(memo, 'long', Buffer.alloc(48000 * 70));
  await vi.runAllTimersAsync();
  expect(await good).toBe('Cześć!'); expect(sockets).toHaveLength(1);
  expect(sockets[0].frames.at(-1)! - sockets[0].frames[0]).toBeGreaterThan(60000);
});

test('transmission waits for the socket buffer to drain', async () => {
  plan = ['buffered'];
  const good = transcribe(memo, 'buffered', Buffer.alloc(7680));
  await vi.runAllTimersAsync(); await good;
  expect(sockets[0].frames[1] - sockets[0].frames[0]).toBeGreaterThanOrEqual(300);
});

test('a verified preview is reused without opening another socket', async () => {
  const audio = Buffer.alloc(7680);
  const first = transcribe(memo, 'preview', audio);
  await vi.runAllTimersAsync(); await first;
  expect(await transcribe(memo, 'preview-again', audio)).toBe('Cześć!');
  expect(sockets).toHaveLength(1);
});

test.each(['early-close', 'malformed'] as Outcome[])('%s cannot publish a partial transcript', async (outcome) => {
  plan = [outcome];
  const failed = expect(transcribe(memo, 'broken', Buffer.alloc(7680))).rejects.toThrow();
  await vi.runAllTimersAsync(); await failed;
  expect(sockets).toHaveLength(1);
});

test('timeouts close the socket, retry finitely and leave no timers behind', async () => {
  plan = Array(4).fill('silent');
  const failed = expect(transcribe(memo, 'silent', Buffer.alloc(3840))).rejects.toThrow('timed out');
  await vi.runAllTimersAsync(); await failed; expect(sockets).toHaveLength(4);
});
