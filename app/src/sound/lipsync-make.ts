// Offline, cached analysis of the final recordings. No TTS request and no changes to paid audio.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import type { WorldFiles } from '../world/files.ts';
import { sha256 } from '../scene/faces-data.ts';
import { MOUTHS, type LipSync } from '../play/lipsync.ts';
import { decode, envelope, RATE } from './pcm.ts';
import { lipSyncData } from './lipsync.ts';

const exec = promisify(execFile);
const VERSION = '1.14.0';
const Cue = z.object({ start: z.number().nonnegative(), end: z.number().positive(), value: z.enum(MOUTHS as ['X', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H']) }).refine(c => c.end > c.start);
export type SyncEntry = LipSync & { sha256: string };
export type SyncManifest = { version: 1; recognizer: string; byFile: Record<string, SyncEntry>; failures?: Array<{ speaker: string; text: string; reason: string }> };

/** A pinned official release, kept locally. An explicit executable is useful on managed machines. */
export async function rhubarbExecutable(explicit = process.env.DIORAMA_RHUBARB): Promise<string> {
  if (explicit) { await exec(explicit, ['--version']); return explicit; }
  try { await exec('rhubarb', ['--version']); return 'rhubarb'; } catch { /* Prepare the local dependency. */ }
  const platform = process.platform === 'darwin' ? 'macOS' : process.platform === 'linux' ? 'Linux' : process.platform === 'win32' ? 'Windows' : undefined;
  if (!platform) throw new Error('Install Rhubarb Lip Sync and set DIORAMA_RHUBARB to its executable');
  const name = `Rhubarb-Lip-Sync-${VERSION}-${platform}`;
  const root = process.env.DIORAMA_TOOLS_DIR ?? path.join(process.env.DIORAMA_CACHE ?? path.join(os.homedir(), '.cache', 'diorama'), 'tools');
  const executable = path.join(root, name, `rhubarb${process.platform === 'win32' ? '.exe' : ''}`);
  if (fs.existsSync(executable)) { await exec(executable, ['--version']); return executable; }
  fs.mkdirSync(root, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(root, '.rhubarb-'));
  try {
    console.log(`faces: preparing Rhubarb ${VERSION} (${platform})`);
    const response = await fetch(`https://github.com/DanielSWolf/rhubarb-lip-sync/releases/download/v${VERSION}/${name}.zip`, { signal: AbortSignal.timeout(120_000) });
    if (!response.ok) throw new Error(`Rhubarb download: HTTP ${response.status}`);
    const archive = path.join(temporary, 'rhubarb.zip');
    fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
    if (process.platform === 'win32') await exec('tar', ['-xf', archive, '-C', temporary]);
    else await exec('unzip', ['-q', archive, '-d', temporary]);
    const unpacked = path.join(temporary, name);
    const binary = path.join(unpacked, path.basename(executable));
    if (process.platform !== 'win32') fs.chmodSync(binary, 0o755);
    await exec(binary, ['--version']);
    // A concurrent run may have installed the same release while this one downloaded it.
    if (!fs.existsSync(executable)) fs.renameSync(unpacked, path.dirname(executable));
    return executable;
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export async function analyseRecording(audio: string, executable: string, language?: string): Promise<LipSync> {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-lipsync-'));
  try {
    const wav = path.join(temporary, 'line.wav'), json = path.join(temporary, 'cues.json');
    await exec('ffmpeg', ['-v', 'error', '-y', '-i', audio, '-ac', '1', '-ar', '16000', wav]);
    await exec(executable, ['-r', /^(en|english)\b/i.test(language ?? '') ? 'pocketSphinx' : 'phonetic', '-f', 'json', '--quiet', '-o', json, wav], { timeout: 120_000 });
    const cues = z.array(Cue).parse(JSON.parse(fs.readFileSync(json, 'utf8')).mouthCues);
    if (!cues.length || cues.some((c, i) => i > 0 && c.start < cues[i - 1].end)) throw new Error('Rhubarb returned an empty or overlapping timeline');
    const pcm = decode(fs.readFileSync(audio));
    if (cues.at(-1)!.end > pcm.left.length / RATE + 0.05) throw new Error('Rhubarb timeline exceeds the recording');
    const rms = envelope(pcm, 40);
    const sorted = [...rms].sort((a, b) => a - b), scale = sorted[Math.floor(sorted.length * 0.95)] || 1;
    return { cues, step: 0.04, envelope: rms.map(v => Math.round(Math.min(1, v / scale) * 100) / 100) };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}

export async function prepareLipSync(files: WorldFiles, only: string[] = [], explicit?: string): Promise<SyncManifest> {
  const recordings = files.readJson(files.path('voices.json')) as { lines: Array<{ speaker: string; text: string; file: string }> };
  const previous = lipSyncData(files);
  const byFile: SyncManifest['byFile'] = {};
  const failures: NonNullable<SyncManifest['failures']> = [];
  let executable: Promise<string> | undefined;
  const language = files.world().language;
  for (const line of recordings.lines) {
    if (line.speaker === 'narrator' || !fs.existsSync(files.path(line.file))) continue;
    const sha = sha256(fs.readFileSync(files.path(line.file)));
    if (previous[line.file]) { byFile[line.file] = { ...previous[line.file], sha256: sha }; continue; }
    if (only.length && !only.includes(line.speaker)) continue;
    try {
      executable ??= rhubarbExecutable(explicit);
      byFile[line.file] = { ...await analyseRecording(files.path(line.file), await executable, language), sha256: sha };
      console.log(`${line.speaker}: lip-sync ${byFile[line.file].cues.length} cues — ${line.text.slice(0, 70)}`);
    } catch (e) { failures.push({ speaker: line.speaker, text: line.text, reason: String(e instanceof Error ? e.message : e) }); }
  }
  const manifest: SyncManifest = { version: 1, recognizer: `rhubarb-${VERSION}`, byFile, failures };
  const target = files.path('sound', 'lipsync.json');
  files.write(`${target}.tmp`, manifest);
  fs.renameSync(`${target}.tmp`, target);
  return manifest;
}

/** Existing speaking characters keep their timing when a voice is retried; preparing art is a separate operation. */
export async function refreshExistingLipSync(files: WorldFiles, only: string[] = []) {
  if (!fs.existsSync(files.path('sound', 'lipsync.json'))) return;
  try {
    const result = await prepareLipSync(files, only);
    if (result.failures?.length) console.log(`warning: ${result.failures.length} lines need lip-sync preparation; recordings are retained`);
  } catch (e) { console.log(`warning: lip-sync preparation failed; recordings are retained: ${e instanceof Error ? e.message : e}`); }
}
