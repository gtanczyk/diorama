// Keys typed into `diorama setup` are kept encrypted on disk, never as plain text and never in a file the
// repo or a world could pick up. A random 32-byte master key lives in the OS vault (macOS Keychain via
// `security`, Linux Secret Service via `secret-tool`); the secrets themselves are AES-256-GCM sealed in
// ~/.config/diorama/credentials.bin (0600). Environment variables always win over stored keys.
import { execFile, spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The keys diorama knows how to keep, with the other names each one is accepted under. */
export const SECRETS = {
  META_API_KEY: { label: 'Meta Model API key', aliases: ['META_MUSE_API_KEY', 'META_MODEL_API_KEY'], required: true },
  ELEVENLABS_API_KEY: { label: 'ElevenLabs key', aliases: ['ELEVEN_API_KEY'], required: false },
  HF_TOKEN: { label: 'Hugging Face token', aliases: ['HUGGING_FACE_API_KEY'], required: false },
} as const;
export type SecretName = keyof typeof SECRETS;
export const SECRET_NAMES = Object.keys(SECRETS) as SecretName[];

/** Holds the master key. */
export interface Vault {
  readonly name: string;
  get(): Promise<Buffer | null>;
  set(key: Buffer): Promise<void>;
}

const SERVICE = 'diorama';
const ACCOUNT = 'credentials-key';

function run(cmd: string, args: string[], input?: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', () => resolve({ code: -1, out: '' }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
    child.stdin.end(input ?? '');
  });
}

function onPath(cmd: string): Promise<boolean> {
  return new Promise((resolve) => execFile('/bin/sh', ['-c', `command -v ${cmd}`], (error) => resolve(!error)));
}

