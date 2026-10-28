// Recheck stored reports against the current scene without writing or calling a model.
import fs from 'node:fs';
import path from 'node:path';
import { Geometry } from '../play/geometry.ts';
import { withThingEdits } from '../world/files.ts';
import { World, type Place } from '../world/schema.ts';
import { verifyPlace, type MaskNotes, type PlateNotes, type Verdict } from './verify.ts';

export function currentVerdict(worldDir: string, key: string, place?: Place): Verdict | null {
  const dir = path.join(worldDir, 'places', key);
  if (!fs.existsSync(path.join(dir, 'verify.json'))) return null;
  let stored: Verdict | undefined;
  try {
    stored = JSON.parse(fs.readFileSync(path.join(dir, 'verify.json'), 'utf8')) as Verdict;
    place ??= withThingEdits(World.parse(JSON.parse(fs.readFileSync(path.join(worldDir, 'world.json'), 'utf8'))), worldDir).places.find((p) => p.key === key);
    if (!place) throw new Error(`no place ${key}`);
    const read = (file: string) => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    return verifyPlace(place, Geometry.parse(read('geometry.json')), read('masks.json') as MaskNotes, fs.existsSync(path.join(dir, 'plates.json')) ? read('plates.json') as PlateNotes : {});
  } catch {
    if (stored?.ok === false) return stored;
    return { ok: false, errors: [{ code: 'VERIFY_INPUTS', detail: 'Current geometry or mask data is missing or invalid: rebuild this place and verify it again.' }], flags: [] };
  }
}
