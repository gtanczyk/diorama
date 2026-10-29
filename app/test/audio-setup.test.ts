import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { startStudio, type Studio } from '../src/studio/server.ts';
import { readSoundQuality, writeSoundQuality } from '../src/sound/settings.ts';
import { soundQuality, ttsModel } from '../src/sound/cost.ts';

let root: string, studio: Studio, browser: Browser;
beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-audio-setup-'));
  studio = await startStudio({ root, bin: fileURLToPath(new URL('./fixtures/fake-diorama.mjs', import.meta.url)) });
  browser = await chromium.launch();
}, 60_000);
beforeEach(() => {
  vi.stubEnv('DIORAMA_CONFIG_DIR', path.join(root, 'config'));
  vi.stubEnv('DIORAMA_SOUND', undefined);
  fs.rmSync(path.join(root, 'config'), { recursive: true, force: true });
});
afterEach(() => vi.unstubAllEnvs());
afterAll(async () => { await browser?.close(); await studio?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

test('Setup saves both audio modes across reloads and new CLI processes', async () => {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  try {
    await page.goto(`${studio.url}setup#${studio.token}`);
    const select = page.getByRole('combobox', { name: 'Audio quality', exact: true });
    await expect.poll(() => select.inputValue()).toBe('final');
    for (const quality of ['draft', 'final']) {
      await select.selectOption(quality);
      await expect.poll(() => page.getByRole('region', { name: 'Audio settings' }).getByRole('status').textContent()).toBe('Saved');
      expect(readSoundQuality()).toBe(quality);
      expect(ttsModel()).toBe(quality === 'final' ? 'eleven_multilingual_v2' : 'eleven_flash_v2_5');
      // A new process (as used by Studio jobs) reads the saved choice without restarting Studio.
      const module = new URL('../src/sound/cost.ts', import.meta.url).href;
      expect(execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { soundQuality } from ${JSON.stringify(module)}; process.stdout.write(soundQuality())`], { env: process.env, encoding: 'utf8' })).toBe(quality);
      await page.reload();
      await expect.poll(() => select.inputValue()).toBe(quality);
    }
    await page.screenshot({ path: '/tmp/diorama-audio-setup.png', fullPage: true });
    const invalid = await page.request.post(`${studio.url}api/actions/audio_set`, { headers: { authorization: `Bearer ${studio.token}` }, data: { quality: 'ultra' } });
    expect(invalid.ok()).toBe(false);
    expect(readSoundQuality()).toBe('final');
  } finally { await page.close(); }
}, 30_000);

test('environment override is visible and blocks ineffective saves; CLI flags still win', async () => {
  writeSoundQuality('final');
  vi.stubEnv('DIORAMA_SOUND', 'draft');
  const page = await browser.newPage();
  try {
    await page.goto(`${studio.url}setup#${studio.token}`);
    const select = page.getByRole('combobox', { name: 'Audio quality', exact: true });
    await expect.poll(() => select.inputValue()).toBe('draft');
    expect(await select.isDisabled()).toBe(true);
    expect(await page.getByText('Set by DIORAMA_SOUND=draft.', { exact: false }).count()).toBe(1);
    const blocked = await page.request.post(`${studio.url}api/actions/audio_set`, { headers: { authorization: `Bearer ${studio.token}` }, data: { quality: 'final' } });
    expect(blocked.ok()).toBe(false);
    expect(readSoundQuality()).toBe('final');
    expect(soundQuality()).toBe('draft');
    expect(soundQuality(['--final'])).toBe('final');
  } finally { await page.close(); }
}, 30_000);

test('a failed save stays visible and does not claim the selected mode was saved', async () => {
  const page = await browser.newPage();
  try {
    await page.goto(`${studio.url}setup#${studio.token}`);
    const section = page.getByRole('region', { name: 'Audio settings' });
    const select = page.getByRole('combobox', { name: 'Audio quality', exact: true });
    await expect.poll(() => select.isEnabled()).toBe(true);
    await page.route('**/api/actions/audio_set', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'Cannot save audio settings' }) }));
    await select.selectOption('draft');
    await expect.poll(() => section.getByRole('alert').textContent()).toBe('Cannot save audio settings');
    expect(await section.getByRole('status').textContent()).toBe('');
    expect(await select.inputValue()).toBe('final');
    expect(readSoundQuality()).toBe('final');
  } finally { await page.close(); }
}, 30_000);
