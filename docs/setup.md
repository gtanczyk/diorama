# Setup and sharing

## Setup

Node 22 or newer and a Meta Model API key:

```sh
npx -y github:gtanczyk/diorama setup    # what this machine still needs; asks for keys, hidden
npx -y github:gtanczyk/diorama doctor   # one live call to each model
```

`diorama setup` keeps keys encrypted (AES-256-GCM) under `~/.config/diorama/`, with the encryption key in the macOS Keychain or the Linux Secret Service. Environment variables (`META_API_KEY`, `ELEVENLABS_API_KEY`, `HF_TOKEN`) still work and win.

From a checkout, `npm install` once, then the common commands are npm scripts (arguments go after `--`):

```sh
npm run setup
npm run doctor
npm run studio                 # the GUI
npm run build -- <slug> "<idea>"
npm run play -- <slug>
npm run publish -- <slug>
npm run export -- <slug> --zip
npm run browsers               # Playwright's Chromium, for explore, playthrough and sprites
npm run diorama -- <command>   # any other command, e.g. npm run diorama -- masks <slug>
npm run check                  # typecheck and tests
```

Model answers are kept by a hash of their inputs under each world's memo folder, so rerunning a step with the same inputs is free.

## Playing and sharing a world

- `diorama play <slug>` serves it on localhost.
- `diorama publish <slug>` puts it on this repo's GitHub Pages (the `gh-pages` branch, through a worktree under `.diorama/`, so your checkout stays put) and prints a link like `https://gtanczyk.github.io/diorama/<slug>/`. Every published world is listed at `https://gtanczyk.github.io/diorama/`. The first time, turn on Settings > Pages > Deploy from a branch > `gh-pages`. Run it from a fork to publish to your own Pages.
- `diorama export <slug> --zip` writes `exports/<slug>/` and `exports/<slug>.zip`, a static copy any web host serves; the zip uploads to itch.io as an HTML5 game as is.
- In the Studio, the top bar's ☰ menu shares a game both ways: Make a zip (then Download it) and Publish a link (it asks first, since anyone can play it there). The agent has them as `world_export` and `world_publish`.
