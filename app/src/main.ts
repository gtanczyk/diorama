import './commands/index.ts';
import { registry } from './registry.ts';
import { loadSecrets, redact } from './secrets.ts';
import { cli, cliText } from './cli.ts';

function help() {
  console.log(`diorama: a story prompt becomes painted scenes you can walk in\n\nusage: ${cli('<command> [args]')}\n`);
  for (const cmd of registry.values()) console.log(`  ${cmd.usage}`);
  console.log(`\nfirst time: ${cli('setup')} (keys, what is missing), then ${cli('studio')}. Worlds are written to ./worlds here.`);
}

const [name, ...args] = process.argv.slice(2);
const cmd = name ? registry.get(name) : undefined;
if (!cmd) {
  help();
  process.exit(!name || name === 'help' ? 0 : 2);
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`usage: ${cli(cmd.usage)}`);
  process.exit(0);
}
try {
  // Keys kept by `diorama setup` fill in what the environment leaves unset.
  if (name !== 'setup') await loadSecrets();
  await cmd.run(args);
} catch (error) {
  console.error(redact(`diorama ${name}: ${cliText(error instanceof Error ? error.message : String(error))}`));
  process.exit(1);
}
