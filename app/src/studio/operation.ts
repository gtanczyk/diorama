// A local operation's lifetime, not a claim about what a remote service is doing.
import { randomUUID } from 'node:crypto';
import { emit } from '../registry.ts';

export async function trackOperation<T>(kind: string, label: string, run: () => Promise<T>): Promise<T> {
  if (process.env.DIORAMA_EVENTS !== '1') return run();
  const id = randomUUID();
  const started = Date.now();
  emit('operation.start', { id, kind, label });
  try {
    const result = await run();
    emit('operation.end', { id, kind, label, outcome: 'ok', ms: Date.now() - started });
    return result;
  } catch (error) {
    emit('operation.end', { id, kind, label, outcome: 'failed', ms: Date.now() - started, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) });
    throw error;
  }
}