/** macOS Keychain. The key goes in through `security -i` on stdin, so it never shows up in a process list. */
const keychain: Vault = {
  name: 'macOS Keychain',
  async get() {
    const { code, out } = await run('security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    return code === 0 && out.trim() ? Buffer.from(out.trim(), 'hex') : null;
  },
  async set(key) {
    const { code } = await run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -l "diorama credentials" -w ${key.toString('hex')}\n`);
    if (code !== 0) throw new Error('could not write the diorama key to the macOS Keychain');
  },
};

/** Linux Secret Service (GNOME Keyring, KWallet); `secret-tool store` reads the value from stdin. */
const secretService: Vault = {
  name: 'Secret Service',
  async get() {
    const { code, out } = await run('secret-tool', ['lookup', 'service', SERVICE, 'account', ACCOUNT]);
    return code === 0 && out.trim() ? Buffer.from(out.trim(), 'hex') : null;
  },
  async set(key) {
    const { code } = await run('secret-tool', ['store', '--label=diorama credentials', 'service', SERVICE, 'account', ACCOUNT], key.toString('hex'));
    if (code !== 0) throw new Error('could not write the diorama key to the Secret Service (is a keyring unlocked?)');
  },
};

/** Opt-in only: the master key in a 0600 file next to the secrets. Anyone who can read your home can read both. */
export function fileVault(dir: string): Vault {
  const file = path.join(dir, 'credentials.key');
  return {
    name: 'key file (DIORAMA_ALLOW_FILE_KEYCHAIN)',
    async get() {
      return fs.existsSync(file) ? Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex') : null;
    },
    async set(key) {
      writeAtomic(file, key.toString('hex'));
    },
  };
}

export function configDir(): string {
  if (process.env.DIORAMA_CONFIG_DIR) return path.resolve(process.env.DIORAMA_CONFIG_DIR);
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'diorama');
}

/** The vault this machine offers, or null when there is none and the file fallback was not asked for. */
export async function findVault(dir = configDir()): Promise<Vault | null> {
  if (process.platform === 'darwin' && (await onPath('security'))) return keychain;
  if (process.platform === 'linux' && (await onPath('secret-tool'))) return secretService;
  if (process.env.DIORAMA_ALLOW_FILE_KEYCHAIN === 'true') return fileVault(dir);
  return null;
}

export const NO_VAULT = 'No system keychain found (macOS Keychain, or secret-tool on Linux). Set the key as an environment variable instead, '
  + 'or run with DIORAMA_ALLOW_FILE_KEYCHAIN=true to keep it in a key file under ~/.config/diorama (weaker: anyone who can read your home can read it).';

function writeAtomic(file: string, data: string | Buffer) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const MAGIC = Buffer.from('DIO1');

export function seal(key: Buffer, plain: Record<string, string>): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(MAGIC);
  const body = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Buffer): Record<string, string> {
  if (!sealed.subarray(0, 4).equals(MAGIC)) throw new Error('credentials.bin is not a diorama credentials file');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(4, 16));
  decipher.setAAD(MAGIC);
  decipher.setAuthTag(sealed.subarray(16, 32));
  return JSON.parse(Buffer.concat([decipher.update(sealed.subarray(32)), decipher.final()]).toString('utf8'));
}

/** The encrypted secrets file. Writes take a lock file, so two `diorama setup` runs cannot lose a key. */
export class SecretStore {
  readonly file: string;

  constructor(readonly vault: Vault, readonly dir = configDir()) {
    this.file = path.join(dir, 'credentials.bin');
  }

  async read(): Promise<Record<string, string>> {
    if (!fs.existsSync(this.file)) return {};
    const key = await this.vault.get();
    if (!key) throw new Error(`credentials.bin exists but its key is missing from the ${this.vault.name}; run diorama setup to store your keys again`);
    return open(key, fs.readFileSync(this.file));
  }

  async set(name: SecretName, value: string | null) {
    await this.locked(async () => {
      let key = await this.vault.get();
      if (!key || key.length !== 32) {
        key = randomBytes(32);
        await this.vault.set(key);
      }
      const all = fs.existsSync(this.file) ? open(key, fs.readFileSync(this.file)) : {};
      if (value === null) delete all[name];
      else all[name] = value;
      writeAtomic(this.file, seal(key, all));
    });
  }

  private async locked(work: () => Promise<void>) {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const lock = path.join(this.dir, 'credentials.lock');
    for (let tries = 0; ; tries++) {
      try {
        fs.closeSync(fs.openSync(lock, 'wx', 0o600));
        break;
      } catch (error) {
        const stale = fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 30_000;
        if (stale) fs.rmSync(lock, { force: true });
        else if (tries > 50) throw new Error(`credentials are locked by another diorama process (${lock})`);
        else await new Promise((r) => setTimeout(r, 100));
      }
    }
    try {
      await work();
    } finally {
      fs.rmSync(lock, { force: true });
    }
  }
}

/** Where a key comes from right now: the environment (under any of its names), the store, or nowhere. */
export function envValue(name: SecretName): string | undefined {
  return [name, ...SECRETS[name].aliases].map((n) => process.env[n]).find(Boolean);
}

/** At startup: stored keys fill in whatever the environment does not set. Quiet when nothing is stored. */
export async function loadSecrets(dir = configDir()): Promise<Partial<Record<SecretName, 'env' | 'store'>>> {
  const sources: Partial<Record<SecretName, 'env' | 'store'>> = {};
  for (const name of SECRET_NAMES) if (envValue(name)) sources[name] = 'env';
  if (fs.existsSync(path.join(dir, 'credentials.bin')) && SECRET_NAMES.some((n) => !sources[n])) {
    const vault = await findVault(dir);
    if (vault) {
      const stored = await new SecretStore(vault, dir).read();
      for (const name of SECRET_NAMES) {
        if (sources[name] || !stored[name]) continue;
        process.env[name] = stored[name];
        sources[name] = 'store';
      }
    }
  }
  return sources;
}

/** Every known key value in this process, long enough to be worth hiding. */
function knownValues(): string[] {
  return SECRET_NAMES.flatMap((n) => [n, ...SECRETS[n].aliases]).map((n) => process.env[n]).filter((v): v is string => !!v && v.length >= 8);
}

/** Replaces any key value in text, for logs, recordings and anything sent to a browser or agent. */
export function redact(text: string): string {
  for (const value of knownValues()) text = text.split(value).join('[redacted]');
  return text.replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/g, '$1[redacted]');
}

/** The environment without any provider key, for a process that must not hold them (the agent). */
export function withoutSecrets(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const drop = new Set<string>(SECRET_NAMES.flatMap((n) => [n, ...SECRETS[n].aliases]));
  return Object.fromEntries(Object.entries(env).filter(([k]) => !drop.has(k)));
}
