# Changelog

One line per change, written for someone updating `@gtanczyk/diorama`. The category decides the
next version: **Breaking** and **Added** bump minor (major once 1.0 exists), **Fixed** bumps patch,
**Internal** never releases. Every push to main with new lines here refreshes the `release` PR;
merging it publishes to npm. See [docs/releasing.md](docs/releasing.md).

## Unreleased

### Added

- The Studio agent's model can be chosen: `DIORAMA_AGY_MODEL` (Antigravity, e.g. `gemini-4-argon-high`; `agy models` lists them), `DIORAMA_CODEX_MODEL`, `DIORAMA_MUSE_MODEL`, `DIORAMA_AGENT_CLAUDE_MODEL`, or `DIORAMA_AGENT_MODEL` for any agent.
- Drive places: a place with `"kind": "drive"` is a car ride seen from the side, its scenery streaming past in depth bands that loop, the hero in the car and things clicked without walking (docs/scenes.md, Drive).
- `story_look` (Studio action): sets what the hero says looking at one thing, adding the line where the story has none, without writing the whole story again; kept across rebuilds.

### Fixed

- A place whose approved concept keeps pulling the painting off its plan (a second new take asked for) is painted from the block-in alone, instead of failing the composition check take after take.

## 0.3.0 — 2026-11-05

### Added

- Small things painted falling (code rain, falling letters, snow, petals) fall on the page, each column at its own pace, instead of standing still or rippling like a waterfall.

### Fixed

- A person behind a slanted thing (a desk turned toward the camera) is hidden whole or not at all, decided where their feet are, instead of being cut in half down one column.
- An npc standing in front of an item or an exit steps aside so it stays in sight, and a click on the item where nobody is drawn over it takes the item, not the npc.

## 0.2.0 — 2026-11-04

### Fixed

- `npm publish` no longer runs `diorama publish` afterwards: the npm script for GitHub Pages is now `npm run pages`.

### Internal

- Published from a `v*` tag by GitHub Actions with npm trusted publishing.

## 0.1.0 — 2026-11-04

### Added

- First npm release: `npx -y @gtanczyk/diorama setup`, then `studio`, in an empty folder; worlds are written to `./worlds`.
- `diorama browsers` downloads Chromium for the Playwright that ships with Diorama.
