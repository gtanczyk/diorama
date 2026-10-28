import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import '../src/actions/index.ts';
import { runAction } from '../src/actions/registry.ts';
import { Events } from '../src/studio/events.ts';
import { History } from '../src/studio/history.ts';
import { Jobs } from '../src/studio/jobs.ts';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));

function world() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-history-'));
  roots.push(root);
  const dir = path.join(root, 'w');
  fs.mkdirSync(path.join(dir, 'places', 'a'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'memo'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), '{"v":1}');
  fs.writeFileSync(path.join(dir, 'places', 'a', 'painting.png'), 'paint-1');
  fs.writeFileSync(path.join(dir, 'memo', 'calls.jsonl'), 'x');
  const events = new Events();
  return { root, dir, ctx: (by: 'user' | 'agent') => ({ by, root, events, jobs: new Jobs(events) }) };
}

test('undo puts back changed, added and removed files, and can itself be undone', () => {
  const { dir } = world();
  const history = new History(dir);
  const first = history.snapshot('paint', 'user');
  expect(history.snapshot('again', 'user').id).toBe(first.id);
  fs.writeFileSync(path.join(dir, 'places', 'a', 'painting.png'), 'paint-2');
  fs.writeFileSync(path.join(dir, 'places', 'a', 'masks.json'), '{}');
  fs.rmSync(path.join(dir, 'world.json'));
  fs.writeFileSync(path.join(dir, 'memo', 'calls.jsonl'), 'xy');
  const result = history.restore(first.id, 'user');
  expect(result.restored.sort()).toEqual(['places/a/painting.png', 'world.json']);
  expect(result.removed).toEqual(['places/a/masks.json']);
  expect(fs.readFileSync(path.join(dir, 'places', 'a', 'painting.png'), 'utf8')).toBe('paint-1');
  // The memo is not history: model answers stay.
  expect(fs.readFileSync(path.join(dir, 'memo', 'calls.jsonl'), 'utf8')).toBe('xy');
  history.restore(result.before, 'user');
  expect(fs.readFileSync(path.join(dir, 'places', 'a', 'painting.png'), 'utf8')).toBe('paint-2');
});

test('a locked world refuses the agent but not the person, and only the person unlocks', async () => {
  const { ctx } = world();
  new History(path.join(ctx('user').root, 'w')).snapshot('start', 'user');
  await runAction('lock_set', { slug: 'w', place: 'a', locked: true }, ctx('user'));
  await expect(runAction('history_undo', { slug: 'w' }, ctx('agent'))).rejects.toThrow(/locked a/);
  await expect(runAction('run_step', { slug: 'w', step: 'paint' }, ctx('agent'))).rejects.toThrow(/locked a/);
  await expect(runAction('lock_set', { slug: 'w', place: 'a', locked: false }, ctx('agent'))).rejects.toThrow(/only the person/);
  await runAction('history_undo', { slug: 'w' }, ctx('user'));
  await runAction('lock_set', { slug: 'w', place: 'a', locked: false }, ctx('user'));
  const list = (await runAction('history_list', { slug: 'w' }, ctx('agent'))) as Array<{ label: string }>;
  expect(list.length).toBeGreaterThan(0);
});

test('redo takes back the last undo, only right after it', async () => {
  const { dir, ctx } = world();
  const paint = path.join(dir, 'places', 'a', 'painting.png');
  new History(dir).snapshot('repaint', 'agent');
  fs.writeFileSync(paint, 'paint-2');
  await expect(runAction('history_redo', { slug: 'w' }, ctx('user'))).rejects.toThrow(/nothing to redo/);
  await runAction('history_undo', { slug: 'w' }, ctx('user'));
  expect(fs.readFileSync(paint, 'utf8')).toBe('paint-1');
  await runAction('history_redo', { slug: 'w' }, ctx('user'));
  expect(fs.readFileSync(paint, 'utf8')).toBe('paint-2');
  await expect(runAction('history_redo', { slug: 'w' }, ctx('user'))).rejects.toThrow(/nothing to redo/);
});
