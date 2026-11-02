// Talking mouths (the faces step) on or off for this machine. Off by default: they were barely visible in play
// and cost about half of a world's model calls and minutes of build time. DIORAMA_FACES=on|off overrides Setup.
import fs from 'node:fs';
import path from 'node:path';
import { configDir } from '../secrets.ts';

const file = () => path.join(configDir(), 'faces.json');
const env = () => process.env.DIORAMA_FACES;

export function facesState(): { enabled: boolean; env: string | null } {
  const set = env();
  if (set !== undefined) return { enabled: /^(1|on|yes|true)$/i.test(set), env: set };
  try { return { enabled: (JSON.parse(fs.readFileSync(file(), 'utf8')) as { enabled?: boolean }).enabled === true, env: null }; }
  catch { return { enabled: false, env: null }; }
}

export function writeFacesSettings(enabled: boolean) {
  fs.mkdirSync(path.dirname(file()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file(), `${JSON.stringify({ enabled }, null, 2)}\n`, { mode: 0o600 });
}
