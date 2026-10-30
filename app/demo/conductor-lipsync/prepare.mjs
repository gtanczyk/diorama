// Compatibility entry point for the original demo. Preparation now uses the reusable pipeline.
import path from 'node:path';
import { register } from 'tsx/esm/api';
register();
const { loadSecrets } = await import('../../src/secrets.ts');
const { WorldFiles } = await import('../../src/world/files.ts');
const { prepareFace } = await import('../../src/scene/faces.ts');
const { prepareLipSync } = await import('../../src/sound/lipsync-make.ts');
await loadSecrets();
const world = path.resolve(process.argv[2] ?? 'worlds/last-tram-2');
const files = new WorldFiles(path.basename(world), path.dirname(world));
await prepareFace(files, 'conductor');
await prepareLipSync(files, ['conductor'], process.argv[3]);
