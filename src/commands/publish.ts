// diorama publish <slug>: exports the world onto the repo's gh-pages branch and pushes it, so anyone can play it at a link.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { defineCommand, takeOption } from '../registry.ts';
import { exportWorld } from './export.ts';

/** https://<owner>.github.io/<repo>/ for a GitHub remote URL (https or ssh), or null for any other host. */
export function pagesUrl(remote: string): string | null {
  const m = remote.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  if (!m) return null;
  const [, owner, repo] = m;
  return repo.toLowerCase() === `${owner.toLowerCase()}.github.io` ? `https://${repo}/` : `https://${owner}.github.io/${repo}/`;
}

/** The front page of the published site: one link per world folder that holds a world-data.json. */
export function indexPage(worlds: { slug: string; title: string }[]): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const items = worlds.map((w) => `<li><a href="./${encodeURIComponent(w.slug)}/">${esc(w.title)}</a></li>`).join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Diorama worlds</title>
<style>body{margin:0;padding:40px 24px;background:#0b0b0e;color:#e8e2d6;font:18px/1.5 Georgia,serif}main{max-width:640px;margin:auto}a{color:#ffd37a}li{margin:8px 0}</style>
</head><body><main><h1>Diorama worlds</h1><p>Painted point-and-click places made with Meta Muse and SAM 3.1. Click one to play in the browser.</p>
<ul>
${items}
</ul><p><a href="https://github.com/gtanczyk/diorama">Source</a></p></main></body></html>
`;
}

defineCommand({
  name: 'publish',
  usage: 'publish <slug> [--remote origin] [--branch gh-pages] [--no-push]   put the world on GitHub Pages and print its link',
  async run(args) {
    const remote = takeOption(args, 'remote', 'origin');
    const branch = takeOption(args, 'branch', 'gh-pages');
    const push = !args.includes('--no-push');
    const [slug] = args.filter((a) => a !== '--no-push');
    if (!slug) throw new Error('usage: diorama publish <slug> [--remote origin] [--branch gh-pages] [--no-push]');
    const git = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const top = git(process.cwd(), 'rev-parse', '--show-toplevel');

    // A worktree of the pages branch under .diorama/, so the checkout you work in never switches branch.
    const site = path.join(top, '.diorama', 'pages');
    if (fs.existsSync(site)) git(top, 'worktree', 'remove', '--force', site);
    git(top, 'worktree', 'prune');
    const onRemote = git(top, 'ls-remote', '--heads', remote, branch) !== '';
    if (onRemote) {
      git(top, 'fetch', remote, branch);
      git(top, 'worktree', 'add', '-B', branch, site, 'FETCH_HEAD');
    } else if (git(top, 'branch', '--list', branch) !== '') {
      git(top, 'worktree', 'add', site, branch);
    } else {
      git(top, 'worktree', 'add', '--detach', site);
      git(site, 'checkout', '--orphan', branch);
      git(site, 'rm', '-rfq', '--ignore-unmatch', '.');
    }

    await exportWorld(slug, path.join(site, slug));
    fs.writeFileSync(path.join(site, '.nojekyll'), '');
    const worlds = fs.readdirSync(site)
      .filter((d) => fs.existsSync(path.join(site, d, 'world-data.json')))
      .map((d) => ({ slug: d, title: JSON.parse(fs.readFileSync(path.join(site, d, 'world-data.json'), 'utf8')).world?.title ?? d }));
    fs.writeFileSync(path.join(site, 'index.html'), indexPage(worlds));

    git(site, 'add', '-A');
    if (git(site, 'status', '--porcelain') === '') console.log(`publish ${slug}: nothing changed`);
    else git(site, 'commit', '-qm', `publish ${slug}`);
    if (push) git(site, 'push', remote, branch);

    const base = pagesUrl(git(top, 'remote', 'get-url', remote));
    console.log(`publish ${slug}: ${push ? 'pushed' : 'committed, not pushed'} to ${remote}/${branch}`);
    if (base) {
      console.log(`  play: ${base}${slug}/`);
      console.log(`  all worlds: ${base}`);
      if (!onRemote) console.log(`  first publish: turn on Settings > Pages > Deploy from a branch > ${branch} once; the link works a minute after.`);
    }
  },
});
