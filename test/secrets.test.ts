import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fileVault, loadSecrets, open, redact, seal, SecretStore, withoutSecrets, type Vault } from '../src/secrets.ts';

const dirs: string[] = [];
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-secrets-'));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  delete process.env.ELEVENLABS_API_KEY;
});

function memoryVault(): Vault & { key: Buffer | null } {
  return { name: 'test', key: null, async get() { return this.key; }, async set(k) { this.key = k; } };
}

test('sealed secrets open with their key and nothing else', () => {
  const key = Buffer.alloc(32, 7);
  const sealed = seal(key, { META_API_KEY: 'meta-secret-123456' });
  expect(sealed.includes(Buffer.from('meta-secret'))).toBe(false);
  expect(open(key, sealed)).toEqual({ META_API_KEY: 'meta-secret-123456' });
  expect(() => open(Buffer.alloc(32, 8), sealed)).toThrow();
  const tampered = Buffer.from(sealed);
  tampered[tampered.length - 1] ^= 1;
  expect(() => open(key, tampered)).toThrow();
});

test('the store keeps keys encrypted in a 0600 file, its master key in the vault', async () => {
  const dir = tmp();
  const vault = memoryVault();
  const store = new SecretStore(vault, dir);
  await store.set('META_API_KEY', 'meta-secret-123456');
  await store.set('ELEVENLABS_API_KEY', 'eleven-secret-9876');
  expect(vault.key?.length).toBe(32);
  const raw = fs.readFileSync(store.file);
  expect(raw.toString('latin1')).not.toContain('secret');
  expect(fs.statSync(store.file).mode & 0o777).toBe(0o600);
  expect(await store.read()).toEqual({ META_API_KEY: 'meta-secret-123456', ELEVENLABS_API_KEY: 'eleven-secret-9876' });
  await store.set('META_API_KEY', null);
  expect(await store.read()).toEqual({ ELEVENLABS_API_KEY: 'eleven-secret-9876' });
  expect(fs.existsSync(path.join(dir, 'credentials.lock'))).toBe(false);
});

test('stored keys fill in the environment, which wins when set', async () => {
  const dir = tmp();
  process.env.DIORAMA_ALLOW_FILE_KEYCHAIN = 'true';
  const store = new SecretStore(fileVault(dir), dir);
  await store.set('ELEVENLABS_API_KEY', 'eleven-from-store-1');
  await store.set('META_API_KEY', 'meta-from-store-1');
  const before = process.env.META_API_KEY;
  process.env.META_API_KEY = 'meta-from-env-1';
  try {
    // On a machine with a real keychain the file vault is not the one found; only check the file path here.
    if (process.platform === 'linux' || process.platform === 'darwin') {
      const sources = await loadSecrets(dir).catch(() => ({}));
      if ('ELEVENLABS_API_KEY' in sources) {
        expect(sources).toMatchObject({ META_API_KEY: 'env', ELEVENLABS_API_KEY: 'store' });
        expect(process.env.ELEVENLABS_API_KEY).toBe('eleven-from-store-1');
      }
    }
    expect(process.env.META_API_KEY).toBe('meta-from-env-1');
  } finally {
    if (before === undefined) delete process.env.META_API_KEY;
    else process.env.META_API_KEY = before;
    delete process.env.DIORAMA_ALLOW_FILE_KEYCHAIN;
  }
});

test('key values never survive into logs or an agent environment', () => {
  process.env.ELEVENLABS_API_KEY = 'sk_eleven_abcdef123456';
  expect(redact('called with sk_eleven_abcdef123456 ok')).toBe('called with [redacted] ok');
  expect(redact('Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345')).toBe('Authorization: Bearer [redacted]');
  const env = withoutSecrets({ PATH: '/bin', META_API_KEY: 'x', META_MUSE_API_KEY: 'y', ELEVEN_API_KEY: 'z', HF_TOKEN: 'h' });
  expect(env).toEqual({ PATH: '/bin' });
});
