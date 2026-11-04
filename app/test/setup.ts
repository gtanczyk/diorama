import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Tests never see the developer's own Diorama settings: ~/.config/diorama/studio.json can name a real coding
// agent (Claude Code, Codex), and the Studio would then talk to it instead of the fake Muse the tests start.
// Each test file gets its own empty config dir; a test that needs a specific one still sets its own.
process.env.DIORAMA_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-config-'));
delete process.env.DIORAMA_AGENT;
