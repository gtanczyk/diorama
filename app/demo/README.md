# Demo film

The 3-minute demo film is rendered from data, so every improvement to the tool flows into the film by re-running two commands.

- `app/demo/cut.json`: the edit. Each shot names its clip, still or title card, how long it holds, whether it fades in, and an optional caption with the model that did the work (`by`) and a speed mark (`speedup`). `cut-35years.json` is the earlier "35 years" cut.
- `npx tsx app/demo/cut.ts app/demo/cut.json app/demo/out/cut.mp4` renders it. A clip that does not exist yet renders as a labelled card, so the cut always plays end to end.
- `app/demo/voiceover.md`: the voice-over lines, where they fall and which file each one is recorded to.
- The film runs in eight parts, numbered in the shot names: cold open, me on camera, the idea with photos and Diorama's questions, the build (one caption per model), how it's made (method stills, parallax, the hero in 3D), play, a change asked with a screenshot, export played in a browser, the repo link.
- Clips live in `app/demo/footage/` (not in git): camera shots, plus clips the tool makes:
  - `diorama reel <slug> [place]`: the build-up of a place, one beat per step, captioned with the model that made it.
  - `diorama playthrough <slug> [ending] --video`: a story ending played in the browser.
  - `footage/stills/`: single reel stills (from `worlds/<slug>/film/reel-<place>/`) held as technique close-ups.
  - `npx tsx app/demo/walkthrough.ts --idea "..." --photo a.jpg --change "..."`: the whole Studio in one take (idea, questions, build, play, change with a screenshot, play, zip, the zip in a browser); `--review-only` stops after the questions.
  - `npx tsx app/demo/places-take.ts <slug>...`: the game itself, a walk with the tracking camera and parallax in every place.
  - `npx tsx app/demo/method-take.ts <slug> <place>`: "how it's made" stills (plan, painting, SAM cut-outs, depth, floor) and the place live with strong parallax.
  - `npx tsx app/demo/cast-take.ts <slug> <who>`: a character in Studio: walk sheets, the 3D model walking and talking, the 2D walk.
  - `npx tsx app/demo/studio-take.ts`: Studio takes from the atelier, a world made from an idea (`--new`) or changed by the agent; writes take.mp4 + take.json beats.
  - `npx tsx app/demo/term.ts <log.txt> "<command>" footage/term.mp4`: the terminal shot, typed and scrolled from a real build log.
