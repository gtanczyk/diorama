# Live demo cut (v5)

Edit list for `app/demo/live-cut.ts cut`, plus the English subtitles of the result.

Lay the sources out next to `edit-v5.json` (paths in it are relative to the json):
- `phone.mp4`, `screen.mp4`: the phone and screen recordings at 1080p30 (screen time = phone time - 60.55 s)
- `storygraph.mp4`: screen3-story-graph recording
- `broll/`: cat-play.mp4 (cat-house-play), cat-yellow.mp4, w-harbour, w-star, w-labyrinth, w-ticket, w-drawn, w-storm, w-storm2 (.mp4), music.mp3 (cat-eared-house-music)
- `boards/`: boards-v2 PNGs (intro, idea, build, play, change, end)
- `vo/`: whole sentences cut from the recorded lines:
  - `ffmpeg -ss 3.85 -t 6.4 -i vo1.wav -af "afade=t=in:d=0.03,afade=t=out:st=6.25:d=0.15" vo1-fix.wav`
  - `ffmpeg -ss 2.75 -t 8.9 -i vo2.wav -af "afade=t=in:d=0.03,afade=t=out:st=8.75:d=0.15" vo2-fix.wav`
  - `ffmpeg -ss 1.7 -t 6.7 -i vo3.wav -af "afade=t=in:d=0.03,afade=t=out:st=6.55:d=0.15" vo3-fix.wav`

Then `npx tsx app/demo/live-cut.ts cut <dir>/edit-v5.json <out>.mp4` (about 10 min).
