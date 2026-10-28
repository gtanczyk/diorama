// Where a world lives on disk. Every step reads and writes plain files under worlds/<slug>/.
import fs from 'node:fs';
import path from 'node:path';
import { Memo } from '../meta/memo.ts';
import { World } from './schema.ts';

/**
 * The world with each place's thing list as the person edited it (places/<key>/corrections.json): props taken
 * off the list are gone, props added are there. world.json stays as Spark wrote it; every step reads this.
 */
export function withThingEdits(world: World, dir: string): World {
  const places = world.places.map((place) => {
    const file = path.join(dir, 'places', place.key, 'corrections.json');
    if (!fs.existsSync(file)) return place;
    let c: { things?: Record<string, { removed?: boolean }>; added?: Record<string, { looks?: string }> };
    try {
      c = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return place;
    }
    const removed = new Set(Object.entries(c.things ?? {}).filter(([, t]) => t?.removed).map(([k]) => k));
    const added = Object.entries(c.added ?? {}).filter(([k, a]) => !place.things.some((t) => t.key === k) && typeof a?.looks === 'string');
    if (!removed.size && !added.length) return place;
    // Only props: an exit, an item or a person belongs to the story, which changes with story_redo.
    const taken = place.things.filter((t) => t.role === 'prop' && removed.has(t.key)).map((t) => t.key);
    const things = [...place.things.filter((t) => !taken.includes(t.key)), ...added.map(([key, a]) => ({ key, role: 'prop' as const, looks: a.looks! }))];
    return things.length ? { ...place, things: things.slice(0, 10), ...(taken.length && { taken }) } : place;
  });
  return { ...world, places };
}

export class WorldFiles {
  readonly dir: string;
  readonly memo: Memo;

  constructor(readonly slug: string, root = 'worlds') {
    this.dir = path.resolve(root, slug);
    this.memo = new Memo(path.join(this.dir, 'memo'));
  }

  path(...parts: string[]) {
    return path.join(this.dir, ...parts);
  }

  place(key: string, ...parts: string[]) {
    return this.path('places', key, ...parts);
  }

  write(file: string, data: Buffer | string | object) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.isBuffer(data) || typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`);
  }

  readJson(file: string): unknown {
    if (!fs.existsSync(file)) throw new Error(`missing ${path.relative(process.cwd(), file)}: run the step before this one`);
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  world(): World {
    return withThingEdits(World.parse(this.readJson(this.path('world.json'))), this.dir);
  }
}
