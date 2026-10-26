// A Gradio app on a Hugging Face Space, called over its HTTP API: upload files, call an endpoint, read
// its event stream, download the files it answers with. ZeroGPU Spaces count GPU time against the
// caller's Hugging Face account, so the HF token goes along (only to *.hf.space, Hugging Face's own host).

export const HF_TOKEN_VARS = ['HUGGING_FACE_API_KEY', 'HF_TOKEN'] as const;

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
    const form = new FormData();
    form.append('files', new Blob([new Uint8Array(data)]), name);
    const res = await fetch(`${this.base}/upload`, { method: 'POST', headers: this.headers, body: form });
    if (!res.ok) throw new Error(`${this.id} upload: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const [where] = (await res.json()) as string[];
    return { path: where, meta: { _type: 'gradio.FileData' }, orig_name: name };
  }

  /** Calls an endpoint; returns the data of every event it sent (a generator sends several), in order. */
  async call(api: string, data: unknown[]): Promise<unknown[][]> {
    const res = await fetch(`${this.base}/call/${api}`, {
      method: 'POST',
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    if (!res.ok) throw new Error(`${this.id} /${api}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    const { event_id } = (await res.json()) as { event_id: string };
    const stream = await fetch(`${this.base}/call/${api}/${event_id}`, { headers: this.headers });
    const text = await stream.text();
    const events: unknown[][] = [];
    let kind = '';
    for (const line of text.split('\n')) {
      if (line.startsWith('event:')) kind = line.slice(6).trim();
      else if (line.startsWith('data:')) {
        const payload = line.slice(5).trim();
        if (kind === 'error') throw new Error(`${this.id} /${api}: ${payload.slice(0, 300)}`);
        if ((kind === 'generating' || kind === 'complete') && payload.startsWith('[')) events.push(JSON.parse(payload));
      }
    }
    if (!events.length) throw new Error(`${this.id} /${api}: no answer (${text.slice(0, 200)})`);
    return events;
  }

  async download(file: { path: string; url?: string }): Promise<Buffer> {
    const res = await fetch(file.url ?? `${this.base}/file=${file.path}`, { headers: this.headers });
    if (!res.ok) throw new Error(`${this.id} download ${file.path}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
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
