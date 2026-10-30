import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { WorldFiles } from '../src/world/files.ts';
import { prepareLipSync } from '../src/sound/lipsync-make.ts';
import { scene } from './fixtures/scene.ts';

function wave(seconds: number) {
  const rate = 8000, n = Math.round(seconds * rate), b = Buffer.alloc(44 + n * 2);
  b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 220 / rate) * 3000), 44 + i * 2);
  return b;
}

test('audio preparation caches final recordings, preserves other speakers and reanalyses only changed bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lipsync-prepare-'));
  try {
    await scene(root); const files = new WorldFiles('w', root), counter = path.join(root, 'counter');
    const executable = path.join(root, 'rhubarb.mjs');
    fs.writeFileSync(executable, `#!/usr/bin/env node\nimport fs from 'node:fs';if(process.argv.includes('--version'))process.exit(0);fs.appendFileSync(${JSON.stringify(counter)},'1');fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({mouthCues:[{start:0,end:0.2,value:'D'}]}));`);
    fs.chmodSync(executable, 0o755);
    const first = wave(0.3), second = wave(0.4);
    files.write(files.path('sound/voice/one.mp3'), first); files.write(files.path('sound/voice/two.mp3'), first);
    files.write(files.path('voices.json'), { lines: [{ speaker: 'hero', text: 'One', file: 'sound/voice/one.mp3' }, { speaker: 'guard', text: 'Two', file: 'sound/voice/two.mp3' }] });
    let result = await prepareLipSync(files, [], executable);
    expect(Object.keys(result.byFile)).toHaveLength(2);
    expect(fs.readFileSync(counter, 'utf8')).toBe('11');
    await prepareLipSync(files, [], executable);
    expect(fs.readFileSync(counter, 'utf8')).toBe('11');
    files.write(files.path('sound/voice/one.mp3'), second);
    result = await prepareLipSync(files, ['hero'], executable);
    expect(Object.keys(result.byFile)).toHaveLength(2);
    expect(fs.readFileSync(counter, 'utf8')).toBe('111');
    expect(fs.readFileSync(files.path('sound/voice/one.mp3')).equals(second)).toBe(true);
    expect(fs.readFileSync(files.path('sound/voice/two.mp3')).equals(first)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);
