// The live feed: everything the studio, its jobs and the agent do becomes an event with a sequence number.
// The browser and `diorama mcp` read the same feed, so a change made by either shows up in the other at once.

export type StudioEvent = { seq: number; at: string; type: string; world?: string; [k: string]: unknown };
type Listener = (e: StudioEvent) => void;

export class Events {
  private seq = 0;
  private readonly recent: StudioEvent[] = [];
  private readonly listeners = new Set<Listener>();

  constructor(private readonly keep = 2000) {}

  publish(type: string, data: Record<string, unknown> = {}): StudioEvent {
    const event: StudioEvent = { ...data, seq: ++this.seq, at: new Date().toISOString(), type };
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    for (const listener of this.listeners) listener(event);
    return event;
  }

  /** Events after `seq` (for a reconnecting client), optionally for one world plus the studio-wide ones. */
  since(seq: number, world?: string): StudioEvent[] {
    return this.recent.filter((e) => e.seq > seq && (!world || !e.world || e.world === world));
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
