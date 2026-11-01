// A Gradio app on a Hugging Face Space, called over its HTTP API: upload files, call an endpoint, read
// its event stream, download the files it answers with. ZeroGPU Spaces count GPU time against the
// caller's Hugging Face account, so the HF token goes along (only to *.hf.space, Hugging Face's own host).

export const HF_TOKEN_VARS = ['HUGGING_FACE_API_KEY', 'HF_TOKEN'] as const;

/** HTTP answers of a busy or restarting Space: asking again later can work. */
export const TRANSIENT = [408, 429, 500, 502, 503, 504];

/** How long a call waits: a Space that sends nothing (not even Gradio's heartbeat, every 15 s) for `idleMs`, or
 * has not answered after `totalMs` (a ZeroGPU queue that never moves), is given up on, so the caller can ask
 * again or go on without it instead of a build hanging on one character. Tests shorten them. */
export const SPACE_WAIT = { idleMs: 180_000, totalMs: 900_000 };

/** A file argument, as Gradio expects it after an upload. */
export type SpaceFile = { path: string; meta: { _type: 'gradio.FileData' }; orig_name?: string };

export class Space {
  readonly base: string;
  private readonly headers: Record<string, string>;

  constructor(readonly id: string) {
    this.base = `https://${id.toLowerCase().replace(/[/_.]/g, '-')}.hf.space/gradio_api`;
    const token = HF_TOKEN_VARS.map((name) => process.env[name]).find(Boolean);
    this.headers = token ? { Authorization: `Bearer ${token}` } : {};
  }

