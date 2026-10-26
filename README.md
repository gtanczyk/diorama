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
export META_API_KEY=...        # or META_MUSE_API_KEY / META_MODEL_API_KEY
npx -y github:gtanczyk/diorama help
npx -y github:gtanczyk/diorama doctor   # one live call to each model
```

Model answers are kept by a hash of their inputs under each world's memo folder, so rerunning a step with the same inputs is free.

## Status

Work in progress; see the commit log.

## License

Apache-2.0
