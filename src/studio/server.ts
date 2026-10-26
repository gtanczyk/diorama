// The Studio's local server. It listens on 127.0.0.1 only and trusts nobody by default: every API call
// carries the per-run token (handed to the browser in the URL fragment, so it never reaches a log or a
// Referer), the Host must be ours (no DNS rebinding), cross-site requests are refused (Origin and
// Sec-Fetch-Site), writes are JSON only and no CORS header is ever sent. World files are served to <img>
// with a SameSite=Strict cookie the page gets in exchange for the token.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import '../actions/index.ts';
import { ActionError, describeActions, runAction, type ActionContext } from '../actions/registry.ts';
import { redact } from '../secrets.ts';
import { Slug } from '../world/schema.ts';
import { Events, type StudioEvent } from './events.ts';
import { Jobs } from './jobs.ts';
import { History } from './history.ts';
import { handleMcp } from './mcp.ts';

export const STUDIO_WEB = fileURLToPath(new URL('../../studio/', import.meta.url));
const TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.json': 'application/json', '.mp3': 'audio/mpeg', '.jsonl': 'text/plain; charset=utf-8' };
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob: data:; media-src 'self'; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const COOKIE = 'diorama_studio';
const MAX_BODY = 1 << 20;

/** token opens the page; agentToken is the agent's (MCP, `diorama mcp`), so its calls show as the agent's. */
export type Studio = { url: string; port: number; token: string; agentToken: string; root: string; events: Events; jobs: Jobs; close(): Promise<void> };

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

async function bundleApp(): Promise<string> {
  const out = await build({
    entryPoints: [path.join(STUDIO_WEB, 'main.tsx')],
    bundle: true,
    format: 'esm',
    write: false,
    target: 'es2022',
    jsx: 'automatic',
    jsxImportSource: 'preact',
    sourcemap: 'inline',
  });
  return out.outputFiles[0].text;
}

/** Watches a world folder while someone looks at it: file changes and new model calls become events. */
class WorldWatch {
  private watcher: fs.FSWatcher | null = null;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private callsAt = 0;
  users = 0;

  constructor(private readonly slug: string, private readonly dir: string, private readonly events: Events) {
    const calls = path.join(dir, 'memo', 'calls.jsonl');
    this.callsAt = fs.existsSync(calls) ? fs.statSync(calls).size : 0;
  }

  start() {
    if (this.watcher || this.users <= 0 || !fs.existsSync(this.dir)) return;
    this.tailCalls();
    try {
      this.watcher = fs.watch(this.dir, { recursive: true }, (_, name) => name && this.changed(String(name)));
      this.watcher.on('error', () => this.stop());
    } catch {}
  }

