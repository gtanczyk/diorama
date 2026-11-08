# Changelog

One line per change, written for someone updating `@gtanczyk/diorama`. The category decides the
next version: **Breaking** and **Added** bump minor (major once 1.0 exists), **Fixed** bumps patch,
**Internal** never releases. Every push to main with new lines here refreshes the `release` PR;
merging it publishes to npm. See [docs/releasing.md](docs/releasing.md).

## Unreleased

## 0.5.0 — 2026-11-07

### Added

- The Studio's agent header shows the agent's plan limits (Claude Code's 5-hour and weekly, Codex's) once one is near its end, with when it resets, and the terminal warns once. `DIORAMA_AGENT_MAX_COST` and `DIORAMA_AGENT_MAX_TOKENS` cap one world's conversation (docs/studio.md).
- `hero_size_set` (Studio action): how tall the hero stands in a place, as times a painted thing's height ("about as tall as the candle jar"); it sets the place's scale and is kept across rebuilds. For worlds whose places Spark scales ten times apart (a desk seen whole, a close-up of a mug), where the hero changed size from place to place and a close-up left only a strip of floor to walk.

### Fixed

- A rustle like "Hrrsh..." in a line counts as an acted sound, so a voice take is no longer rejected when the transcriber leaves it out.
- A painted trail or flight of steps thinner or off its planned strip, or a floor ending at its exit or a cliff face rather than the frame edge, no longer sets a place aside while the floor still joins and every item and exit has an approach (all three places of a new world were set aside for it).
- `voices` speaks every line by default, the hero's looks, uses and locked doors too: a hero heard in conversations and silent everywhere else read as broken. `--essential` keeps to conversations, intro and endings; `--all` is no longer needed.
- The frame and near-camera gates of `derive` measure the hero at its own height (cast/figures.json), not a grown-up's: a small hero is no longer shut out of the front of a close-up.
- A candle or lamp no longer flares a bright square over the floor and things around it (a letter beside a candle jar): the flame's animated pixels are only its own near-white warm ones, faded out towards the edge of the box they are taken from.
- A backdrop behind the cards no longer shows square patches where a big hole was filled (most visible in a lamp's warm light): the smear fill reads coarser levels bilinearly instead of in blocks.
- An NPC that is a thing (a steaming mug, a candle in a jar) and that the place's words also name is no longer left painted into the background beside the figure the game draws: the people check before and after the critic now looks for the place's NPCs by their looks too.
- A creature's 3D model is no longer built from sides that disagree (a mug painted on a bottle from the side but not from the front), which tore it: the back and side views are checked against the front and painted again up to twice, and if they still disagree there is no model and the painted figure hops as it is.
- `derive` no longer crashes with `g.walk[r] is not iterable` on a place with no walkable floor; verify reports NO_FLOOR as it should.

## 0.4.1 — 2026-11-06

### Fixed

- Setup hints, usage lines and errors show the command that works for how Diorama was started (`npx @gtanczyk/diorama browsers` under npx, `diorama browsers` for a global install, `npm run diorama -- browsers` in a checkout) instead of a bare `diorama` that npx users do not have. `diorama setup` offers to download Chromium on the spot, and the Studio's Setup card for it has a Download button. `DIORAMA_CLI` overrides the shown command.

## 0.4.0 — 2026-11-05

### Added

- The Studio agent's model can be chosen: `DIORAMA_AGY_MODEL` (Antigravity, e.g. `gemini-4-argon-high`; `agy models` lists them), `DIORAMA_CODEX_MODEL`, `DIORAMA_MUSE_MODEL`, `DIORAMA_AGENT_CLAUDE_MODEL`, or `DIORAMA_AGENT_MODEL` for any agent.
- The hero's car: a place with `"kind": "drive"` is the car standing at the kerb with the engine running (trembling, exhaust, lights), the hero at the wheel and a board of destinations; every place has the car parked in it to get in, and picking a destination fades to the hero stepping out there. No driving animation (docs/scenes.md, Drive). A `go` through one thing that leads to several places carries `to`.
- Grown-ups' sketches as input: a drawing Spark reads as a teen's or adult's sketch (pen, pencil, ink, watercolour) no longer makes a kids' game; when every drawing is one, the world keeps the sketches' own medium as its style and painters are told it is the artist's sketch, not a child's.
- `story_look` (Studio action): sets what the hero says looking at one thing, adding the line where the story has none, without writing the whole story again; kept across rebuilds.

### Fixed

- With `?fill=1` (the painting covering the whole page) a drive place's destination board and the speech bubbles stay on the visible part of the page instead of running off its edge.
- The hero's car looks the same in every place it is parked in: the car as painted in the drive place, cut out by its mask, goes to each such place's painting as its reference (places painted before it keep theirs until repainted).
- `playthrough` and `clip` aim at things in frame pixels, so they still find them when the page has lowered its resolution on a slow machine.
- A grown-up's sketch of a whole place is now that place's camera: it stands in for the block-in like a photo (`places/<key>/sketch.png`), the layout is measured from it and Muse finishes it in the same hand, instead of failing PAINT_LAYOUT_MISMATCH on every take because Muse followed the sketch, not the plan.
- A sound plan with more one-shots than fit (a world with many exits) keeps the first 24 instead of failing the build.
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
