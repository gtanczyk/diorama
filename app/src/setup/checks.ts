// What a machine needs before diorama can build: shown by `diorama setup`, the Studio's Setup screen and
// the setup_status action. A check never returns a key, only where it comes from.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { blenderState } from '../model/blender.ts';
import { envValue, findVault, loadSecrets, NO_VAULT, type SecretName } from '../secrets.ts';

export type Check = {
  id: string;
  label: string;
  /** ok, missing (needed to build), optional (missing but not needed), fail (present but broken). */
  state: 'ok' | 'missing' | 'optional' | 'fail';
  detail: string;
  /** Commands that fix it, typed in a terminal. */
  fix?: string[];
};

function sh(cmd: string, args: string[], timeout = 8000): Promise<string | null> {
  return new Promise((resolve) => execFile(cmd, args, { timeout }, (error, out) => resolve(error ? null : String(out).trim())));
}

async function keyCheck(name: SecretName, label: string, required: boolean, what: string, source?: 'env' | 'store'): Promise<Check> {
  const value = envValue(name);
  if (!value) return { id: name, label, state: required ? 'missing' : 'optional', detail: what, fix: [`diorama setup --key ${name}`] };
  return { id: name, label, state: 'ok', detail: source === 'store' ? 'in your system keychain' : 'from the environment' };
}

