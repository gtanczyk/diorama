import './commands/index.ts';
import { registry } from './registry.ts';

function help() {
  console.log('diorama: a story prompt becomes painted scenes you can walk in\n\nusage: diorama <command> [args]\n');
  for (const cmd of registry.values()) console.log(`  ${cmd.usage}`);
}

const [name, ...args] = process.argv.slice(2);
const cmd = name ? registry.get(name) : undefined;
if (!cmd) {
  help();
  process.exit(!name || name === 'help' ? 0 : 2);
}
try {
  await cmd.run(args);
} catch (error) {
  console.error(`diorama ${name}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}
