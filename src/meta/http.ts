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

/** POSTs JSON. Rate limits, server errors and network drops are retried with backoff (2, 4, 8 s). */
export async function metaPost(route: string, body: unknown, accept?: string): Promise<Response> {
  const tries = 4;
  for (let n = 1; ; n++) {
    let failure: unknown;
    try {
      const res = await fetch(META_API + route, {
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
    await sleep(1000 * 2 ** n);
  }
}
