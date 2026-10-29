// Build an extension in a private copy. A failed/cancelled job cannot leave half a game installed.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function files(dir: string, rel = ''): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(path.join(dir, rel))) return out;
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    if (!rel && (entry.name === 'studio' || entry.name === 'memo')) continue;
    const name = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [key, value] of files(dir, name)) out.set(key, value);
    else if (entry.isFile()) out.set(name, createHash('sha256').update(fs.readFileSync(path.join(dir, name))).digest('hex'));
  }
  return out;
}

function retainMemo(staged: string, original: string, callBytes: number) {
  const copy = (from: string, to: string) => {
    if (!fs.existsSync(from)) return;
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.name === 'calls.jsonl') continue;
      const src = path.join(from, entry.name), dest = path.join(to, entry.name);
      if (entry.isDirectory()) copy(src, dest);
      else if (entry.isFile() && !fs.existsSync(dest)) fs.copyFileSync(src, dest);
    }
  };
  copy(path.join(staged, 'memo'), path.join(original, 'memo'));
  const calls = path.join(staged, 'memo', 'calls.jsonl');
  if (fs.existsSync(calls)) {
    const log = fs.readFileSync(calls).subarray(callBytes);
    if (log.length) fs.appendFileSync(path.join(original, 'memo', 'calls.jsonl'), log);
  }
}

/** The callback runs in an isolated project cwd; commit checks for concurrent edits before changing anything. */
export async function stagedExtension<T>(slug: string, run: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const original = path.join(cwd, 'worlds', slug);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-extend-'));
  const staged = path.join(temp, 'worlds', slug);
  let callBytes: number | undefined;
  try {
    fs.mkdirSync(path.dirname(staged), { recursive: true });
    fs.cpSync(original, staged, { recursive: true, mode: fs.constants.COPYFILE_FICLONE, filter: source => source !== path.join(original, 'studio') });
    const before = files(staged);
    const calls = path.join(staged, 'memo', 'calls.jsonl');
    callBytes = fs.existsSync(calls) ? fs.statSync(calls).size : 0;
    process.chdir(temp);
    const stagedFlag = process.env.DIORAMA_STAGED_BUILD;
    process.env.DIORAMA_STAGED_BUILD = '1';
    let result: T;
    try { result = await run(); } finally {
      process.chdir(cwd);
      if (stagedFlag === undefined) delete process.env.DIORAMA_STAGED_BUILD;
      else process.env.DIORAMA_STAGED_BUILD = stagedFlag;
    }
    const after = files(staged);
    const changed = [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key));
    const current = files(original);
    // Any source change can invalidate the staged build, even if that source file itself was not rewritten.
    const conflicts = [...new Set([...before.keys(), ...current.keys()])].filter(key => current.get(key) !== before.get(key));
    if (conflicts.length) throw new Error(`world changed during extension (${conflicts.slice(0, 5).join(', ')}); nothing was installed, try again`);
    // Place the world and script last, after their new visual assets.
    changed.sort((a, b) => Number(a === 'world.json' || a === 'story.json') - Number(b === 'world.json' || b === 'story.json'));
    const backup = path.join(temp, 'backup');
    for (const key of changed) if (before.has(key)) {
      const target = path.join(backup, key);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(original, key), target, fs.constants.COPYFILE_FICLONE);
    }
    const installed: string[] = [];
    try {
      for (const key of changed) {
        const target = path.join(original, key);
        if (!after.has(key)) fs.rmSync(target, { force: true });
        else {
          fs.mkdirSync(path.dirname(target), { recursive: true });
          const temporary = `${target}.extend-tmp`;
          try {
            fs.copyFileSync(path.join(staged, key), temporary, fs.constants.COPYFILE_FICLONE);
            fs.renameSync(temporary, target);
          } finally { fs.rmSync(temporary, { force: true }); }
        }
        installed.push(key);
      }
    } catch (error) {
      for (const key of installed.reverse()) {
        const target = path.join(original, key);
        if (before.has(key)) fs.copyFileSync(path.join(backup, key), target);
        else fs.rmSync(target, { force: true });
      }
      throw error;
    }
    return result;
  } finally {
    process.chdir(cwd);
    // Even a failed generation consumed calls; retain the immutable cache and its accounting.
    if (callBytes !== undefined) {
      try { retainMemo(staged, original, callBytes); }
      catch (error) { console.error(`could not retain extension memo: ${error instanceof Error ? error.message : error}`); }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}
