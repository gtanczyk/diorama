import { expect, test } from 'vitest';
import { agentModel } from '../src/studio/agent.ts';

test('agentModel: own variable first, then the shared one, else the agent default', () => {
  expect(agentModel('antigravity', { DIORAMA_AGY_MODEL: 'gemini-4-argon-high', DIORAMA_AGENT_MODEL: 'x' })).toBe('gemini-4-argon-high');
  expect(agentModel('codex', { DIORAMA_AGY_MODEL: 'gemini-4-argon-high', DIORAMA_AGENT_MODEL: 'x' })).toBe('x');
  expect(agentModel('muse', { DIORAMA_AGY_MODEL: 'gemini-4-argon-high' })).toBeUndefined();
  expect(agentModel('antigravity', { DIORAMA_AGY_MODEL: ' ' })).toBeUndefined();
});
