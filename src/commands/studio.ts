// diorama studio [slug]: the GUI. A local page to start, watch and fix worlds, driven by the same actions
// as `diorama action` and the Muse Code agent.
import { spawn } from 'node:child_process';
import { defineCommand, takeOption } from '../registry.ts';
import { writeStudioFile } from '../studio/discovery.ts';
import type { StudioEvent } from '../studio/events.ts';
import { startStudio } from '../studio/server.ts';

defineCommand({
  name: 'studio',
  usage: 'studio [slug]           open Diorama Studio, the GUI, on 127.0.0.1 [--port N] [--no-open] [--quiet] [--verbose: every line jobs print]',
  async run(args) {
    const port = Number(takeOption(args, 'port', '0'));
    const noOpen = args.includes('--no-open');
    const quiet = args.includes('--quiet');
    const verbose = args.includes('--verbose');
    const slug = args.find((a) => !a.startsWith('--'));
    const studio = await startStudio({ port });
    const forget = writeStudioFile(process.cwd(), { url: studio.url, agentToken: studio.agentToken });
    // The token rides in the fragment: browsers never send it to a server or put it in a Referer.
    const link = `${studio.url}${slug ? `w/${slug}` : ''}#${studio.token}`;
    console.log(`Diorama Studio: ${link}\n(only this link opens it; Ctrl+C to stop)`);
    if (!quiet) studio.events.subscribe((e) => {
      const line = describe(e, verbose);
      if (line) console.log(`${e.at.slice(11, 19)} ${e.world ? `${e.world}: ` : ''}${line}`);
    });
    if (!noOpen) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
    const stop = async () => {
      forget();
      await studio.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
  },
});

/** One terminal line per event worth seeing: what runs, what ends, what the agent does. Keys are already redacted. */
function describe(e: StudioEvent, verbose: boolean): string | null {
  const job = e.job as { label?: string; by?: string; state?: string; error?: string } | undefined;
  switch (e.type) {
    case 'job.start': return `started ${job?.label} (${job?.by})`;
    case 'job.end': return `${job?.state} ${job?.label}${job?.error ? `: ${job.error}` : ''}`;
    case 'step.start': return `> ${e.step}`;
    case 'step.end': return `ok ${e.step} ${e.seconds}s`;
    case 'step.fail': return `FAILED ${e.step}: ${e.error}`;
    case 'place.verdict': return `${e.place}: ${e.ok ? 'playable' : 'NOT playable'}`;
    case 'action.start': return e.by === 'agent' || !['world_list', 'world_status', 'setup_status', 'job_list', 'history_list'].includes(String(e.action)) ? `${e.by}: ${e.action}` : null;
    case 'action.end': return e.ok ? null : `${e.by}: ${e.action} failed: ${e.error}`;
    case 'history.undo': return `${e.by}: undo to ${e.id}`;
    case 'lock.changed': return `${e.by}: ${e.locked ? 'locked' : 'unlocked'} ${e.place ?? 'world'}`;
    case 'agent.user': return `you -> Muse Code: ${String(e.text).slice(0, 120)}`;
    case 'agent.message': return `Muse Code: ${String(e.text).slice(0, 200)}`;
    case 'agent.turn.end': return e.status === 'completed' ? null : `Muse Code stopped: ${e.error ?? e.status}`;
    case 'agent.error': return `Muse Code error: ${e.text}`;
    case 'log': return verbose || e.stream === 'err' ? `  ${e.line}` : null;
    default: return null;
  }
}
