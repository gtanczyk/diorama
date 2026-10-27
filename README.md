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

## Studio

`diorama studio [slug]` opens the GUI: describe a world and watch it build, place by place, with every step, model call and verify finding live. It listens on 127.0.0.1 only and opens through the one-time link it prints. Everything it does is an action, also runnable as `diorama action <name> '<json>'` (`diorama action` lists them), so a terminal, the page and the Muse Code agent drive the same things. The terminal running the Studio prints what runs (`--verbose` for every job line, `--quiet` for none).

The Workshop has three tabs and a game:

- **Places**: pick a place and fix it with the tools on its picture. **Box** shows SAM where a thing really is; the table under it gives a thing a better name to search for or another kind (standing, wall, on-top, walk-on, flat). **Brush** paints onto or rubs out of a mask. **Stand** sets where the hero stands to use a thing. **Move NPC** puts a character somewhere else (no repaint: NPCs are drawn by the game). **Repaint** has Muse redo one region. **Note** leaves a note on a spot for you or the agent ("Hand it to Muse Code").
- **Story**: the places, exits, locks and endings as a map, with the checker's verdict and the clicks to each ending. Pick a place to reword what is said there. To change what happens, ask the agent: it rewrites the story to your wish and the checker plays it through.
- **Cast**: a card per character (hero, NPCs, narrator). Rewrite how one looks and Repaint, or ask for Another take; pick another voice and only that character's lines are spoken again.
- **Play** runs the game beside them, from the start or from a place, with the player's moves in Activity. When the world changes it offers a reload, and the agent reloads it itself. **Bot playthrough** plays every route to an ending.