  stop() {
    this.watcher?.close();
    this.watcher = null;
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private changed(name: string) {
    const file = name.split(path.sep).join('/');
    if (file === 'memo/calls.jsonl') return this.tailCalls();
    if (file.startsWith('memo/') || file.startsWith('studio/') || file.endsWith('.tmp')) return;
    clearTimeout(this.pending.get(file));
    this.pending.set(file, setTimeout(() => {
      this.pending.delete(file);
      const at = path.join(this.dir, file);
      const exists = fs.existsSync(at);
      this.events.publish('file.changed', { world: this.slug, file, exists, v: exists ? Math.round(fs.statSync(at).mtimeMs) : null });
    }, 150));
  }

  private tailCalls() {
    const file = path.join(this.dir, 'memo', 'calls.jsonl');
    if (!fs.existsSync(file)) return;
    const size = fs.statSync(file).size;
    if (size < this.callsAt) this.callsAt = 0;
    if (size === this.callsAt) return;
    const fd = fs.openSync(file, 'r');
    const chunk = Buffer.alloc(size - this.callsAt);
    fs.readSync(fd, chunk, 0, chunk.length, this.callsAt);
    fs.closeSync(fd);
    const text = chunk.toString('utf8');
    const complete = text.lastIndexOf('\n') + 1;
    this.callsAt += Buffer.byteLength(text.slice(0, complete));
    for (const line of text.slice(0, complete).split('\n')) {
      if (!line) continue;
      try {
        const { model, label, ms, hit } = JSON.parse(line) as Record<string, unknown>;
        this.events.publish('call', { world: this.slug, model, label, ms, hit });
      } catch {}
    }
  }
}

export async function startStudio(opts: { port?: number; root?: string; cwd?: string; token?: string; bin?: string } = {}): Promise<Studio> {
  const root = path.resolve(opts.root ?? 'worlds');
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const agentToken = randomBytes(32).toString('base64url');
  const cookie = randomBytes(32).toString('base64url');
  const events = new Events();
  const jobs = new Jobs(events, {
    cwd: opts.cwd,
    bin: opts.bin,
    beforeStart: (job) => {
      const dir = path.join(root, job.world);
      if (fs.existsSync(dir)) events.publish('history.snapshot', { world: job.world, id: new History(dir).snapshot(job.label, job.by).id });
    },
  });
  const watches = new Map<string, WorldWatch>();
  let app: Promise<string> | null = null;
  let port = 0;

  const watch = (slug: string) => {
    let w = watches.get(slug);
    if (!w) watches.set(slug, (w = new WorldWatch(slug, path.join(root, slug), events)));
    w.users++;
    w.start();
    return () => {
      if (--w!.users <= 0) w!.stop();
    };
  };
  // A job's world folder may appear only once the job runs; watch it from then on while anyone looks.
  events.subscribe((e) => {
    if (e.world && e.type !== 'file.changed' && e.type !== 'call') watches.get(e.world)?.start();
  });

  const server = http.createServer(async (req, res) => {
    const headers = { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cross-origin-resource-policy': 'same-origin' };
    const send = (status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}) => {
      res.writeHead(status, { ...headers, 'content-type': type, ...extra });
      res.end(body);
    };
    const json = (status: number, body: unknown) => send(status, 'application/json', JSON.stringify(body));
    try {
      const host = req.headers.host ?? '';
      if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(421, 'text/plain', 'wrong host');
      const site = req.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') return send(403, 'text/plain', 'cross-site request refused');
      const origin = req.headers.origin;
      if (origin && origin !== `http://${host}`) return send(403, 'text/plain', 'cross-origin request refused');

      const url = new URL(req.url ?? '/', `http://${host}`);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1] ?? '';
      const asAgent = !!bearer && same(bearer, agentToken);
      const authed = asAgent || (!!bearer && same(bearer, token));
      const body = async (): Promise<{ value?: unknown; error?: [number, string] }> => {
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          size += (chunk as Buffer).length;
          if (size > MAX_BODY) return { error: [413, 'too large'] };
          chunks.push(chunk as Buffer);
        }
        try {
          return { value: chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {} };
        } catch {
          return { error: [400, 'body is not JSON'] };
        }
      };
      const cookieOk = (req.headers.cookie ?? '').split(/;\s*/).some((c) => c.startsWith(`${COOKIE}=`) && same(c.slice(COOKIE.length + 1), cookie));

      // MCP over streamable HTTP, for the agent: plain JSON answers to POSTed JSON-RPC, no server stream.
      if (url.pathname === '/mcp') {
        if (!asAgent) return json(401, { error: 'the agent token is required' });
        if (req.method !== 'POST') return send(405, 'text/plain', 'POST JSON-RPC here', { allow: 'POST' });
        if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'JSON only' });
        const { value, error } = await body();
        if (error) return json(error[0], { jsonrpc: '2.0', id: null, error: { code: -32700, message: error[1] } });
        const ctx: ActionContext = { by: 'agent', root, jobs, events };
        const batch = Array.isArray(value) ? value : [value];
        const replies = (await Promise.all(batch.map((m) => handleMcp(m as Parameters<typeof handleMcp>[0], ctx)))).filter(Boolean);
        if (!replies.length) {
          res.writeHead(202, headers);
          return res.end();
        }
        return json(200, Array.isArray(value) ? replies : replies[0]);
      }

