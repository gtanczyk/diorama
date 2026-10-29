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
npm run doctor -- --now        # before building in front of people: is the network and Meta fast enough today
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

### What it costs

Every call sent is logged with its price in `worlds/<slug>/memo/calls.jsonl` (Meta list prices: Muse Image $0.01 an image, SAM 3.1 $0.0025 an image, Muse Spark by tokens). Studio Setup shows the total, today's spend and, once you type the balance your Meta billing page shows, the credits left; the banner warns at $5.

- `DIORAMA_SPARK_TIER`: `auto` (default) sends Spark to Meta's contributor tier (same model, about 1/15 the price, Meta may train on the prompt and answer), except calls that carry your own photos or drawings, which stay `standard`. Set `standard` or `contributor` to force one.
- Studio Setup has two pickers, Thinking (Spark) and Painting, kept in `~/.config/diorama/models.json`. The environment variables below win over them.
- Studio Setup → Audio → Audio quality selects Final (the default) or Draft for future sound and voice generation in all worlds. It is saved in `~/.config/diorama/sound.json` and also used by CLI commands. `DIORAMA_SOUND` overrides the saved choice; `--final` / `--draft` override both for a command. Existing recordings need Voices and Sound rerun; changing quality does not rewrite dialogue.
- `DIORAMA_SPARK_VIA`: which model answers Spark's asks. `meta` (default); `claude` (Anthropic API, `DIORAMA_ANTHROPIC_API_KEY`, model `DIORAMA_CLAUDE_MODEL`, default `claude-sonnet-5-5`); `openrouter:<model id>` (any chat model, `OPENROUTER_API_KEY`).
- `DIORAMA_IMAGE_VIA`: which model paints. `meta` (Muse Image, default); `gemini-flash`, `gemini-lite`, `nano-banana`, `gemini-pro` (Gemini image models: straight from Google with `GEMINI_API_KEY` or `GOOGLE_API_KEY`, otherwise through OpenRouter), or any OpenRouter image model id. Pictures come back at Muse's size, so every later step works the same. SAM 3.1 always cuts.
- Answers from another model are kept under their own memo keys and logged with `via`; Setup counts them apart from Meta's bill. Switching back to Meta finds the Meta answers again. A world meant for the hackathon demo stays on Meta (the default).

## Playing and sharing a world

- `diorama play <slug>` serves it on localhost.
- `diorama publish <slug>` puts it on this repo's GitHub Pages (the `gh-pages` branch, through a worktree under `.diorama/`, so your checkout stays put) and prints a link like `https://gtanczyk.github.io/diorama/<slug>/`. Every published world is listed at `https://gtanczyk.github.io/diorama/`. The first time, turn on Settings > Pages > Deploy from a branch > `gh-pages`. Run it from a fork to publish to your own Pages.
- `diorama export <slug> --zip` writes `exports/<slug>/` and `exports/<slug>.zip`, a static copy any web host serves; the zip uploads to itch.io as an HTML5 game as is.
- In the Studio, the top bar's ☰ menu shares a game both ways: Make a zip (then Download it) and Publish a link (it asks first, since anyone can play it there). The agent has them as `world_export` and `world_publish`.
