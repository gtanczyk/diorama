import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from 'vitest';
import { earlier } from '../src/studio/agent.ts';

test('a fresh agent session is pointed at the conversation so far, and only when there is one', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diorama-convo-'));
  try {
    expect(earlier(dir)).toBe('');
    fs.mkdirSync(path.join(dir, 'studio'));
    fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), '');
    expect(earlier(dir)).toBe('');
    fs.writeFileSync(path.join(dir, 'studio', 'conversation.md'), '## 2026-10-28 09:00 · muse\n\n**Person:** the hero walks into the table\n');
    expect(earlier(dir)).toContain('studio/conversation.md');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
