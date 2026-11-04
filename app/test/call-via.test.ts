import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { callVia, MUSE_VOICE } from '../src/meta/memo.ts';
import { callCounts } from '../src/actions/world.ts';

describe('callVia', () => {
  it('tells Muse Voice transcripts from ElevenLabs speech in the voice memo, old logs included', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'via-'));
    fs.mkdirSync(path.join(dir, 'memo', 'voice'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'memo', 'voice', 'tts.mp3'), '');
    fs.writeFileSync(path.join(dir, 'memo', 'voice', 'asr.txt'), 'hi');
    const rows = [
      { model: 'voice', hash: 'tts', hit: false },
      { model: 'voice', hash: 'asr', hit: false },
      { model: 'voice', hash: 'new', hit: false, via: MUSE_VOICE },
      { model: 'voice', hash: 'tts', hit: true },
    ];
    fs.writeFileSync(path.join(dir, 'memo', 'calls.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(callVia(dir, rows[0])).toBeUndefined();
    expect(callVia(dir, rows[1])).toBe(MUSE_VOICE);
    expect(callCounts(dir, true)).toEqual({ 'voice|': 1, [`voice|${MUSE_VOICE}`]: 2 });
  });
});
