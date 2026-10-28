import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { earlier, pastTurns } from '../src/studio/agent.ts';

test('a fresh agent session is pointed at the conversation so far, and only when there is one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-convo-'));
  try {
    expect(earlier(dir)).toBe('');
    fs.mkdirSync(path.join(dir, 'studio'));
    fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), '');
    expect(earlier(dir)).toBe('');
    fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), '## 2026-10-28 09:00 · muse\n\n**Person:** the hero walks into the table\n');
    expect(earlier(dir)).toContain('studio/conversation.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('after a restart the page gets the earlier turns back from the session logs, cut-off ones ended', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-past-'));
  const turn = (id: number, text: string, extra = {}) => ({ id, agent: 'muse', prompt: `ask ${id}`, startedAt: id, entries: [{ kind: 'text', text, streaming: true }, { kind: 'tool', name: 'x', done: false }], ...extra });
  const line = (t: object) => JSON.stringify({ at: 'now', type: 'state', agent: 'muse', status: 'idle', turn: t });
  try {
    expect(pastTurns(dir)).toEqual([]);
    fs.mkdirSync(path.join(dir, 'studio', 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'studio', 'sessions', '20261028T0900-aa.jsonl'), [line(turn(1, 'th')), line(turn(1, 'the end', { endedAt: 5 })), JSON.stringify({ type: 'user', text: 'x' }), 'not json'].join('\n'));
    fs.writeFileSync(path.join(dir, 'studio', 'sessions', '20261028T1000-bb.jsonl'), line(turn(1, 'cut off')));
    const past = pastTurns(dir);
    expect(past.map((t) => t.prompt)).toEqual(['ask 1', 'ask 1']);
    expect(past.map((t) => t.id)).toEqual([-2, -1]);
    expect(past[0].entries[0]).toMatchObject({ text: 'the end', streaming: false });
    expect(past[1].endedAt).toBe(1);
    expect(past[1].entries[1]).toMatchObject({ done: true });
    expect(pastTurns(dir, 1).map((t) => (t.entries[0] as { text: string }).text)).toEqual(['cut off']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
