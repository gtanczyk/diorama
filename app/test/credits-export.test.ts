import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { scene } from './fixtures/scene.ts';
import { exportWorld } from '../src/commands/export.ts';
import { World } from '../src/world/schema.ts';

test('a world with a credits page keeps it in world.json and its export links to it beside the home link', async () => {
  const cwd = process.cwd(), root = fs.mkdtempSync(path.join(os.tmpdir(), 'credits-export-'));
  try {
    await scene(path.join(root, 'worlds'), true);
    const file = path.join(root, 'worlds/w/world.json');
    const world = JSON.parse(fs.readFileSync(file, 'utf8'));
    world.credits = { url: 'builders.html', label: 'All 368 builders' };
    fs.writeFileSync(file, JSON.stringify(world));
    expect(World.parse(world).credits).toEqual({ url: 'builders.html', label: 'All 368 builders' });
    process.chdir(root);
    const out = path.join(root, 'export');
    await exportWorld('w', out, '../');
    const page = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
    expect(page).toContain('<a id="credits" href="builders.html">All 368 builders</a>');
    expect(page.indexOf('id="home"')).toBeLessThan(page.indexOf('id="credits"'));
    expect(JSON.parse(fs.readFileSync(path.join(out, 'world-data.json'), 'utf8')).world.credits.url).toBe('builders.html');
  } finally { process.chdir(cwd); fs.rmSync(root, { recursive: true, force: true }); }
}, 15_000);
