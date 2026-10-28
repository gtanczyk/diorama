# Demo film

The 3-minute demo film is rendered from data, so every improvement to the tool flows into the film by re-running two commands.

- `app/demo/cut.json`: the edit. Each shot names its clip, still or title card, how long it holds and whether it fades in.
- `npx tsx app/demo/cut.ts app/demo/cut.json app/demo/out/cut.mp4` renders it. A clip that does not exist yet renders as a labelled card, so the cut always plays end to end.
- `app/demo/voiceover.md`: the voice-over lines, where they fall and which file each one is recorded to.
- The film runs in eight parts, numbered in the shot names: hook, pitch, the world with no talking, the terminal, how it's made, Studio, the techniques up close, thanks with the repo link.
- Clips live in `app/demo/footage/` (not in git): camera shots, plus clips the tool makes:
  - `diorama reel <slug> [place]`: the build-up of a place, one beat per step, captioned with the model that made it.
  - `diorama playthrough <slug> [ending] --video`: a story ending played in the browser.
  - `footage/stills/`: single reel stills (from `worlds/<slug>/film/reel-<place>/`) held as technique close-ups.
  - `npx tsx app/demo/term.ts <log.txt> "<command>" footage/term.mp4`: the terminal shot, typed and scrolled from a real build log.
