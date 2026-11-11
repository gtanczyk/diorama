// What the agent publishes for the person to look at (a report, a chart, a picture): genaicode's artifact
// store, one per world, with a copy on disk so a card in the conversation still opens after a restart.
import fs from 'node:fs';
import path from 'node:path';
import { artifactResponse, createArtifactStore, type Artifact, type ArtifactResponse, type ArtifactStore } from 'genaicode/agents';

const ID = /^[0-9a-f]{32}$/;

export class WorldArtifacts {
  readonly store: ArtifactStore;

  /** `dir`: the world's folder; before it exists the agent works in `root`, and nothing is kept on disk. */
  constructor(private readonly dir: string, root: string) {
    this.store = createArtifactStore({ cwd: () => (fs.existsSync(dir) ? dir : root) });
    this.store.subscribe((artifact) => this.keep(artifact));
  }

  private folder = () => path.join(this.dir, 'studio', 'artifacts');

  private keep(artifact: Artifact) {
    const body = this.store.read(artifact.id)?.body;
    if (!body || !fs.existsSync(this.dir)) return;
    try {
      fs.mkdirSync(this.folder(), { recursive: true });
      fs.writeFileSync(path.join(this.folder(), `${artifact.id}.bin`), body);
      fs.writeFileSync(path.join(this.folder(), `${artifact.id}.json`), JSON.stringify(artifact));
    } catch {
      // Without the copy the card works until the Studio restarts.
    }
  }

  /** The HTTP answer for an artifact, with genaicode's headers that keep the page in a sandbox of its own. */
  response(id: string, range?: string): ArtifactResponse | undefined {
    if (!ID.test(id)) return undefined;
    const live = this.store.read(id);
    if (live) return artifactResponse(live.artifact, live.body, { range });
    try {
      const artifact = JSON.parse(fs.readFileSync(path.join(this.folder(), `${id}.json`), 'utf8')) as Artifact;
      const kind = (['html', 'image', 'audio', 'video', 'text', 'file'] as const).find((k) => k === artifact.kind);
      if (!kind || typeof artifact.mimeType !== 'string' || typeof artifact.title !== 'string') return undefined;
      // Whatever the file on disk claims, the answer is sandboxed by its kind's policy.
      return artifactResponse({ ...artifact, id, kind }, fs.readFileSync(path.join(this.folder(), `${id}.bin`)), { range });
    } catch {
      return undefined;
    }
  }
}
