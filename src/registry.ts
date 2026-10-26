// Every command module registers itself here on import.
export type Command = { name: string; usage: string; run: (args: string[]) => Promise<void> };

export const registry = new Map<string, Command>();

export function defineCommand(cmd: Command) {
  registry.set(cmd.name, cmd);
}

/** Removes `--name value` from args and returns the value, or `fallback`. */
export function takeOption(args: string[], name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const [, value] = args.splice(at, 2);
  return value ?? fallback;
}
