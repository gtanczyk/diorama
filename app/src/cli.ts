// How to run diorama again from this shell, so every hint (setup fixes, errors, the Studio's Setup cards, the
// agent's prompt) shows a command that works: `npx @gtanczyk/diorama` when it was started through npx, `diorama`
// when the global install is on PATH, `npm run diorama --` from a checkout.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BIN = path.join(ROOT, 'app', 'bin', 'diorama.mjs');
const PACKAGE = '@gtanczyk/diorama';

const real = (p: string) => {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
};

/** A `diorama` on PATH that is this very package (npx and npm scripts put their own node_modules/.bin first: not those). */
function globalOnPath(): boolean {
  const mine = real(BIN);
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir || dir.split(/[\\/]/).slice(-2).join('/') === 'node_modules/.bin') continue;
    if (real(path.join(dir, 'diorama')) === mine) return true;
    // Windows: npm's global shim sits next to the package's node_modules folder, not as a link.
    if (process.platform === 'win32' && fs.existsSync(path.join(dir, 'diorama.cmd')) && real(path.join(dir, 'node_modules', '@gtanczyk', 'diorama')) === real(ROOT)) return true;
  }
  return false;
}

function detect(): string {
  if (process.env.DIORAMA_CLI) return process.env.DIORAMA_CLI;
  const parts = ROOT.split(/[\\/]/);
  if (parts.includes('_npx')) return `npx ${PACKAGE}`;
  if (globalOnPath()) return 'diorama';
  if (!parts.includes('node_modules') && fs.existsSync(path.join(ROOT, '.git'))) return 'npm run diorama --';
  return `npx ${PACKAGE}`;
}

let prefix: string | null = null;

/** The command to type for `diorama <rest>` here, e.g. cli('browsers') → `npx @gtanczyk/diorama browsers`. */
export function cli(rest = ''): string {
  prefix ??= detect();
  return rest ? `${prefix} ${rest}` : prefix;
}

/** Rewrites the `diorama <command>` a message names (a usage line, an error) into the command that works here. */
export function cliText(text: string): string {
  if (cli() === 'diorama') return text;
  return text.replace(/(^|usage: |`|run )diorama (?=[a-z])/g, (_, lead: string) => `${lead}${cli()} `);
}
