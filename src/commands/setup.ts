// diorama setup: what this machine still needs, and the one place a key is typed in (hidden, in the terminal).
import { defineCommand, takeOption } from '../registry.ts';
import { findVault, NO_VAULT, SECRET_NAMES, SECRETS, SecretStore, type SecretName } from '../secrets.ts';
import { runChecks, type Check } from '../setup/checks.ts';

const MARK: Record<Check['state'], string> = { ok: '  ok      ', missing: '  MISSING ', optional: '  -       ', fail: '  FAIL    ' };

export function printChecks(checks: Check[]) {
  for (const c of checks) {
    console.log(`${MARK[c.state]}${c.label}: ${c.detail}`);
    for (const line of c.fix ?? []) console.log(`            $ ${line}`);
  }
}

/** Reads a line without echoing it. Only from a terminal: a pasted key never lands in shell history or argv. */
function askHidden(question: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('diorama setup reads keys from a terminal only; or set them as environment variables');
  process.stdout.write(question);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (error?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(value.trim());
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

async function storeKey(name: SecretName, remove: boolean) {
  const vault = await findVault();
  if (!vault) throw new Error(NO_VAULT);
  const store = new SecretStore(vault);
  if (remove) {
    await store.set(name, null);
    return console.log(`removed ${name} from ${store.file}`);
  }
  const value = await askHidden(`${SECRETS[name].label} (${name}), hidden, Enter to skip: `);
  if (!value) return console.log('skipped');
  await store.set(name, value);
  console.log(`stored ${name}: sealed in ${store.file}, its key in the ${vault.name}`);
}

defineCommand({
  name: 'setup',
  usage: 'setup                   check this machine and store keys, typed hidden [--key NAME] [--remove NAME] [--live]',
  async run(args) {
    const live = args.includes('--live');
    const key = takeOption(args, 'key', '');
    const remove = takeOption(args, 'remove', '');
    for (const name of [key, remove].filter(Boolean)) {
      if (!SECRET_NAMES.includes(name as SecretName)) throw new Error(`unknown key ${name}; diorama keeps ${SECRET_NAMES.join(', ')}`);
    }
    if (key || remove) return storeKey((key || remove) as SecretName, !!remove);

    let checks = await runChecks({ live });
    printChecks(checks);
    // In a terminal, offer to store each missing key right away.
    const missing = checks.filter((c) => SECRET_NAMES.includes(c.id as SecretName) && c.state !== 'ok');
    if (process.stdin.isTTY && missing.length && (await findVault())) {
      console.log('');
      for (const c of missing) await storeKey(c.id as SecretName, false);
      checks = await runChecks({ live });
      console.log('');
      printChecks(checks);
    }
    const blocking = checks.filter((c) => c.state === 'missing' || c.state === 'fail');
    console.log(blocking.length ? `\n${blocking.length} to fix before a full build: ${blocking.map((c) => c.label).join(', ')}` : '\nready to build');
  },
});
