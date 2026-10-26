// While `diorama studio` runs, ~/.config/diorama/studio/<hash of the folder>.json (0600) tells `diorama mcp`
// started in the same folder where it is and the agent's token. It is removed when the Studio stops.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../secrets.ts';

type StudioFile = { url: string; agentToken: string; pid: number; cwd: string };

const fileFor = (cwd: string) => path.join(configDir(), 'studio', `${createHash('sha256').update(path.resolve(cwd)).digest('hex').slice(0, 16)}.json`);

export function writeStudioFile(cwd: string, info: Omit<StudioFile, 'pid' | 'cwd'>): () => void {
  const file = fileFor(cwd);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify({ ...info, pid: process.pid, cwd: path.resolve(cwd) }), { mode: 0o600 });
  return () => fs.rmSync(file, { force: true });
}

/** The running Studio for this folder, or null (no file, or its process is gone). */
export function readStudioFile(cwd: string): StudioFile | null {
  try {
    const info = JSON.parse(fs.readFileSync(fileFor(cwd), 'utf8')) as StudioFile;
    process.kill(info.pid, 0);
    return info;
  } catch {
    return null;
  }
}
