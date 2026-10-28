// The Meta Model API: one key, a POST that retries what is worth retrying.
export const META_API = 'https://api.meta.ai/v1';

/** The first of these that is set holds the Meta Model API key. */
export const KEY_VARS = ['META_API_KEY', 'META_MUSE_API_KEY', 'META_MODEL_API_KEY'] as const;

export function apiKey(): string {
  const key = KEY_VARS.map((name) => process.env[name]).find(Boolean);
  if (!key) throw new Error(`no Meta Model API key: set one of ${KEY_VARS.join(', ')}`);
  return key;
}

export class MetaHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const TRANSIENT = new Set([408, 409, 429, 500, 502, 503, 504]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * How long one try may take before it is given up and tried again. Without a limit a stalled request waits for the
 * HTTP client's own 300 s: on the Mac one backdrop edit took 343 s where it takes 10 to 20. Muse paints in 10-25 s,
 * SAM answers in 1-6 s, Spark thinks for up to ~100 s.
 */
function patience(route: string, body: unknown): number {
  if (route.startsWith('/images/')) return 90_000;
  const model = (body as { model?: string } | null)?.model ?? '';
  return model.startsWith('sam') ? 60_000 : 240_000;
}

/**
 * How many requests each model may have open at once. The build runs places, cast and sound side by side
 * (src/world/schedule.ts), so without a cap a four-place world can ask SAM for dozens of cut-outs at the same
 * moment. A request over the cap waits its turn; DIORAMA_LANES="muse=8,spark=12,sam=16" sets them.
 */
const LANES: Record<string, number> = { muse: 8, spark: 12, sam: 16 };
for (const pair of (process.env.DIORAMA_LANES ?? '').split(',')) {
  const [lane, n] = pair.split('=');
  if (lane in LANES && Number(n) >= 1) LANES[lane] = Math.floor(Number(n));
}
const open: Record<string, number> = {};
const waiting: Record<string, Array<() => void>> = {};
const laneOf = (route: string, body: unknown) => (route.startsWith('/images/') ? 'muse' : ((body as { model?: string } | null)?.model ?? '').startsWith('sam') ? 'sam' : 'spark');

async function inLane<T>(lane: string, work: () => Promise<T>): Promise<T> {
  if ((open[lane] ?? 0) >= LANES[lane]) await new Promise<void>((go) => (waiting[lane] ??= []).push(go));
  else open[lane] = (open[lane] ?? 0) + 1;
  try {
    return await work();
  } finally {
    // The slot passes straight to the next in line, or is given back.
    const next = waiting[lane]?.shift();
    if (next) next();
    else open[lane]--;
  }
}

/** POSTs JSON. Rate limits, server errors, network drops and stalls are retried with backoff (2, 4, 8 s). */
export async function metaPost(route: string, body: unknown, accept?: string): Promise<Response> {
  const tries = 4;
  const limit = patience(route, body);
  for (let n = 1; ; n++) {
    let failure: unknown;
    try {
      // The slot is held until the answer is read or turned down, not through the wait before a retry.
      const res = await inLane(laneOf(route, body), async () => {
        const res = await fetch(META_API + route, {
          signal: AbortSignal.timeout(limit),
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', ...(accept && { Accept: accept }) },
          body: JSON.stringify(body),
        });
        return res.ok ? res : new MetaHttpError(res.status, `POST ${route}: ${res.status} ${(await res.text()).slice(0, 300)}`);
      });
      if (!(res instanceof MetaHttpError)) return res;
      failure = res;
      if (!TRANSIENT.has(res.status)) throw failure;
    } catch (error) {
      if (error instanceof MetaHttpError && !TRANSIENT.has(error.status)) throw error;
      failure = error;
    }
    if (n === tries) throw failure;
    // Said in the job log, so a slow step shows why.
    const why = failure instanceof Error && failure.name === 'TimeoutError' ? `no answer in ${limit / 1000} s` : failure instanceof Error ? failure.message.slice(0, 120) : String(failure);
    console.log(`  POST ${route}: ${why}; trying again (${n + 1}/${tries})`);
    await sleep(1000 * 2 ** n);
  }
}
