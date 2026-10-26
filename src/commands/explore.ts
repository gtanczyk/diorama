// diorama explore <slug> [place...]: walks the hero over every place in the real play page and
// reports what looks wrong (explore/ per place: report.json, heatmap.png, sheet.png).
// --fix closes the cells around bad spots in geometry.json; --no-judge skips the Spark juror.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { Geometry } from '../play/geometry.ts';
import { classify, contactSheet, fixGrid, heatmap, ISSUES, judge, positions, type Checked } from '../qa/explore.ts';
import { CROP_JS, PROBE_JS, type ProbeHit } from '../qa/probe.ts';
import { defineCommand, takeOption } from '../registry.ts';
import { WorldFiles } from '../world/files.ts';
import { serveWorld } from './play.ts';

type Browser = { newPage(o?: object): Promise<Page>; close(): Promise<void> };
type Page = {
  goto(url: string): Promise<unknown>;
  waitForFunction(js: string, arg?: unknown, o?: object): Promise<unknown>;
  evaluate<T>(js: string, arg?: unknown): Promise<T>;
  on(event: 'pageerror' | 'console', fn: (e: { message?: string; text?: () => string; type?: () => string }) => void): void;
};

/** Playwright is not a dependency: the explorer is a QA tool, and the browser is large. */
async function chromium(): Promise<{ launch(o?: object): Promise<Browser> }> {
  try {
    return ((await import('playwright' as string)) as { chromium: never }).chromium;
  } catch {
    try {
      return (createRequire(import.meta.url)('playwright') as { chromium: never }).chromium;
    } catch {
      throw new Error('explore needs Playwright with Chromium: npm i -D playwright && npx playwright install chromium');
    }
  }
}

/** Runs a page function given as source text, so the bundler adds nothing it can't see. */
const call = <T>(page: Page, fn: string, arg: unknown) => page.evaluate<T>(`(${fn})(${JSON.stringify(arg)})`);

defineCommand({
  name: 'explore',
  usage: 'explore <slug> [place...] walk the hero over each place and check every frame [--fix] [--no-judge] [--port N]',
  async run(args) {
    const fix = args.includes('--fix');
    const noJudge = args.includes('--no-judge');
    const port = Number(takeOption(args, 'port', '4183'));
    const [slug, ...only] = args.filter((a) => !a.startsWith('--'));
    if (!slug) throw new Error('usage: diorama explore <slug> [place...] [--fix] [--no-judge]');
    const files = new WorldFiles(slug);
    const world = files.world();
    const places = world.places.filter((p) => only.length === 0 || only.includes(p.key));

    const server = await serveWorld(files, port);
    const browser = await (await chromium()).launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 960 } });
      page.on('pageerror', (e) => console.log(`  page error: ${e.message}`));
      for (const place of places) {
        const at = (...parts: string[]) => files.place(place.key, ...parts);
        if (!fs.existsSync(at('geometry.json'))) {
          console.log(`${place.key}: no geometry.json, skipped`);
          continue;
        }
        const g = Geometry.parse(files.readJson(at('geometry.json')));
        await page.goto(`http://localhost:${port}/?capture=1&place=${place.key}`);
        await page.waitForFunction(`window.diorama && window.diorama.place && window.diorama.place.key === ${JSON.stringify(place.key)}`, undefined, { timeout: 30000 });

        const spots = positions(g);
        const started = Date.now();
        const hits: ProbeHit[] = [];
        for (let i = 0; i < spots.length; i += 100) hits.push(...(await call<ProbeHit[]>(page, PROBE_JS, { placeKey: place.key, positions: spots.slice(i, i + 100) })));
        const checked = hits.map(classify);
        const bad = checked.filter((h) => h.issues.length);
        const counts = Object.fromEntries(ISSUES.map((k) => [k, checked.filter((h) => h.issues.includes(k)).length]));
        console.log(`${place.key}: ${checked.length} spots in ${((Date.now() - started) / 1000).toFixed(1)} s, ${bad.length} with issues ${JSON.stringify(counts)}`);

        fs.rmSync(at('explore'), { recursive: true, force: true });
        const painting = fs.readFileSync(at('painting.png'));
        files.write(at('explore', 'heatmap.png'), await heatmap(painting, g, checked));

        // The juror: the worst spots first, the rest random clean ones, so it also says when all is fine.
        let jury: { tiles: Checked[]; wrong: { id: number; why: string }[] } | undefined;
        if (!noJudge) {
          const severity = (h: Checked) => h.issues.length * 1000 + h.drawn - h.hidden;
          const worst = [...bad].sort((a, b) => severity(b) - severity(a)).slice(0, 10);
          const clean = checked.filter((h) => !h.issues.length);
          const random = Array.from({ length: Math.min(16 - worst.length, clean.length) }, (_, i) => clean[Math.floor(((i + 0.5) * clean.length) / Math.min(16 - worst.length, clean.length))]);
          const tiles = [...worst, ...random];
          const crops = await Promise.all(tiles.map(async (t) => {
            const url = await call<string>(page, CROP_JS, { placeKey: place.key, x: t.x, y: t.y, size: 256 });
            return Buffer.from(url.slice(url.indexOf(',') + 1), 'base64');
          }));
          const sheet = await contactSheet(crops, 256);
          files.write(at('explore', 'sheet.png'), sheet);
          const wrong = await judge(files.memo, `explore:${place.key}`, sheet, tiles.length);
          jury = { tiles, wrong };
          const agree = wrong.filter((w) => tiles[w.id - 1].issues.length).length;
          console.log(`  juror: ${wrong.length} of ${tiles.length} tiles look wrong (${agree} also failed a code check)${wrong.map((w) => `\n    #${w.id} ${tiles[w.id - 1].issues.join('+') || 'clean'}: ${w.why}`).join('')}`);
        }

        let fixed: { closed: number; undone: string[] } | undefined;
        if (fix && bad.length) {
          const result = fixGrid(g, checked);
          fixed = { closed: result.closed, undone: result.undone };
          if (result.closed) {
            const flagged = [...(g.flagged ?? []), `explorer closed ${result.closed} cells where the hero looked wrong`];
            files.write(at('geometry.json'), Geometry.parse({ ...result.geometry, flagged }));
          }
          console.log(`  fix: closed ${result.closed} cells${result.undone.map((u) => `; not fixed: ${u}`).join('')}`);
        }

        files.write(at('explore', 'report.json'), {
          spots: checked.length,
          counts,
          bad: bad.map(({ x, y, issues, worst, drawn, hidden }) => ({ x, y, issues, worst, drawn, hidden })),
          ...(jury && { juror: jury.wrong.map((w) => ({ ...w, x: jury.tiles[w.id - 1].x, y: jury.tiles[w.id - 1].y, codeIssues: jury.tiles[w.id - 1].issues })) }),
          ...(fixed && { fixed }),
        });
      }
    } finally {
      await browser.close();
      server.close();
    }
    console.log(`spark calls sent: ${files.memo.sent.spark}`);
  },
});
