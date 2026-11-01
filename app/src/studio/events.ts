// The live feed: everything the studio, its jobs and the agent do becomes an event with a sequence number.
// The browser and `diorama mcp` read the same feed, so a change made by either shows up in the other at once.

export type StudioEvent = { seq: number; at: string; type: string; world?: string; [k: string]: unknown };
type Listener = (e: StudioEvent) => void;

/** Events a page opened mid-build needs to draw the build's progress: a long build's logs, files and calls push
 * them out of the recent window long before it ends, so they are kept apart (and Studio showed done steps as empty). */
const LASTING = new Set(['job.queued', 'job.start', 'job.end', 'build.start', 'step.start', 'step.end', 'step.fail']);

export class Events {
  private seq = 0;
  private readonly recent: StudioEvent[] = [];
  private readonly lasting: StudioEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly keep = 2000) {}

  publish(type: string, data: Record<string, unknown> = {}): StudioEvent {
    const event: StudioEvent = { ...data, seq: ++this.seq, at: new Date().toISOString(), type };
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    if (LASTING.has(type)) {
      this.lasting.push(event);
      if (this.lasting.length > this.keep) this.lasting.splice(0, this.lasting.length - this.keep);
    }
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Events after `seq` (for a reconnecting client), optionally for one world plus the studio-wide ones. */
  since(seq: number, world?: string): StudioEvent[] {
    const oldest = this.recent[0]?.seq ?? Infinity;
    const kept = this.lasting.filter((e) => e.seq < oldest);
    return [...kept, ...this.recent].filter((e) => e.seq > seq && (!world || !e.world || e.world === world));
  }

  /** The sequence number of the latest event. */
  get last(): number {
    return this.seq;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
