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

/** With DIORAMA_EVENTS=1 (a job run by diorama studio), a line the studio reads as a live event; otherwise nothing. */
export function emit(type: string, data: Record<string, unknown> = {}) {
  // A staged extension is not the live world: do not report its provisional verdict as a live place or trigger auto-repair.
  if (process.env.DIORAMA_STAGED_BUILD === '1' && type === 'place.verdict') return;
  if (process.env.DIORAMA_EVENTS === '1') process.stdout.write(`@@diorama ${JSON.stringify({ type, ...data })}\n`);
}
