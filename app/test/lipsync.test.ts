import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { mouthAt } from '../src/play/lipsync.ts';
import { lipSyncData } from '../src/sound/lipsync.ts';
import { WorldFiles } from '../src/world/files.ts';

test('articulation respects cue boundaries, gaps, closure and short coarticulation', () => {
  const sync = { cues: [{ start: 0.1, end: 0.3, value: 'A' as const }, { start: 0.3, end: 0.5, value: 'D' as const }, { start: 0.7, end: 0.8, value: 'F' as const }] };
  expect(mouthAt(sync, 0.05).mouth).toBe('X');
  expect(mouthAt(sync, 0.2)).toMatchObject({ mouth: 'A', mix: 1 });
  expect(mouthAt(sync, 0.31)).toMatchObject({ mouth: 'D', previous: 'A' });
  expect(mouthAt(sync, 0.31).mix).toBeCloseTo(0.01 / 0.035);
  expect(mouthAt(sync, 0.5).mouth).toBe('X');
  expect(mouthAt(sync, 0.71).previous).toBe('X');
  expect(mouthAt(sync, 0.8).mouth).toBe('X');
  expect(mouthAt(sync, undefined).mouth).toBe('X');
  expect(mouthAt(sync, NaN).mouth).toBe('X');
});

test('a regenerated or invalid recording cannot retain stale lip-sync', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-'));
  const files = new WorldFiles('w', root), audio = 'sound/voice/test.mp3';
  try {
    files.write(files.path(audio), Buffer.from('first take'));
    const data = { sha256: createHash('sha256').update('first take').digest('hex'), cues: [{ start: 0, end: 1, value: 'D' }] };
    files.write(files.path('sound/lipsync.json'), { version: 1, byFile: { [audio]: data } });
    expect(lipSyncData(files)[audio].cues[0].value).toBe('D');
    files.write(files.path(audio), Buffer.from('second take'));
    expect(lipSyncData(files)).toEqual({});
    files.write(files.path(audio), Buffer.from('first take'));
    data.cues.push({ start: 0.5, end: 1.5, value: 'F' });
    files.write(files.path('sound/lipsync.json'), { version: 1, byFile: { [audio]: data } });
    expect(lipSyncData(files)).toEqual({});
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
