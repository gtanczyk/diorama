// Which build step a model call belongs to. The build runs steps side by side, so "calls since the step began"
// counts other steps' calls too; each call is tagged with the step that asked it instead (memo/calls.jsonl `step`).
import { AsyncLocalStorage } from 'node:async_hooks';

const current = new AsyncLocalStorage<string>();

/** Runs `work` with every model call inside it counted to `step`. */
export function inStep<T>(step: string, work: () => Promise<T>): Promise<T> {
  return current.run(step, work);
}

export function currentStep(): string | undefined {
  return current.getStore();
}