  async upload(name: string, data: Buffer): Promise<SpaceFile> {
    // Uploading the same bytes again is safe; queue/join can start GPU work and must not be retried blindly.
    for (let attempt = 0; ; attempt++) {
      const form = new FormData();
      form.append('files', new Blob([new Uint8Array(data)]), name);
      const res = await fetch(`${this.base}/upload`, { method: 'POST', headers: this.headers, body: form, signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        const [where] = (await res.json()) as string[];
        if (typeof where !== 'string' || !where) throw new Error(`${this.id} upload: missing file path`);
        return { path: where, meta: { _type: 'gradio.FileData' }, orig_name: name };
      }
      // Do not put proxy HTML in the build feed. The operation and status are enough to diagnose it.
      await res.body?.cancel();
      if (!TRANSIENT.includes(res.status) || attempt === 2) {
        throw new Error(`${this.id} upload: HTTP ${res.status} (${attempt + 1} attempt(s))`);
      }
      const retryAfter = res.headers.get('retry-after');
      const seconds = retryAfter === null ? NaN : Number(retryAfter);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, Math.max(1000 * 2 ** attempt, Number.isFinite(delay) ? delay : 0))));
    }
  }

  /** One session for every call, so endpoints that keep files per session (TRELLIS) find them. */
  private readonly session = Math.random().toString(36).slice(2, 13);
  private endpoints?: Map<string, { fn: number; states: number[] }>;

  /** Calls an endpoint; returns the data of every event it sent (a generator sends several), in order. */
  async call(api: string, data: unknown[]): Promise<unknown[][]> {
    const { fn, states } = await this.endpoint(api);
    // The API leaves out the app's hidden state inputs; the queue wants them in place, as null.
    data = [...data];
    for (const at of states) data.splice(at, 0, null);
    const join = await fetch(`${this.base}/queue/join`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data, fn_index: fn, session_hash: this.session, event_data: null, trigger_id: null }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!join.ok) throw new Error(`${this.id} /${api}: ${join.status} ${(await join.text()).slice(0, 200)}`);
    const { event_id } = (await join.json()) as { event_id: string };
    const started = Date.now();
    const stop = new AbortController();
    let quiet: ReturnType<typeof setTimeout> | undefined;
    let why = '';
    const wait = () => {
      clearTimeout(quiet);
      const ms = Math.min(SPACE_WAIT.idleMs, SPACE_WAIT.totalMs - (Date.now() - started));
      quiet = setTimeout(() => {
        why = Date.now() - started >= SPACE_WAIT.totalMs ? `no answer after ${Math.round(SPACE_WAIT.totalMs / 1000)} s` : `silent for ${Math.round(SPACE_WAIT.idleMs / 1000)} s`;
        stop.abort();
      }, Math.max(0, ms));
    };
    wait();
    try {
      return await this.listen(api, event_id, stop.signal, wait);
    } catch (error) {
      if (why) throw new Error(`${this.id} /${api}: ${why}`);
      throw error;
    } finally {
      clearTimeout(quiet);
      stop.abort();
    }
  }

  /** Reads the queue's event stream until the call's own answer; `heard` is called on every chunk. */
  private async listen(api: string, event_id: string, signal: AbortSignal, heard: () => void): Promise<unknown[][]> {
    const stream = await fetch(`${this.base}/queue/data?session_hash=${this.session}`, { headers: this.headers, signal });
    if (!stream.ok || !stream.body) throw new Error(`${this.id} /${api}: queue ${stream.status}`);
    const events: unknown[][] = [];
    const decoder = new TextDecoder();
    let buffered = '';
    for await (const chunk of stream.body as unknown as AsyncIterable<Uint8Array>) {
      heard();
      buffered += decoder.decode(chunk, { stream: true });
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        if (process.env.DIORAMA_SPACE_DEBUG) console.error(line.slice(0, 400));
        const msg = JSON.parse(line.slice(5)) as { msg: string; event_id?: string; success?: boolean; output?: { data?: unknown[]; error?: unknown; title?: string } };
        if (msg.event_id && msg.event_id !== event_id) continue;
        if (msg.msg === 'process_generating' && msg.output?.data) events.push(msg.output.data);
        if (msg.msg === 'process_completed') {
          if (!msg.success || msg.output?.error !== undefined && msg.output.error !== null) {
            throw new Error(`${this.id} /${api}: ${JSON.stringify(msg.output?.error ?? msg.output).slice(0, 300)}`);
          }
          if (msg.output?.data) events.push(msg.output.data);
          stream.body.cancel().catch(() => {});
          return events;
        }
      }
    }
    throw new Error(`${this.id} /${api}: the stream closed before an answer`);
  }

  /** The fn_index of a named endpoint and where its hidden state inputs go, from the app's config. */
  private async endpoint(api: string): Promise<{ fn: number; states: number[] }> {
    if (!this.endpoints) {
      const res = await fetch(`${this.base.replace(/\/gradio_api$/, '')}/config`, { headers: this.headers, signal: AbortSignal.timeout(60_000) });
      if (!res.ok) throw new Error(`${this.id} config: ${res.status}`);
      type Config = { components: { id: number; type: string }[]; dependencies: { id?: number; api_name?: string | false; inputs: number[] }[] };
      const config = (await res.json()) as Config;
      const state = new Set(config.components.filter((c) => c.type === 'state').map((c) => c.id));
      this.endpoints = new Map(config.dependencies.flatMap((d, i) => d.api_name
        ? [[d.api_name, { fn: d.id ?? i, states: d.inputs.flatMap((c, at) => (state.has(c) ? [at] : [])) }] as const]
        : []));
    }
    const found = this.endpoints.get(api);
    if (!found) throw new Error(`${this.id} has no endpoint /${api}`);
    return found;
  }

  async download(file: { path: string; url?: string }): Promise<Buffer> {
    // A download only reads a file the Space already made, so a busy or restarting Space is asked again.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(file.url ?? `${this.base}/file=${file.path}`, { headers: this.headers, signal: AbortSignal.timeout(120_000) }).catch((error: Error) => error);
      if (!(res instanceof Error) && res.ok) return Buffer.from(await res.arrayBuffer());
      if (!(res instanceof Error)) await res.body?.cancel();
      const status = res instanceof Error ? res.message : res.status;
      if ((!(res instanceof Error) && !TRANSIENT.includes(res.status)) || attempt === 3) {
        throw new Error(`${this.id} download ${file.path}: ${status}${attempt ? ` (${attempt + 1} attempts)` : ''}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt));
    }
  }
}

/** Every file in an endpoint's events whose path ends with `suffix`, the last one sent first. */
export function filesNamed(events: unknown[][], suffix: string): { path: string; url?: string }[] {
  const found: { path: string; url?: string }[] = [];
  const visit = (v: unknown): void => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(visit);
    const o = v as Record<string, unknown>;
    if (typeof o.path === 'string' && o.path.endsWith(suffix)) found.push({ path: o.path, url: typeof o.url === 'string' ? o.url : undefined });
    Object.values(o).forEach(visit);
  };
  events.forEach(visit);
  return found.reverse();
}