Every fix is kept in a file next to what it fixes and applied again by every later build, so a rebuild never loses it: `places/<place>/corrections.json` (rebuilding only that place from the step it feeds), `story-fixes.json`, `cast/fixes.json`. A small repaint rebuilds only what it reaches (`src/scene/carry.ts`): each place step keeps the painting it last ran on (`places/<place>/.ran/`), compares the new one with it tile by tile, and asks again only about what the changed tiles reach (a thing's or floor's mask, a plate, the backdrop's cards, the light, the stairs); everything else is asked about the old painting, which the memo answers for nothing, and the place keeps its scale. Lighting the lanterns of a harbour takes about 100 s instead of 270 s, and a rebuild on the same painting asks nothing new. A change over a third of the painting rebuilds everything. A place whose steps have not kept their painting (built before this, or put back by an Undo) takes the painting on disk as theirs before a repaint, so that repaint carries too. Undo puts the world back as it was before the last job, the agent's included; a locked world or place is left alone by the agent.

The agent panel is genaicode's chat with Muse Code (default), Claude Code or Codex, picked in its header. The agent works through the same actions as the page, so its steps show live and its changes survive rebuilds; when a build leaves places unplayable it is woken to repair them, three tries a place. Every conversation is recorded in `studio/sessions/`: open one from "Recorded sessions", or `/w/<slug>?replay=<file>&speed=2`, to play it back for a film.

**Setup** shows what this machine still needs, which agents it found, and the model calls sent across all worlds, priced once you enter the per-call prices from your billing pages. Keys are only ever typed in the terminal (`diorama setup`).

### A game from children's drawings

On the Start screen, **Drawings and voices** makes a world from what children drew and said, for a workshop:

1. **Drawings**: add photos of the drawings (files, dropped, or **Use the camera** and hold each drawing up to it). Each one is kept in `drawings/`, upright and evened out.
2. **The story, told**: press **Record**, let a child tell their piece, press again. Each clip is kept in `told/` and heard at once by Muse Voice Transcribe (`told/<clip>.txt`, in any language it hears; long clips are cut at pauses).
3. **Write the story**: Spark reads every drawing (hero, character, item to pick up, thing in a place, or place; change any with its menu, say who the hero is) and joins what the children said into a short story in their language. Edit it, then **Build their game**.

The world keeps every drawing under its key (`drawings.json`): characters are painted from their drawing (`cast`), places and the things drawn in them follow theirs (`paint`), and the style is their crayons come alive. A world with drawings or recordings is for kids (`audience: kids` in world.json): the story is gentle and simple, every line is voiced since the players cannot read, and the text is in the language they spoke (`language`). From a terminal: `diorama build <slug> --drawings photos/ --told recordings/ --places 3`, with no idea, or an idea of your own instead of the recordings.

## Sound

`diorama sound <slug>` (also a build step) has Spark plan what the world sounds like from its places, the brief of each painting and the story: a music bed, the ambience of every place, loops on things that sound (a lantern flame, a flag in the wind, a lamp that only roars once the story lights it), the surface of every floor, and one-shots for taking, using, exits, talking and the ending. The plan is `sound.json`; edit it and run the step again to regenerate only what changed.

The Meta Model API has no audio model, so effects come from ElevenLabs (`ELEVENLABS_API_KEY`) and music from Meta's open-weights MusicGen run on your machine (`DIORAMA_PYTHON=/path/to/python` with `torch transformers scipy`; without it, or with `--music eleven`, ElevenLabs makes the music). Code checks every take: a loop that came back as one event is asked for again, loops are crossfaded into themselves so they never click, footstep takes are cut into single steps, and everything is levelled. Needs `ffmpeg`. Without a key the world plays silent.

`diorama voices <slug>` (also a build step) speaks the conversations, the intro and the endings (`--all` also voices the hero's remarks on things; by default those stay in the bubble so the game does not talk at every click). Spark looks at each figure and says who speaks (gender, age, how they sound). Adults get the fitting stock ElevenLabs voice; children, teens and the old get a voice made for them by **ElevenLabs Voice Design**, since no stock voice is a child or truly old (`voices.json`; a designed voice is created on the account only while its lines are read and deleted after, so a world needs one free voice slot; Studio's Cast card or `voice_set` recasts), ElevenLabs reads each line, and **Muse Voice Transcribe** listens to every take: a take that does not say its line is read again, up to three times, and flagged if it still does not.

**What sound costs.** ElevenLabs bills every effect, line and voice design, so `sound` and `voices` run in *draft* quality by default: speech with Flash v2.5 (half the credits), 2 takes per line, beds 10 s and loops 6 s, and footsteps plus UI one-shots (take, click, talk, ending) reused across worlds from a library. `--final` (or `DIORAMA_SOUND=final`) gives the best speech model, 3 takes and full lengths, for the film. Every paid answer is also kept in `~/.cache/diorama` (`DIORAMA_CACHE`) for all worlds; a rebuild keeps each sound whose prompt did not change; designed voices are kept and reused by gender and age in later worlds; casting also uses the English voices already on the account. Each run prints the credits it used, refuses to start below `DIORAMA_ELEVEN_FLOOR` (2000) credits, and stops at once when the account runs dry.

In the page, loops pan and fade with where the hero stands, footsteps follow the floor under him, and `m` mutes. `diorama playthrough --video` records the page's sound too and writes an mp4.

## Checking a world

`diorama build` ends with `verify`, which writes `verify.json` per place and prints which places are playable and what was flagged on the way. Places are built side by side and independently: a place whose step breaks is set aside with why, and the others go on to the end, characters and sound included. The report gives each error its playbook (`src/scene/playbook.ts`): where to look, the fix tools to try in order, and the costly last resort (a camera too close, `SCALE_NEAR` or a floor cut off once derive shut the front rows for it, is rerun derive first, then relayout and repaint); `place_status` hands the same to the Studio agent, which repairs one place at a time with the fix tools. The `masks` step also checks that each mask holds its thing: one Spark look per place at the painting with every mask box numbered (`src/scene/maskcheck.ts`), since a box and its mask can agree and both sit on the neighbour. When Spark points to where the thing really is, that is `MASK_WRONG` in verify (an error for items and exits); a doubt without such a box, or on a prop, is the flag `MASK_DOUBT`. Spark is asked to judge the kind of thing, not its details, and a box someone fixed is taken as given. Before anyone is asked, the build makes the cheap fixes itself (`src/scene/autofix.ts`): a gap of up to three 60 px cells with nothing solid in it, or up to six along stairs or a gangway (a walk-on thing) whose mask reaches both floors, is bridged with a floor brush stroke (two passes, as one bridge can bring the next patch within reach; stairs that lead somewhere else, with water between the floors, bridge nothing: that place needs a floor in the layout or a repaint, so it goes to the agent), a stand spot off the floor moves to the nearest reachable point (both without a model call), and a `MASK_WRONG` thing gets the box Spark saw it in (one SAM call). They are ordinary corrections, so `corrections_get` lists them and `corrections_clear` takes them back; `build.json` keeps them under `repairs`, and `--repair off` skips them. What the free fixes leave, the Studio hands to the agent at once: a build that ends with places unplayable wakes it with the places and their errors (`budget_set autoRepair:false` turns that off). It repairs with the fix tools in the playbook's order; after three fixes of a place in a row that leave it unplayable the fix tools refuse it and it tells you what it tried, which is your turn. `place_view` is how the agent looks, as a picture it sees (layer `walk`, `masks` or `painting`, all on the 60 px grid), so it has no need to dig through files; after three shell calls in a turn it is reminded of that once. Layer `masks` tints each thing's mask against the box it should be in and flags a mask that cut out a neighbour. Layer `walk` shows why a place cannot be walked: reached floor green, unreached red, each gap as a dashed line naming the 60 px cells to bridge (the ones `floor_cells` takes) and the things in it, and stand spots off the floor (`places/<place>/diagnose.png`; the agent gets it as an image). Every step also leaves a picture to look at: `masks/overlay.png` (what SAM found) and `walk.png` (where the hero can walk, footprints, floor lines and his size at a few depths).

`diorama explore <slug>` puts the hero on every part of each floor in the real play page and checks each frame; it needs Playwright with Chromium (`npm i -D playwright && npx playwright install chromium`). `--fix` closes the floor where he looked wrong.

## Characters

`build` also makes the characters, after the places (steps `cast`, `model`, `sprites`; each also runs alone):

- `diorama cast <slug>` paints the hero and every NPC (cast/<key>.png) and cuts each into parts with SAM for a 2D walk rig (cast/<key>/rig.json). Spark also says how tall each one stands and whether upright like a person (cast/figures.json, a grown-up 1.62 m): a cat or a child is drawn at its own size, and an animal gets no rig, model or sprites; it stays its painted figure and breathes when still.
- `diorama model <slug>` gives each character who needs sprites a rigged 3D model: Muse paints them from four sides, TRELLIS turns the views into a mesh and Make-It-Animatable adds a skeleton (both open Hugging Face Spaces; set `HUGGING_FACE_API_KEY` or `HF_TOKEN`, as they run on your account's GPU quota). The model only supplies poses.
- `diorama sprites <slug>` draws their walk and talk sheets (cast/<key>/sprites/): the model walks or gestures in a sheet of 8 frames, Muse draws the sheet again in the world's style, and each frame is cut out and lined up with its pose. A sheet that Muse handed back barely changed is drawn again over a different guide. Only what the story uses is drawn: the walk facings the hero's routes need, one talk sheet per speaker in the facing of their conversation, and the gesture Spark picks for each line (`--plan` prints the plan without drawing). Rendering the guides needs Playwright's Chromium (`npx playwright install chromium`).

The page draws the best a character has: sprite sheets, else the 3D model (`?model=1` prefers it), else the 2D rig, else the plain cut-out.

## Inventory icons

`diorama icons <slug> [item...]` (a build step, after `plates`) makes `items/<key>.png` for each item in `story.json`, and nothing for anything else. An item the hero picks up in a place is cut out of that place's painting with the thing's SAM mask, so it costs no model call and looks exactly like what the player saw lying there. One that is too small there to blow up (under 56 px) is redrawn larger by Muse from the cut-out; one that only a person hands over is painted by Muse in the world's style, then cut out by SAM (or, when SAM finds nothing, as what stands out from Muse's plain ground; the shaded wash it stands on is peeled off the edge). `items/items.json` says how each was made. To change one, use the Studio's Cast tab or the agent: `icon_redo` takes a hint in your words, `cut` or `paint`, or another take, and keeps it in `items/fixes.json` for every later build (`icon_fix_clear` takes it back; `icons_status` lists them all).

## Depth: parallax and moving water

`diorama backdrop <slug>` (a build step, after `derive`) turns each place into a little stage, so it moves like a real diorama:

- **Backdrop and cards.** One Muse edit paints the place without its standing things; only their masks are taken from it, and SAM checks each thing is really gone (a leftover gets a smeared fill). The things become cut-out cards. In the page the floor shears with the camera, each card slides with the floor row it stands on, and the upright band behind the walkable floor (a quay wall, a railing) slides as one piece so it does not lean. The hero slides with the floor under his feet and still hides behind cards.
- **Far flats.** Spark names the bands of scenery above the horizon, farthest first (hills, a town, a castle); SAM cuts each one from the backdrop into `layers/<n>.png`, over a sky with the flats filled in (`layers/sky.png`). Each flat slides a little more than the one behind it.
- **Water.** SAM finds water on the backdrop (minus the floors and cards, which come out wet otherwise) into `layers/water.jpg` and `layers/water-mask.png`. Spark reads which way it runs on screen, along the channel and into the depth too; that is `water.flow` in `layers.json`, a unit vector downstream, `[0, 0]` for still water like a harbour basin or the sea, which the page sways in slow swells instead of running. If Spark got the river backwards, tell the Studio agent ("the canal flows toward the bridge"): its `water_flow` action keeps `reverse`, `still` or a hint in words in `places/<key>/depth.json`, which every later build follows.
- **Painted fog.** SAM finds fog, mist or haze painted on the backdrop (minus the cards; skipped when it is more than half the frame, which is the weather's mist) (when SAM sees no fog, which is often, Spark boxes the fog bands and the fog in them is read from the pixels: pale and greyed) into `layers/mist.png`, a veil of the fog's own colour shaped like its denser and lighter patches, and `layers/mist-mask.png`, where it may show. The page slides two copies of the veil sideways with the wind, cross-fading half a cycle apart, so wisps roll across the land while the land itself stays put; over walkable floors the veil is thin. To change it, tell the Studio agent ("the fog should drift left", "slower", "leave the fog still"): its `fog_drift` action keeps `fog` (auto, left, right, still) and `fogSpeed` in `places/<key>/depth.json` and reruns the backdrop step.

`--smear` skips Muse and smears the gaps instead. Places with a `photo.png` stay flat.

- **Separation.** Each person throws a soft shade on what stands just behind them: their silhouette blurred and pushed a little away from the light, only on pixels the depth map (from `derive`; without one, the floor plane with each card on its floor row) puts a short way past their feet. So a hero passing a painted plinth reads as standing in front of it, not pasted on it. `?separate=0` turns it off, `?separate=1.5` darker.
- **Rim light.** Each person gets a thin warm edge on the side the light comes from (against the way shadows fall; from the sky up and left without a measured light), as illustrators separate a figure from a busy background. `?rim=0` off, `?rim=1.5` wider.
- **Focus** (off by default). `?focus=1` softens and pales what is behind the hero with its depth, like a close-up camera. It only separates far things, so it stays opt-in.

## Weather: rain, snow and drips

`diorama weather <slug>` (a build step, after `backdrop`) reads what falls on each place and where water drips, into `places/<key>/weather.json`; the page animates it all, so nothing in the painting is a frozen streak:

- **Fall.** Spark looks at the painting and the place's mood: `rain`, `snow` or `none` (indoors, a cave, wet ground after the rain), how hard (0.3 drizzle, 1 a downpour) and how much the wind slants it. The page drops rain or snow over the whole frame in three depths; each drop ends on the floor row as far away as it is.
- **Rings and splashes.** SAM finds the water and the puddles (`weather/ripples.png`, minus the floors and cards SAM takes for water). Drops that land there ring; drops that land on a walkable floor splash; on a roof or the sky nothing shows.
- **Drips.** Spark names up to four edges that drip (eaves, a gutter, an awning, a pipe, a cave ceiling), SAM finds each, and its lowest edge is where drops swell and let go. Each falls under gravity, at the scale of the place, to the floor row under it (the depth map, else the first walkable cell below) and splashes or rings there. A dry place can still drip.
- **Painting.** When a place's words say rain or snow, the paint step asks Muse for the weather's marks only (wet sheen, puddles, snow lying), no streaks in the air.

To change it, tell the Studio agent ("no rain in the hut", "it should pour", "water drips from the tavern sign"): its `weather_set` action keeps `fall`, `strength`, `fog` (mist drifting across the place, 0..1, which Spark also reads from the picture and the mood) and a hint in words in `places/<key>/weather-wish.json`, which every later build follows. `?weather=0` in the play page keeps every place dry.

## In the play page

- **Walking:** `derive` joins the floors up, but never across painted water (SAM finds it only when a join would cross it), and the game starts on the biggest stretch of floor. The hero routes over the walk grid; the walk phase follows the distance walked, so feet don't slide. Things in front of a person (per-column floor lines from `derive`) are drawn back over them.
- **Stairs:** `derive` asks SAM for the steps of any floor or walk-on thing named as stairs (stair, step, schody) and keeps each step's band per column (`steps` in geometry.json). A person on them keeps their size from where they stand, but their feet sit on the tread under them and climb only over each riser; a walk never ends on a riser. Fewer than two clear steps keep the stairs a ramp.
- **Light and shadow:** `derive` measures the painting's light from the shadows things cast (`light` in geometry.json) and masks those shadows (`masks/shadows.png`). A person then casts a matching soft shadow and darkens inside a painted one. A shadow many times its thing's size (stair risers, a tree's shade) is not measured. When Spark sees sun but no thing's own shadow can be measured, the light comes from Spark and nothing is masked. A place with no sun (fog, overcast) gets neither. Each person has one shadow: under measured light the cast shadow replaces the soft blob at the feet (only a thin contact under the soles stays); in shade, fog or without light the blob is the shadow.
- **Shadows on the ground's shape:** `derive` also writes `depth.png` (`depth` in geometry.json): Depth Anything V2 Small (ONNX on the CPU, about a second per place; the 27 MB model is fetched once into `.diorama/models/`) gives relative depth, and a robust line through the walk cells pins it to the floor the scale already knows, as the floor row at the same distance. The runtime turns each ground pixel into a 3D point and asks whether the person stands between it and the sun (`src/play/shadow.ts`), so a shadow breaks over steps, climbs a wall and drops off a quay. It skips what the painting already shades and fades to almost nothing on water. When the depth fits less than 35% of the walk cells (or the model can't run) there is no `depth.png`, the place is flagged `depth: ...`, and shadows lie flat as before.
- **Fires and lamps:** where the layout has lights, `derive` asks Spark whether one of them (not the sky) lights the ground, and whether it is a living flame; it is stored as `light.at` (and `light.flame`). Each person's shadow then runs straight away from it, fading a few heights away. With the depth map the painted things cast shadows from it too (a bench toward the viewer, a tent away from the fire): each floor point looks back along its ray to the light and is shaded where the ray passes behind a thing. A person's shadow that reaches a thing standing behind them (a tent wall) lies on it. A flame flickers: it sways about 10 cm and its light breathes, so every shadow wavers with it, its bright pixels dance, a warm glow pulses round it and a few sparks rise.
- **Inventory:** the items the hero carries sit in a paper bag at the bottom, each as its painted icon (step `icons`, below). Click one to take it in hand: it becomes the cursor, with "Use X on Y" over a thing; right click or Esc puts it back. Tried where it does not help, the hero says the item's own line (`nope` in story.json, written with the story). A picked-up item flies from where it lay in the painting into its slot, and the painting shows the spot empty (the `plates` step: Muse removes the thing, and only its mask, grown by any part Muse removed with it that SAM left out, such as a rope tied to it, is patched in, matched in tone; of several takes the one with the least seam and no stain is kept, and `plates.json` gives both).
- **Touch and keyboard:** on a phone or tablet a tap walks or uses, a tap on a slot takes the item in hand and another puts it back, and a long press looks at a thing (or puts the item back). WASD or the arrows walk the hero and slide along whatever is in the way; the nearest thing in reach lights up and E, Space or Enter uses it; 1 to 9 take an item from the bag.
- **Gamepad:** any pad works without keys or a mouse, so a small child can play. The stick or d-pad walks, A uses the lit thing (in a conversation it picks the lit answer, at the end it plays again), B puts the item in hand back or looks, X, Y and the shoulder buttons go through the bag one item at a time and back to empty hands. The 8BitDo Micro is read as a standard pad in its D-input mode and in the Mac's MFi profile (buttons by face position, the cross from the hat or the first axes), as the gamedev.pl site does. Other pads the browser does not map work roughly: the two lowest buttons use, the rest go through the bag. Several pads all steer the same hero, or with `?pads=turns` they take turns: a badge in the player's colour shows whose turn it is, and the turn passes to the next pad after a conversation ends or after 60 seconds of play (`&turn=90` for more), never in the middle of a line. With `?pads=party` every pad gets its own hero on screen, the hero's figure dressed and edged in the player's colour (clothes recoloured as the page loads; skin and head keep theirs), on a ring and under a number in that colour: each walks on its own, the bag and the story are shared, and whoever uses or looks at something becomes the hero the story follows (only that player answers in a conversation). When each child draws their own hero, mark the drawings "Another hero (one per gamepad)" in the Studio workshop (kind `player`): `cast` paints and rigs each one, and pad 2 plays the first of them, pad 3 the next (in a party each walks as drawn; in turns the hero turns into whoever plays). They join no place and say nothing in the story. A pad press does not unlock sound in every browser; while sound is held back the page asks for one click. In Studio, Play has a Gamepads choice (one hero, take turns, a hero each).
- **Talking:** each line knows who says it; the paper bubble sits over the speaker with their name on a tag, and the speaker plays the line's gesture while the other listens. The hero's answers are numbered cards beside his portrait; keys 1 to 4 pick them too.
- **URL switches:** `place=<key>` start there, `spawn=x,y,left|right` put the hero, `capture=1` fixed 1/60 s steps for recording (flat, no parallax), `parallax=N` parallax strength (`0` flat, default 1 with the mouse), `track=N` a closer camera that pans after the hero, for walks along a place, `sway=1` a slow idle drift for films, `separate=N` the shade a person throws on what is just behind them (`0` off, default 1; off in capture runs unless given), `rim=N` the light edge on each person (`0` off, default 1; off in capture runs unless given), `focus=N` soften what is far behind the hero (default 0), `still` water that does not flow, `grid=1` show the walk grid and occluders, `model=1|0` prefer or skip the 3D figure, `sound=0` silent, `cursor=0` hide the cursor. `window.diorama` drives the page from scripts: `walkTo`, `use`, `act`, `play(steps)`, `wait`, `on(event)`.

## Playing and sharing a world

- `diorama play <slug>` serves it on localhost.
- `diorama publish <slug>` puts it on this repo's GitHub Pages (the `gh-pages` branch, through a worktree under `.diorama/`, so your checkout stays put) and prints a link like `https://gtanczyk.github.io/diorama/<slug>/`. Every published world is listed at `https://gtanczyk.github.io/diorama/`. The first time, turn on Settings > Pages > Deploy from a branch > `gh-pages`. Run it from a fork to publish to your own Pages.
- `diorama export <slug> --zip` writes `exports/<slug>/` and `exports/<slug>.zip`, a static copy any web host serves; the zip uploads to itch.io as an HTML5 game as is.
- In the Studio, **Share** does both: Make a zip (then Download it) and Publish a link (it asks first, since anyone can play it there). The agent has them as `world_export` and `world_publish`.

## Status

Work in progress; see the commit log.

## License

Apache-2.0
