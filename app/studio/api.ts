// The page's only way to the server: actions, and the live feed. The token arrives once in the URL fragment,
// moves to sessionStorage and leaves the address bar.

export type StudioEvent = { seq: number; at: string; type: string; world?: string; [k: string]: unknown };
export type ActionInfo = { name: string; description: string; job: boolean; reads: boolean; input: { properties?: Record<string, { enum?: string[] }> } };

const KEY = 'diorama-studio-token';

function takeToken(): string | null {
  const fromHash = location.hash.slice(1);
  if (fromHash) {
    try {
      sessionStorage.setItem(KEY, fromHash);
    } catch {}
    history.replaceState(null, '', location.pathname + location.search);
    return fromHash;
  }
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export const token = takeToken();

const headers = (): Record<string, string> => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });

export class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Swaps the token for the cookie that lets <img> load world files. */
export async function openSession(): Promise<void> {
  const res = await fetch('/api/session', { method: 'POST', headers: headers(), body: '{}' });
  if (!res.ok) throw new ApiError(res.status, res.status === 401 ? 'This link has expired: open the one diorama studio printed in your terminal.' : `session: ${res.status}`);
}

export async function listActions(): Promise<ActionInfo[]> {
  const res = await fetch('/api/actions', { headers: headers() });
  if (!res.ok) throw new ApiError(res.status, `actions: ${res.status}`);
  return res.json();
}

export async function call<T = unknown>(name: string, input: object = {}): Promise<T> {
  const res = await fetch(`/api/actions/${name}`, { method: 'POST', headers: headers(), body: JSON.stringify(input) });
  const body = (await res.json().catch(() => ({}))) as { result?: T; error?: string };
  if (!res.ok) throw new ApiError(res.status, body.error ?? `${name}: ${res.status}`);
  return body.result as T;
}

/** Follows the live feed (one world, or studio-wide), reconnecting where it left off. Returns a stop function. */
export function follow(world: string | null, onEvent: (e: StudioEvent) => void, onState?: (live: boolean) => void): () => void {
  let stopped = false;
  let since = 0;
  let ctrl: AbortController | null = null;
  (async () => {
    while (!stopped) {
      ctrl = new AbortController();
      try {
        const q = new URLSearchParams({ since: String(since), ...(world && { world }) });
        const res = await fetch(`/api/events?${q}`, { headers: { authorization: `Bearer ${token}` }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(String(res.status));
        onState?.(true);
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += value;
          let cut;
          while ((cut = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, cut);
            buf = buf.slice(cut + 2);
            const data = block.split('\n').find((l) => l.startsWith('data: '));
            if (!data) continue;
            const event = JSON.parse(data.slice(6)) as StudioEvent;
            since = Math.max(since, event.seq);
            onEvent(event);
          }
        }
      } catch {}
      onState?.(false);
      if (!stopped) await new Promise((r) => setTimeout(r, 1500));
    }
  })();
  return () => {
    stopped = true;
    ctrl?.abort();
  };
}

export const fileUrl = (world: string, file: string, v?: number | null) => `/files/${world}/${file}${v ? `?v=${v}` : ''}`;

/** Says something to the world's Muse Code agent, as if typed in its panel. */
/** A Studio button's ask: `gist` is what the chat shows (the whole ask folds under it); the agent reads both. */
export async function askAgent(slug: string, text: string, gist?: string): Promise<void> {
  if (gist) text = `[Ask: ${gist.replace(/[\]\n]/g, ' ')}]\n${text}`;
  const res = await fetch(`/api/agent/${slug}/say`, { method: 'POST', headers: headers(), body: JSON.stringify({ text }) });
  if (!res.ok) throw new ApiError(res.status, ((await res.json().catch(() => ({}))) as { error?: string }).error ?? `could not send (${res.status})`);
}
