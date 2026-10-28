import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { inputHash, Memo } from '../src/meta/memo.ts';
import { jsonIn } from '../src/meta/spark.ts';

describe('Memo', () => {
  test('asks once per input and counts only sent calls', async () => {
    const memo = new Memo(fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-memo-')));
    let asked = 0;
    const ask = async () => Buffer.from(`reply ${++asked}`);
    const hash = inputHash('model', 'prompt');
    expect(String(await memo.remember('spark', 'a', hash, 'txt', ask))).toBe('reply 1');
    expect(String(await memo.remember('spark', 'a', hash, 'txt', ask))).toBe('reply 1');
    expect(asked).toBe(1);
    expect(memo.sent.spark).toBe(1);
    memo.forget('spark', hash, 'txt');
    expect(String(await memo.remember('spark', 'a', hash, 'txt', ask))).toBe('reply 2');
  });

  test('hash keeps part boundaries', () => {
    expect(inputHash('ab', 'c')).not.toBe(inputHash('a', 'bc'));
  });
});

test('jsonIn finds JSON inside prose and code fences', () => {
  expect(jsonIn('Here you go:\n```json\n{"scenes": 3}\n```')).toEqual({ scenes: 3 });
  expect(() => jsonIn('no json')).toThrow();
});
