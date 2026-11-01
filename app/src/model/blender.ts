// Optional local Blender. When it is installed, a rigged figure is put into a calm rest pose (arms down, feet
// under the hips) before the game walks it: src/model/blender/relax.py. Without Blender nothing changes; the
// game turns the bones from the pose TRELLIS built, as before.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { configDir } from '../secrets.ts';

const exec = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RELAX_SCRIPT = path.join(HERE, 'blender', 'relax.py');

/** Machine-wide choice from Setup: use Blender when it is found (default), or not. */
export type BlenderSettings = { enabled: boolean };
const settingsFile = () => path.join(configDir(), 'blender.json');

export function readBlenderSettings(): BlenderSettings {
  try {
    return { enabled: (JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) as Partial<BlenderSettings>).enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export function writeBlenderSettings(settings: BlenderSettings) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(settingsFile(), `${JSON.stringify({ enabled: settings.enabled }, null, 2)}\n`, { mode: 0o600 });
  found = undefined;
}

/** DIORAMA_BLENDER as set: a path, 'off', or undefined. */
export const blenderEnv = () => process.env.DIORAMA_BLENDER;
const envOff = () => /^(0|off|no|false)$/i.test(blenderEnv() ?? '');

/** Where Blender is looked for, in order: DIORAMA_BLENDER (off/0 disables it), PATH, the usual install places. */
function candidates(): string[] {
  const set = blenderEnv();
  if (set !== undefined) return envOff() ? [] : [set];
  const onPath = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((d) => path.join(d, process.platform === 'win32' ? 'blender.exe' : 'blender'));
  return [
    ...onPath,
    '/Applications/Blender.app/Contents/MacOS/Blender',
    path.join(os.homedir(), 'Applications/Blender.app/Contents/MacOS/Blender'),
    '/snap/bin/blender',
    '/usr/bin/blender',
    '/usr/local/bin/blender',
    'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe',
  ];
}

let found: Promise<{ bin: string; version: string } | null> | undefined;

/** The Blender installed here and its version, whether or not Setup turned it off. Blender 3.6+ (glTF attributes, Corrective Smooth). */
export function detectBlender(): Promise<{ bin: string; version: string } | null> {
  found ??= (async () => {
    for (const bin of candidates()) {
      if (!fs.existsSync(bin)) continue;
      try {
        const { stdout } = await exec(bin, ['-b', '--factory-startup', '--version'], { timeout: 60_000 });
        const version = /Blender\s+(\d+\.\d+(?:\.\d+)?)/.exec(stdout)?.[1];
        if (!version) continue;
        const [major, minor] = version.split('.').map(Number);
        if (major < 3 || (major === 3 && minor < 6)) continue;
        return { bin, version };
      } catch {
        continue;
      }
    }
    return null;
  })();
  return found;
}

/** The Blender to use, or null: none installed, or turned off in Setup (or DIORAMA_BLENDER=off). */
export async function findBlender(): Promise<{ bin: string; version: string } | null> {
  if (envOff() || (blenderEnv() === undefined && !readBlenderSettings().enabled)) return null;
  return detectBlender();
}

export async function blenderState() {
  const settings = readBlenderSettings();
  const installed = await detectBlender();
  return { enabled: blenderEnv() !== undefined ? !envOff() : settings.enabled, installed, env: blenderEnv() ?? null,
    active: !!(await findBlender()) };
}

export type RelaxReport = { ok: boolean; height?: number; armTurn?: Record<string, number>; legTurn?: Record<string, number>; maxMove?: number };

/**
 * The rigged glb in a calm rest pose, or null when there is no Blender or it failed (the caller keeps the
 * original). The original surface rides along as the _REST attribute, for the painted views' projection.
 */
export async function relaxPose(glb: Buffer, log: (line: string) => void = () => {}): Promise<{ glb: Buffer; report: RelaxReport } | null> {
  const blender = await findBlender();
  if (!blender) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-relax-'));
  try {
    const [src, dst, rep] = ['in.glb', 'out.glb', 'report.json'].map((f) => path.join(dir, f));
    fs.writeFileSync(src, glb);
    await exec(blender.bin, ['-b', '--factory-startup', '--python-exit-code', '1', '--python', RELAX_SCRIPT, '--', src, dst, rep], { timeout: 300_000, maxBuffer: 1 << 26 });
    const report = JSON.parse(fs.readFileSync(rep, 'utf8')) as RelaxReport;
    if (!report.ok || !fs.existsSync(dst)) return null;
    return { glb: fs.readFileSync(dst), report };
  } catch (error) {
    const e = error as { stderr?: string; message?: string };
    log(`Blender could not relax the pose: ${(e.stderr || e.message || String(error)).trim().split('\n').slice(-3).join(' ')}`);
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
