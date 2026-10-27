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

/** POSTs JSON. Rate limits, server errors, network drops and stalls are retried with backoff (2, 4, 8 s). */
export async function metaPost(route: string, body: unknown, accept?: string): Promise<Response> {
  const tries = 4;
  const limit = patience(route, body);
  for (let n = 1; ; n++) {
    let failure: unknown;
    try {
      const res = await fetch(META_API + route, {
        signal: AbortSignal.timeout(limit),
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json', ...(accept && { Accept: accept }) },
        body: JSON.stringify(body),
      });
      if (res.ok) return res;
      failure = new MetaHttpError(res.status, `POST ${route}: ${res.status} ${(await res.text()).slice(0, 300)}`);
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
