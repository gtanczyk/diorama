# Diorama

Diorama turns a story prompt into painted point-and-click scenes you can walk around in.

- **Muse Spark** plans the world and each scene, and judges the results.
- **Muse Image** paints every scene from a colour block-in.
- **SAM 3.1** cuts objects and walkable floor out of the painting.

Code then measures the floor, scale and occlusion from the masks and checks every scene before you play it. Each step writes plain files you can fix by hand and run again, so the tool does most of the work and shows you where to look for the rest.

Built during the Meta AI Global Hackathon (26 Oct - 4 Nov 2026).

## Setup

Node 22 or newer and a Meta Model API key:

```sh
npx -y github:gtanczyk/diorama setup    # what this machine still needs; asks for keys, hidden
npx -y github:gtanczyk/diorama doctor   # one live call to each model
```

`diorama setup` keeps keys encrypted (AES-256-GCM) under `~/.config/diorama/`, with the encryption key in the macOS Keychain or the Linux Secret Service. Environment variables (`META_API_KEY`, `ELEVENLABS_API_KEY`, `HF_TOKEN`) still work and win.

Model answers are kept by a hash of their inputs under each world's memo folder, so rerunning a step with the same inputs is free.

## Studio

`diorama studio [slug]` opens the GUI: describe a world and watch it build, place by place, with every step, model call and verify finding live. It listens on 127.0.0.1 only and opens through the one-time link it prints. Everything it does is an action, also runnable as `diorama action <name> '<json>'` (`diorama action` lists them), so a terminal, the page and the Muse Code agent drive the same things.

## Sound

`diorama sound <slug>` (also a build step) has Spark plan what the world sounds like from its places, the brief of each painting and the story: a music bed, the ambience of every place, loops on things that sound (a lantern flame, a flag in the wind, a lamp that only roars once the story lights it), the surface of every floor, and one-shots for taking, using, exits, talking and the ending. The plan is `sound.json`; edit it and run the step again to regenerate only what changed.

The Meta Model API has no audio model, so effects come from ElevenLabs (`ELEVENLABS_API_KEY`) and music from Meta's open-weights MusicGen run on your machine (`DIORAMA_PYTHON=/path/to/python` with `torch transformers scipy`; without it, or with `--music eleven`, ElevenLabs makes the music). Code checks every take: a loop that came back as one event is asked for again, loops are crossfaded into themselves so they never click, footstep takes are cut into single steps, and everything is levelled. Needs `ffmpeg`. Without a key the world plays silent.

`diorama voices <slug>` (also a build step) speaks the conversations, the intro and the endings (`--all` also voices the hero's remarks on things; by default those stay in the bubble so the game does not talk at every click). Spark casts a stock ElevenLabs voice for the narrator, the hero and each NPC from how they look and talk (`voices.json`, edit to recast), ElevenLabs reads each line, and **Muse Voice Transcribe** listens to every take: a take that does not say its line is read again, up to three times, and flagged if it still does not.

In the page, loops pan and fade with where the hero stands, footsteps follow the floor under him, and `m` mutes. `diorama playthrough --video` records the page's sound too and writes an mp4.

## Checking a world

`diorama build` ends with `verify`, which writes `verify.json` per place and prints which places are playable and what was flagged on the way. Every step also leaves a picture to look at: `masks/overlay.png` (what SAM found) and `walk.png` (where the hero can walk, footprints, floor lines and his size at a few depths).

`diorama explore <slug>` puts the hero on every part of each floor in the real play page and checks each frame; it needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`). `--fix` closes the floor where he looked wrong.

## Characters

`build` paints places, not people; characters are separate steps, run after it:

- `diorama cast <slug>` paints the hero and every NPC (cast/<key>.png) and cuts each into parts with SAM for a 2D walk rig (cast/<key>/rig.json).
- `diorama model <slug>` and `diorama sprites <slug>` give a character painted walk and talk sheets (cast/<key>/sprites/). Only what the story uses is drawn: the walk facings the hero's routes need, one talk sheet per speaker in the facing of their conversation, and the gesture each line calls for.

The page draws the best a character has: sprite sheets, else the 3D model (`?model=1` prefers it), else the 2D rig, else the plain cut-out.

## In the play page

- **Walking:** the hero routes over the walk grid; the walk phase follows the distance walked, so feet don't slide. Things in front of a person (per-column floor lines from `derive`) are drawn back over them.
- **Light and shadow:** `derive` measures the painting's light from the shadows things cast (`light` in geometry.json) and masks those shadows (`masks/shadows.png`). A person then casts a matching soft shadow and darkens inside a painted one. A place where nothing casts a shadow (fog, overcast) gets neither.
- **Talking:** each line knows who says it; the bubble sits over the speaker, who plays the line's gesture while the other listens.
- **URL switches:** `place=<key>` start there, `spawn=x,y,left|right` put the hero, `capture=1` fixed 1/60 s steps for recording (flat, no parallax), `parallax=N` force parallax, `grid=1` show the walk grid and occluders, `model=1|0` prefer or skip the 3D figure, `sound=0` silent, `cursor=0` hide the cursor. `window.diorama` drives the page from scripts: `walkTo`, `use`, `act`, `play(steps)`, `wait`, `on(event)`.

## Playing and sharing a world

- `diorama play <slug>` serves it on localhost.
- `diorama publish <slug>` puts it on this repo's GitHub Pages (the `gh-pages` branch, through a worktree under `.diorama/`, so your checkout stays put) and prints a link like `https://gtanczyk.github.io/diorama/<slug>/`. Every published world is listed at `https://gtanczyk.github.io/diorama/`. The first time, turn on Settings > Pages > Deploy from a branch > `gh-pages`. Run it from a fork to publish to your own Pages.
- `diorama export <slug> --zip` writes `exports/<slug>/` and `exports/<slug>.zip`, a static copy any web host serves; the zip uploads to itch.io as an HTML5 game as is.

## Status

Work in progress; see the commit log.

## License

Apache-2.0
