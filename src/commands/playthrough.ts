// diorama playthrough <slug> [ending...]: the bot plays the shortest route to each ending in the real page,
// fails if an ending is not reached, and records each run (playthrough/<ending>.webm) when --video is given.
import fs from 'node:fs';
import path from 'node:path';
import { defineCommand, takeOption } from '../registry.ts';
import { checkStory } from '../story/check.ts';
import type { Action } from '../story/engine.ts';
import { WorldFiles } from '../world/files.ts';
import { chromium, type Page } from './explore.ts';
import { serveWorld } from './play.ts';

type Step = { use: string; verb?: string; with?: string } | { act: Action } | { wait: number };

/** A story action as what a player does on the page: click the thing, or pick an answer. */
export function toStep(action: Action): Step {
  switch (action.kind) {
    case 'go': return { use: action.via };
    case 'talk': return { use: action.npc };
    case 'do': return { use: action.thing, verb: action.verb, ...(action.with ? { with: action.with } : {}) };
    default: return { act: action };
  }
}

type Run = { ending: string; reached: string | null; clicks: number; seconds: number; frames: number; video?: string; error?: string };

defineCommand({
  name: 'playthrough',
  usage: 'playthrough <slug> [ending...] play the route to each ending in the browser and check it is reached [--video] [--query "parallax=1&track=1"] [--port N]',
  async run(args) {
    const video = args.includes('--video');
    const port = Number(takeOption(args, 'port', '4193'));
    // Extra page options, e.g. parallax=1&track=1, so a recording looks like the game people play.
    const query = takeOption(args, 'query', '');
    const [slug, ...only] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama playthrough <slug> [ending...] [--video]');
    const files = new WorldFiles(slug);
    const world = files.world();
    // Routes come from the story as it is now, never from an old routes.json.
    const report = checkStory(world, files.readJson(files.path('story.json')));
    if (report.issues.length) throw new Error(`story.json does not check out:\n- ${report.issues.join('\n- ')}`);
    const routes = report.routes.filter((r) => only.length === 0 || only.includes(r.ending));
    const outDir = files.path('playthrough');
    fs.rmSync(outDir, { recursive: true, force: true });

    const server = await serveWorld(files, port);
    const browser = await (await chromium()).launch();
    const runs: Run[] = [];
    try {
      for (const route of routes) {
        const page = (await browser.newPage({
          viewport: { width: 1920, height: 1080 },
          ...(video ? { recordVideo: { dir: outDir, size: { width: 1920, height: 1080 } } } : {}),
        })) as Page & { close(): Promise<void>; video(): { path(): Promise<string> } | null };
        page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
        await page.goto(`http://localhost:${port}/?capture=1&cursor=0${query ? `&${query}` : ''}`);
        await page.waitForFunction('window.diorama && window.diorama.place', undefined, { timeout: 30000 });
        const steps: Step[] = [{ wait: 600 }, ...route.actions.map(toStep), { wait: 2500 }];
        const started = Date.now();
        const run: Run = { ending: route.ending, reached: null, clicks: route.actions.length, seconds: 0, frames: 0 };
        try {
          const result = await page.evaluate<{ ending: string | null; frames: number; time: number }>(`(async (steps) => {
            const game = window.diorama;
            let ending = null;
            game.on((event, detail) => { if (event === 'ending') ending = detail.ending; });
            await game.play(steps);
            return { ending: ending ?? game.state.ending ?? null, frames: game.frame, time: game.time };
          })(${JSON.stringify(steps)})`);
          Object.assign(run, { reached: result.ending, frames: result.frames, seconds: Math.round(result.time * 10) / 10 });
        } catch (error) {
          run.error = (error as Error).message.split('\n')[0];
        }
        await page.close();
        const recorded = video ? await page.video()?.path() : undefined;
        if (recorded) {
          run.video = path.join(outDir, `${route.ending}.webm`);
          fs.renameSync(recorded, run.video);
        }
        runs.push(run);
        const ok = run.reached === route.ending;
        console.log(`${ok ? 'ok  ' : 'FAIL'} ${route.ending}: ${run.clicks} clicks, ${run.seconds} s game time (${((Date.now() - started) / 1000).toFixed(0)} s wall)${run.error ? ` · ${run.error}` : ''}${!ok && !run.error ? ` · reached ${run.reached ?? 'no ending'}` : ''}`);
      }
    } finally {
      await browser.close();
      server.close();
    }
    files.write(path.join(outDir, 'report.json'), runs);
    const failed = runs.filter((r) => r.reached !== r.ending);
    if (failed.length) throw new Error(`${failed.length} of ${runs.length} ending(s) not reached in the page`);
  },
});
