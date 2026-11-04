# Changelog

One line per change, written for someone updating `@gtanczyk/diorama`. The category decides the
next version: **Breaking** and **Added** bump minor (major once 1.0 exists), **Fixed** bumps patch,
**Internal** never releases. Every push to main with new lines here refreshes the `release` PR;
merging it publishes to npm. See [docs/releasing.md](docs/releasing.md).

## Unreleased

## 0.2.0 — 2026-11-04

### Fixed

- `npm publish` no longer runs `diorama publish` afterwards: the npm script for GitHub Pages is now `npm run pages`.

### Internal

- Published from a `v*` tag by GitHub Actions with npm trusted publishing.

## 0.1.0 — 2026-11-04

### Added

- First npm release: `npx -y @gtanczyk/diorama setup`, then `studio`, in an empty folder; worlds are written to `./worlds`.
- `diorama browsers` downloads Chromium for the Playwright that ships with Diorama.
