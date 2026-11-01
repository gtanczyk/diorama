// Work that may run side by side, a few at a time: the cast's 3D bodies and faces, each character on its own.

/** Runs `work` on every item, at most `limit` at once; results keep the items' order. Errors are kept per item. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const runner = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await work(items[i], i) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, runner));
  return results;
}

const open = new Map<string, number>();
const waiting = new Map<string, Array<() => void>>();

/** At most `limit` of `lane`'s work at once in this process (a Hugging Face Space queue, a local GPU). */
export async function inLane<T>(lane: string, limit: number, work: () => Promise<T>): Promise<T> {
  if ((open.get(lane) ?? 0) >= limit) await new Promise<void>((go) => (waiting.get(lane) ?? waiting.set(lane, []).get(lane)!).push(go));
  else open.set(lane, (open.get(lane) ?? 0) + 1);
  try {
    return await work();
  } finally {
    const go = waiting.get(lane)?.shift();
    if (go) go();
    else open.set(lane, (open.get(lane) ?? 1) - 1);
  }
}

/** How many characters are worked on at once: DIORAMA_CAST_LANES, default 3. */
export function castLanes(): number {
  const n = Number(process.env.DIORAMA_CAST_LANES);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 3;
}
