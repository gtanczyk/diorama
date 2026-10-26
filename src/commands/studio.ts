// diorama studio [slug]: the GUI. A local page to start, watch and fix worlds, driven by the same actions
// as `diorama action` and the Muse Code agent.
import { spawn } from 'node:child_process';
import { defineCommand, takeOption } from '../registry.ts';
import { startStudio } from '../studio/server.ts';

defineCommand({
  name: 'studio',
  usage: 'studio [slug]           open Diorama Studio, the GUI, on 127.0.0.1 [--port N] [--no-open]',
  async run(args) {
    const port = Number(takeOption(args, 'port', '0'));
    const noOpen = args.includes('--no-open');
    const slug = args.find((a) => !a.startsWith('--'));
    const studio = await startStudio({ port });
    // The token rides in the fragment: browsers never send it to a server or put it in a Referer.
    const link = `${studio.url}${slug ? `w/${slug}` : ''}#${studio.token}`;
    console.log(`Diorama Studio: ${link}\n(only this link opens it; Ctrl+C to stop)`);
    if (!noOpen) {
      const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
      spawn(opener, [link], { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
    }
    const stop = async () => {
      await studio.close();
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
    await new Promise(() => {});
  },
});