      if (url.pathname.startsWith('/api/')) {
        if (!authed) return json(401, { error: 'missing or wrong token: open the link diorama studio printed' });
        if (req.method === 'POST' && !(req.headers['content-type'] ?? '').startsWith('application/json')) return json(415, { error: 'JSON only' });

        if (url.pathname === '/api/session' && req.method === 'POST') {
          return send(200, 'application/json', '{"ok":true}', { 'set-cookie': `${COOKIE}=${cookie}; HttpOnly; SameSite=Strict; Path=/` });
        }
        if (url.pathname === '/api/actions' && req.method === 'GET') return json(200, describeActions());
        if (url.pathname.startsWith('/api/actions/') && req.method === 'POST') {
          const { value: input, error } = await body();
          if (error) return json(error[0], { error: error[1] });
          const ctx: ActionContext = { by: asAgent ? 'agent' : 'user', root, jobs, events };
          try {
            return json(200, { result: await runAction(url.pathname.slice('/api/actions/'.length), input, ctx) });
          } catch (error) {
            const status = error instanceof ActionError ? error.status : 500;
            return json(status, { error: redact(error instanceof Error ? error.message : String(error)) });
          }
        }
        if (url.pathname === '/api/events' && req.method === 'GET') {
          const world = url.searchParams.get('world') ?? undefined;
          if (world && !Slug.safeParse(world).success) return json(400, { error: 'bad world' });
          const since = Number(url.searchParams.get('since') ?? 0);
          res.writeHead(200, { ...headers, 'content-type': 'text/event-stream; charset=utf-8', connection: 'keep-alive' });
          const write = (e: StudioEvent) => {
            if (!world || !e.world || e.world === world) res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
          };
          for (const e of events.since(since, world)) write(e);
          res.write(': ready\n\n');
          const off = events.subscribe(write);
          const unwatch = world ? watch(world) : () => {};
          const beat = setInterval(() => res.write(': beat\n\n'), 15_000);
          req.on('close', () => {
            off();
            unwatch();
            clearInterval(beat);
          });
          return;
        }
        return json(404, { error: 'no such endpoint' });
      }

      if (req.method !== 'GET' && req.method !== 'HEAD') return send(405, 'text/plain', 'method not allowed');

      if (url.pathname.startsWith('/files/')) {
        if (!cookieOk) return send(401, 'text/plain', 'no session');
        const [slug, ...rest] = decodeURIComponent(url.pathname.slice('/files/'.length)).split('/');
        if (!Slug.safeParse(slug).success) return send(404, 'text/plain', 'not found');
        const dir = path.join(root, slug);
        const file = path.resolve(dir, rest.join('/'));
        // Only a world's own files, and never its memo (model answers) or anything outside the folder.
        if (!file.startsWith(dir + path.sep) || file.startsWith(path.join(dir, 'memo') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(404, 'text/plain', 'not found');
        return send(200, TYPES[path.extname(file)] ?? 'application/octet-stream', fs.readFileSync(file));
      }
      if (url.pathname === '/app.js') {
        if (!app || process.env.DIORAMA_STUDIO_DEV) app = bundleApp();
        try {
          return send(200, 'text/javascript; charset=utf-8', await app);
        } catch (error) {
          app = null;
          throw error;
        }
      }
      if (url.pathname === '/app.css') return send(200, 'text/css; charset=utf-8', fs.readFileSync(path.join(STUDIO_WEB, 'style.css')));
      // Every other path is a screen of the single-page app.
      return send(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(STUDIO_WEB, 'index.html')), { 'content-security-policy': CSP, 'x-frame-options': 'DENY' });
    } catch (error) {
      send(500, 'text/plain', redact(String(error instanceof Error ? error.message : error)));
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    port,
    token,
    agentToken,
    root,
    events,
    jobs,
    async close() {
      jobs.stopAll();
      for (const w of watches.values()) w.stop();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
