// The second tier of repair: when a build ends with places that are not playable and the build itself
// could not fix them for free, the Studio hands them to the agent at once, without anyone asking. The
// agent's brief says how (place_status, place_view, the playbook's fix tools in order, three tries a
// place); what it cannot fix it tells the person, which is the third tier.
import type { Job } from './jobs.ts';

/** Whether a job that just ended should wake the agent. */
export function wantsRepair(job: Job, opts: { enabled: boolean }): boolean {
  if (!opts.enabled) return false;
  // The agent's own fix jobs come back to it through job_wait; only builds someone else started wake it.
  if (job.by === 'agent' || job.args[0] !== 'build') return false;
  return job.state === 'failed' && (job.unplayable?.length ?? 0) > 0;
}

/** What the agent is told: which places, why, and what is expected back. */
export function repairPrompt(job: Job): string {
  const places = (job.unplayable ?? []).map((u) => `- ${u.place}: ${u.errors.join('; ') || 'see place_status'}`).join('\n');
  return `[Studio] The build "${job.label}" ended with places that are not playable, and its free fixes did not help:\n${places}\n`
    + 'Repair them as your brief says: place_status and place_view first, then the playbook\'s fix tools in order, at most three fixes a place, '
    + 'and ask me before the last resort. Then tell me in two sentences what you fixed and what is left for me.';
}
