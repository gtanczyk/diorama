// The second tier of repair: when a build fails, the Studio hands it to the agent at once, without anyone
// asking. Places that are not playable (and that the build could not fix for free) get the playbook; any other
// failure (a step that broke, a service that did not answer) gets the error and the job's last lines. The agent's
// brief says how; what it cannot fix it tells the person, which is the third tier.
import type { Job } from './jobs.ts';

/** Whether a job that just ended should wake the agent. */
export function wantsRepair(job: Job, opts: { enabled: boolean }): boolean {
  if (!opts.enabled) return false;
  // The agent's own fix jobs come back to it through job_wait; only builds someone else started wake it.
  if (job.by === 'agent' || job.args[0] !== 'build') return false;
  return job.state === 'failed';
}

/** What the agent is told: which places or which step, why, and what is expected back. */
export function repairPrompt(job: Job): string {
  if (job.unplayable?.length) {
    const places = job.unplayable.map((u) => `- ${u.place}: ${u.errors.join('; ') || 'see place_status'}`).join('\n');
    return `[Studio] The build "${job.label}" ended with places that are not playable, and its free fixes did not help:\n${places}\n`
      + 'Repair them as your brief says: place_status and place_view first, then the playbook\'s fix tools in order, at most three fixes a place, '
      + 'and ask me before the last resort. Then tell me in two sentences what you fixed and what is left for me.';
  }
  const tail = job.tail.slice(-15).map((l) => `  ${l}`).join('\n');
  return `[Studio] The build "${job.label}" (job ${job.id}) failed${job.step ? ` at ${job.step}` : ''}: ${job.error ?? 'no error said'}\n`
    + (tail ? `Its last lines:\n${tail}\n` : '')
    + 'Find the cause and fix it as your brief says for a failed build: job_inspect first; a service that did not answer (HTTP 5xx, a timeout) gets one job_retry; '
    + 'a step that broke on the world gets that step\'s own tool (cast_status, place_status, …). Do not retry the same error twice. '
    + 'Then tell me in two sentences what you fixed and what is left for me.';
}
