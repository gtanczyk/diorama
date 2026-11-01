// diorama browsers: downloads Chromium for the Playwright that ships with diorama, so explore, playthrough and
// sprites work the same from a checkout, a global install or npx (a bare `npx playwright` may fetch another version).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineCommand } from '../registry.ts';

defineCommand({
  name: 'browsers',
  usage: 'browsers                download Chromium for explore, playthrough and sprites (Playwright, ~150 MB, once)',
  async run(args) {
    const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('playwright/package.json')), 'cli.js');
    const code = await new Promise<number>((resolve) => {
      // Loaded through -e so argv[1] is not the npx cache path, which makes Playwright warn about missing project dependencies.
      const child = spawn(process.execPath, ['-e', `require(${JSON.stringify(cli)})`, 'diorama-browsers', 'install', 'chromium', ...args], { stdio: 'inherit' });
      child.on('error', () => resolve(1));
      child.on('close', (c) => resolve(c ?? 1));
    });
    if (code !== 0) throw new Error(`playwright install chromium exited with ${code}`);
  },
});
