// What is wrong with a place, in one line, and the step to rebuild it from: a step the last build set aside the
// place at (build.json), a step an earlier job never got it past (a missing file), or verify's first error.
import fs from 'node:fs';
import path from 'node:path';
import { PLACE_STEPS, placeGap, STEPS } from '../commands/build.ts';
import type { Verdict } from '../scene/verify.ts';
import { currentVerdict } from '../scene/status.ts';
import { refusedByFilter } from '../scene/words.ts';

type Step = (typeof STEPS)[number];
export type Trouble = { why: string; from: string | null; errors: string[] };

const readJson = <T>(file: string): T | null => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
};

/** The short reason a failed step gives, without the model API's JSON. */
function said(step: string, error: string): string {
  if (refusedByFilter(new Error(error))) return `${step}: the image safety filter refused the painting`;
  if (/never got past/.test(error)) return error.split(':')[0];
  return `${step}: ${error.replace(/\s*\{.*$/s, '').slice(0, 140)}`;
}

/** Null when the place is playable or not built far enough to tell. */
export function placeTrouble(worldDir: string, place: string): Trouble | null {
  const dir = path.join(worldDir, 'places', place);
  const log = readJson<{ steps?: Record<string, unknown>; places?: Array<{ place: string; from?: string; errors?: string[] }> }>(path.join(worldDir, 'build.json'));
  const report = log?.places?.find((r) => r.place === place);
  // A step an earlier job never got the place past, once the world's build went on beyond it (not while it builds).
  // Only place steps count: the cast, voices and sound run alongside and finish while a place is still being cut out.
  const gap = fs.existsSync(path.join(dir, 'blockin.png')) ? placeGap(dir, 'verify') : null;
  const past = gap && [...Object.keys(log?.steps ?? {}), ...(report?.from ? [report.from] : [])].some((s) => PLACE_STEPS.includes(s as Step) && STEPS.indexOf(s as Step) > STEPS.indexOf(gap.step));
  const gapFirst = gap && past && (!report?.from || STEPS.indexOf(gap.step) < STEPS.indexOf(report.from as Step));
  if (gapFirst) return { why: `${gap.step} never finished here (no ${gap.file})`, from: gap.step, errors: report?.errors ?? [] };
  if (report?.from) return { why: said(report.from, firstError(report.errors)), from: report.from, errors: report.errors ?? [] };
  const verdict = currentVerdict(worldDir, place);
  if (verdict && !verdict.ok) {
    const lines = verdict.errors.map((x) => `${x.code}${x.key ? ` ${x.key}` : ''}: ${x.detail}`);
    return { why: (lines[0] ?? 'not playable').slice(0, 160), from: null, errors: lines };
  }
  return null;
}

const firstError = (errors?: string[]) => (errors?.[0] ?? '').replace(/^STEP_FAILED \S+: /, '');
