// Undo for everything the Studio runs: before a job or an edit touches a world, its files are snapshotted
// under worlds/<slug>/studio/history/. Files are stored once by content hash, so a snapshot after the
// first costs only what changed. The memo (model answers) is not part of it: it never changes meaning.
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type Snapshot = { id: string; at: string; label: string; by: string; files: Record<string, string> };
type Index = Record<string, { size: number; mtimeMs: number; hash: string }>;

const SKIP = new Set(['memo', 'studio']);

function walk(dir: string, rel = ''): string[] {
  if (!fs.existsSync(path.join(dir, rel))) return [];
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((d) => {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (!rel && SKIP.has(d.name)) return [];
    if (d.isDirectory()) return walk(dir, r);
    return d.isFile() && !d.name.endsWith('.tmp') ? [r] : [];
  });
}

export class History {
  readonly home: string;

  constructor(readonly dir: string) {
    this.home = path.join(dir, 'studio', 'history');
  }

  private blob(hash: string) {
    return path.join(this.home, 'blobs', hash.slice(0, 2), hash);
  }

  /** The world's files right now, by content hash (rehashing only files whose size or mtime moved). */
  current(): Record<string, string> {
    const indexFile = path.join(this.home, 'index.json');
    let index: Index = {};
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Index;
    } catch {}
    const files: Record<string, string> = {};
    const next: Index = {};
    for (const rel of walk(this.dir)) {
      const at = path.join(this.dir, rel);
      const stat = fs.statSync(at);
      const known = index[rel];
      const hash = known && known.size === stat.size && known.mtimeMs === stat.mtimeMs
        ? known.hash
        : createHash('sha256').update(fs.readFileSync(at)).digest('hex');
      if (!fs.existsSync(this.blob(hash))) {
        fs.mkdirSync(path.dirname(this.blob(hash)), { recursive: true });
        fs.copyFileSync(at, this.blob(hash), fs.constants.COPYFILE_FICLONE);
      }
      files[rel] = hash;
      next[rel] = { size: stat.size, mtimeMs: stat.mtimeMs, hash };
    }
    fs.mkdirSync(this.home, { recursive: true });
    fs.writeFileSync(indexFile, JSON.stringify(next));
    return files;
  }

  list(): Snapshot[] {
    if (!fs.existsSync(this.home)) return [];
    return fs.readdirSync(this.home)
      .filter((f) => /^\d{8}T\d{6}-[0-9a-f]{4}\.json$/.test(f))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.home, f), 'utf8')) as Snapshot)
      // Newest first by time to the millisecond: ids only say the second.
      .sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  }

  /** Records the world as it is before `label`. Nothing new when nothing changed since the last snapshot. */
  snapshot(label: string, by: string): Snapshot {
    const files = this.current();
    const last = this.list()[0];
    const same = last && Object.keys(last.files).length === Object.keys(files).length && Object.entries(files).every(([f, h]) => last.files[f] === h);
    // Strictly after the last one, so two snapshots in the same millisecond keep their order.
    const at = new Date(Math.max(Date.now(), last ? Date.parse(last.at) + 1 : 0));
    const snap: Snapshot = { id: `${at.toISOString().replace(/[-:]/g, '').slice(0, 15)}-${randomBytes(2).toString('hex')}`, at: at.toISOString(), label, by, files };
    if (same) return last;
    fs.writeFileSync(path.join(this.home, `${snap.id}.json`), JSON.stringify(snap));
    return snap;
  }

  /** Puts the world back as it was in snapshot `id`; what is there now is snapshotted first, so undo can be undone. */
  restore(id: string, by: string, kind: 'undo' | 'redo' = 'undo'): { restored: string[]; removed: string[]; before: string } {
    const target = this.list().find((s) => s.id === id);
    if (!target) throw new Error(`no snapshot ${id}`);
    const before = this.snapshot(`before ${kind} to ${id}`, by);
    const restored: string[] = [];
    const removed: string[] = [];
    for (const [rel, hash] of Object.entries(target.files)) {
      if (before.files[rel] === hash) continue;
      const at = path.join(this.dir, rel);
      fs.mkdirSync(path.dirname(at), { recursive: true });
      fs.copyFileSync(this.blob(hash), at);
      restored.push(rel);
    }
    for (const rel of Object.keys(before.files)) {
      if (target.files[rel]) continue;
      fs.rmSync(path.join(this.dir, rel), { force: true });
      removed.push(rel);
    }
    return { restored, removed, before: before.id };
  }

  /** What changed from one snapshot to the next (or to now). */
  static diff(a: Record<string, string>, b: Record<string, string>): { added: string[]; changed: string[]; removed: string[] } {
    return {
      added: Object.keys(b).filter((f) => !(f in a)),
      changed: Object.keys(b).filter((f) => f in a && a[f] !== b[f]),
      removed: Object.keys(a).filter((f) => !(f in b)),
    };
  }
}
