# Releasing

`CHANGELOG.md` decides every npm release of `@gtanczyk/diorama`; nobody runs `npm version` by hand.

1. With a change to shipped code (`app/bin`, `app/src`, `app/studio`, `app/web`), add one line under
   `## Unreleased`, written for someone updating Diorama:
   - `### Breaking`: a command, flag or world file layout changed incompatibly (minor before 1.0, major after)
   - `### Added`: something new you can do (minor)
   - `### Fixed`: something that was wrong now works (patch)
   - `### Internal`: refactors, tests, tooling; never releases
2. Push to main. `release-pr.yaml` checks the changelog, cuts the next version on branch `release/next`
   and opens (or refreshes) the PR **`release: vX.Y.Z`**. Later pushes with more lines update the same PR.
3. Merge the PR. `publish.yaml` sees `package.json` change, publishes to npm (trusted publishing, no
   token) and creates the `vX.Y.Z` tag and a GitHub Release with that section as notes.

Hold a release by leaving the PR open. Set the repository variable `RELEASE_AUTOMERGE=true` to merge it
by itself. A version npm already has is never published twice; Actions → Publish to npm → Run workflow
publishes the version in `package.json` by hand.

Locally: `node app/scripts/release.mjs next` (the next version, or none), `notes 0.2.0`, `check`
(changelog well formed and agreeing with package.json; `--files a,b` also asks for a changelog line
when those files ship).