export async function runChecks(opts: { live?: boolean } = {}): Promise<Check[]> {
  const sources = await loadSecrets().catch(() => ({}) as Partial<Record<SecretName, 'env' | 'store'>>);
  const checks: Check[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push({ id: 'node', label: 'Node.js', state: major >= 22 ? 'ok' : 'fail', detail: `${process.versions.node}${major >= 22 ? '' : ': diorama needs 22 or newer'}` });

  const vault = await findVault();
  checks.push(vault
    ? { id: 'vault', label: 'Key storage', state: 'ok', detail: vault.name }
    : { id: 'vault', label: 'Key storage', state: 'optional', detail: NO_VAULT });

  const meta = await keyCheck('META_API_KEY', 'Meta Model API key', true, 'Plans, paints and cuts every scene (Muse Spark, Muse Image, SAM 3.1). Needed to build.', sources.META_API_KEY);
  if (meta.state === 'ok' && opts.live) {
    const { askSparkJson } = await import('../meta/spark.ts');
    const { Memo } = await import('../meta/memo.ts');
    const started = Date.now();
    try {
      // A fresh label each time, so the memo cannot answer for the API.
      await askSparkJson(new Memo(path.resolve('.diorama/setup/memo')), { label: 'setup', prompt: `Reply as JSON {"ok": true}. (${Date.now()})` });
      meta.detail += ` · live check ${Date.now() - started} ms`;
    } catch (error) {
      Object.assign(meta, { state: 'fail', detail: `the API refused it: ${error instanceof Error ? error.message.slice(0, 200) : error}` });
    }
  }
  checks.push(meta);

  const muse = await sh('muse', ['--version']);
  // Other agents the Studio can switch to (genaicode drives them the same way, with the Studio's MCP tools).
  const others = await Promise.all([['claude', 'Claude Code'], ['codex', 'Codex'], ['agy', 'Antigravity']].map(async ([cmd, label]) => ({ label, version: await sh(cmd, ['--version']) })));
  const found = others.filter((o) => o.version);
  const install = ['curl -fsSL https://dev.meta.ai/install.sh | bash', 'muse login', 'muse --version'];
  checks.push(muse
    ? { id: 'muse', label: 'Muse Code', state: 'ok', detail: muse.split('\n')[0] }
    : found.length
      // Another agent stands in, so the Studio works; Muse Code stays the recommended one.
      ? { id: 'muse', label: 'Muse Code', state: 'optional', detail: `Not found on PATH, so the Studio's agent is ${found[0].label} for now. Muse Code is the default once installed. macOS and Linux; on Windows use WSL2.`, fix: install }
      : { id: 'muse', label: 'Muse Code', state: 'missing', detail: 'The agent that builds and fixes worlds with you. Not found on PATH. macOS and Linux; on Windows use WSL2.', fix: install });
  checks.push({
    id: 'agents',
    label: 'Other agents',
    state: found.length ? 'ok' : 'optional',
    detail: `${others.map((o) => (o.version ? `${o.label} ${/\d+\.\d+[\w.-]*/.exec(o.version)?.[0] ?? 'found'}` : `${o.label} not found`)).join(' · ')}. Switch in the agent panel; DIORAMA_AGENT=muse, claude, codex or antigravity sets the default.`,
  });

  let chromium: string | null = null;
  try {
    const { chromium: pw } = await import('playwright');
    chromium = pw.executablePath();
  } catch {}
  checks.push(chromium && fs.existsSync(chromium)
    ? { id: 'chromium', label: 'Chromium for Explore and Playthrough', state: 'ok', detail: 'installed' }
    : { id: 'chromium', label: 'Chromium for Explore and Playthrough', state: 'missing', detail: 'Explore and the playthrough bot drive a browser.', fix: ['diorama browsers'] });

  checks.push(await keyCheck('ELEVENLABS_API_KEY', 'ElevenLabs key', false, 'Optional: sound effects, music and voices. Without it the world plays silent.', sources.ELEVENLABS_API_KEY));
  checks.push(await keyCheck('HF_TOKEN', 'Hugging Face token', false, 'Optional: 3D hero figures (TRELLIS, auto-rig) on ZeroGPU Spaces.', sources.HF_TOKEN));
  checks.push(await keyCheck('DIORAMA_ANTHROPIC_API_KEY', 'Anthropic API key', false, 'Optional: with DIORAMA_SPARK_VIA=claude, Spark\'s text and vision asks go to Claude (Sonnet 5.5) instead of Meta.', sources.DIORAMA_ANTHROPIC_API_KEY));
  checks.push(await keyCheck('OPENROUTER_API_KEY', 'OpenRouter key', false, 'Optional: DIORAMA_IMAGE_VIA=gemini-flash, gemini-lite, nano-banana or gemini-pro paints with Gemini instead of Muse Image; DIORAMA_SPARK_VIA=openrouter:<model> for any chat model.', sources.OPENROUTER_API_KEY));
  checks.push(await keyCheck('GEMINI_API_KEY', 'Google Gemini key', false, 'Optional: with DIORAMA_IMAGE_VIA=gemini-flash (or gemini-lite, nano-banana, gemini-pro) Gemini paints straight from Google instead of through OpenRouter.', sources.GEMINI_API_KEY));

  const blender = await blenderState();
  const blenderWhat = 'With Blender 3.6+ installed, 3D figures get a calm rest pose (arms down, feet under the hips) before they walk, so they stop walking straddle-legged with arms out.';
  checks.push(blender.installed
    ? { id: 'blender', label: 'Blender for natural 3D walks', state: blender.enabled ? 'ok' : 'optional',
      detail: blender.enabled ? `Blender ${blender.installed.version} (${blender.installed.bin}): on. Turn it off in Setup.` : `Blender ${blender.installed.version} found but turned off in Setup.` }
    : { id: 'blender', label: 'Blender for natural 3D walks', state: 'optional', detail: `Optional: ${blenderWhat} Without it they walk from the pose TRELLIS built. Or set DIORAMA_BLENDER to its path.`,
      fix: [process.platform === 'darwin' ? 'brew install --cask blender' : 'https://www.blender.org/download/'] });

  const py = process.env.DIORAMA_PYTHON;
  checks.push(!py
    ? { id: 'python', label: 'Python for local music', state: 'optional', detail: 'DIORAMA_PYTHON not set: music comes from ElevenLabs. MusicGen needs torch, transformers, scipy.' }
    : fs.existsSync(py)
      ? { id: 'python', label: 'Python for local music', state: 'ok', detail: py }
      : { id: 'python', label: 'Python for local music', state: 'fail', detail: `DIORAMA_PYTHON points at ${py}, which does not exist` });

  const remote = await sh('git', ['remote', 'get-url', 'origin']);
  checks.push(remote
    ? { id: 'publish', label: 'Publishing', state: 'ok', detail: `git remote ${remote.replace(/\/\/[^@/]+@/, '//')}; diorama publish pushes to gh-pages` }
    : { id: 'publish', label: 'Publishing', state: 'optional', detail: 'No git remote: diorama export --zip still makes an itch.io upload.' });

  return checks;
}
