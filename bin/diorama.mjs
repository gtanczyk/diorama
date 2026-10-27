#!/usr/bin/env node
// Loads the TypeScript sources through tsx, so the CLI runs straight from a git checkout.
import { register } from 'tsx/esm/api';

// Node 22 brings fetch-era globals the CLI relies on (WebSocket for Muse Voice Transcribe); older Node fails late and oddly.
const major = Number(process.versions.node.split('.')[0]);
if (major < 22) {
  console.error(`diorama needs Node 22 or newer, this is ${process.version} (nvm install 22 && nvm alias default 22)`);
  process.exit(1);
}

register();
await import('../src/main.ts');
