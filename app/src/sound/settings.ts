// Machine-wide audio quality, shared by Studio and CLI jobs.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { configDir } from '../secrets.ts';
import type { Quality } from './cost.ts';

const file = () => path.join(configDir(), 'sound.json');

export function readSoundQuality(): Quality {
  let raw: string;
  try { raw = fs.readFileSync(file(), 'utf8'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'final'; throw e; }
  const quality = JSON.parse(raw).quality;
  if (quality !== 'final' && quality !== 'draft') throw new Error('Saved audio quality must be final or draft');
  return quality;
}

export function writeSoundQuality(quality: Quality) {
  if (quality !== 'final' && quality !== 'draft') throw new Error('Audio quality must be final or draft');
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ quality }, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
  } finally { fs.rmSync(tmp, { force: true }); }
}
