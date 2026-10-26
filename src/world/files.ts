// Where a world lives on disk. Every step reads and writes plain files under worlds/<slug>/.
import fs from 'node:fs';
import path from 'node:path';
import { Memo } from '../meta/memo.ts';
import { World } from './schema.ts';

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
    return World.parse(this.readJson(this.path('world.json')));
  }
}
