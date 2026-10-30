# Speaking-face review

The initial conductor prototype has become a reusable speaking-face pipeline. See [docs/characters.md](../../../docs/characters.md#speaking-faces) for the architecture and limitations.

```sh
node app/bin/diorama.mjs faces last-tram-2
node app/bin/diorama.mjs play last-tram-2 --port 4177
```

Open <http://localhost:4177/prototype/conductor-lipsync>. Select any of the four characters; compare Image, 2D rig, Sprites and Model 3D; play one or all of their Polish lines; toggle facial animation and close-up. These are the actual game renderers, using the existing world, body art and voice recordings. The review camera disables optional rim/separation filters to keep the enlarged view smooth. Model 3D shows the calibrated animated paint on the actual mesh and offers rotation through front, three-quarter and profile views. Models with authored facial morphs retain that native path. Coverage reports distinguish both methods and missing views.

`faces_prepare` and `faces_status` expose preparation and coverage through Studio. The normal build includes the faces step. Source hashes prevent applying old patches/timelines after art/audio changes. Cached runs repaint nothing. The legacy `prepare.mjs` now forwards to the reusable pipeline; it contains no hand-entered face coordinates.

`face-atlas.png` and `image-prompt.txt` retain the original, manually registered prototype asset generated with built-in imagegen. The new pipeline uses the project's configured vision and image providers to prepare each character automatically. Generated world assets are stored under its ignored `cast/<key>/face*.png`, `face.json` and `sound/lipsync.json`; keep the world in this worktree or regenerate them with the command above. Original cast images, body rigs, sprite sheets and MP3s are retained.

The reviewed prototype reuses the earlier natural mouth artwork rather than the rejected inflated lips. Lip corners in the source art and each mouth frame are registered separately, preserving the original jaw/beard silhouette; rest and closed-lip states retain closed source pixels. Originally open talk gestures use a narrowly masked neutral underlay. Generated mouth registrations still require close-up review.

Tests cover source-specific cache invalidation, rejected/static atlases, cropped/padded rig registration, actual rendered mouth pixels for images/baked rigs/part rigs, playback interruption/mute/pause/completion, recording caches, export of face assets and speaker-specific audio, and native 3D morph deformation. These checks complement visual review in the game; they do not establish the precision of Polish phonetics or acting quality.

The completed `last-tram-2` review covers Wacek, Róża, Antek and Janek: 35 synchronized recordings, 17 registered talk poses and 12 projected 3D face views. Róża's right model view uses `right-character.png`, derived from the original view with the separate flower stand removed; its fit is recomputed against the same mesh. The original view is retained. Close-up contact sheets, gameplay captures, coverage and playback reports are kept under the ignored `exports/speaking-faces-complete/` directory.
