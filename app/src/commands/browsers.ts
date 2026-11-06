// diorama browsers: downloads Chromium for the Playwright that ships with diorama, so explore, playthrough and
// sprites work the same from a checkout, a global install or npx (a bare `npx playwright` may fetch another version).
// `diorama setup` and the Studio's Setup page offer the same download, so nobody has to find this command.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineCommand } from '../registry.ts';

/** Runs Playwright's installer for Chromium; `onLine` gets its output (the terminal gets it as is when absent). */
export async function installChromium(args: string[] = [], onLine?: (line: string) => void): Promise<void> {
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
  const code = await new Promise<number>((resolve) => {
    // Loaded through -e so argv[1] is not the npx cache path, which makes Playwright warn about missing project dependencies.
    const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(cli)})`, 'diorama-browsers', 'install', 'chromium', ...args], { stdio: onLine ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    if (onLine) {
      for (const stream of [child.stdout, child.stderr]) {
        let rest = '';
        stream?.setEncoding('utf8').on('data', (chunk: string) => {
          const lines = (rest + chunk).split(/\r?\n|\r/);
          rest = lines.pop() ?? '';
          for (const line of lines) if (line.trim()) onLine(line);
        });
      }
    }
    child.on('error', () => resolve(1));
    child.on('close', (c) => resolve(c ?? 1));
  });
  if (code !== 0) throw new Error(`playwright install chromium exited with ${code}`);
}

defineCommand({
  name: 'browsers',
  usage: 'browsers                download Chromium for explore, playthrough and sprites (Playwright, ~150 MB, once)',
  async run(args) {
    await installChromium(args);
  },
});
