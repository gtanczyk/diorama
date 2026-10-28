// Locks keep the agent's hands off what the person is working on: a locked world or place refuses the
// agent's jobs and undo. The person's own actions go through; a lock only the person can lift.
import fs from 'node:fs';
import path from 'node:path';

export type Lock = { by: string; at: string };
export type Locks = { world?: Lock; places: Record<string, Lock> };

const file = (dir: string) => path.join(dir, 'studio', 'locks.json');

export function readLocks(dir: string): Locks {
  try {
    return { places: {}, ...(JSON.parse(fs.readFileSync(file(dir), 'utf8')) as Partial<Locks>) };
  } catch {
    return { places: {} };
  }
}

export function writeLocks(dir: string, locks: Locks) {
  fs.mkdirSync(path.dirname(file(dir)), { recursive: true });
  fs.writeFileSync(file(dir), `${JSON.stringify(locks, null, 2)}\n`);
}

/** Why the agent may not change this world (or, given one, this place) now, or null. */
export function agentBlocked(dir: string, by: string, place?: string): string | null {
  if (by !== 'agent') return null;
  const locks = readLocks(dir);
  if (locks.world) return `the person locked this world (${locks.world.at}); ask them to unlock it`;
  if (place) return locks.places[place] ? `the person locked ${place}; ask them to unlock it` : null;
  const places = Object.keys(locks.places);
  if (places.length) return `the person locked ${places.join(', ')}; a build would touch every place, so ask them first`;
  return null;
}
