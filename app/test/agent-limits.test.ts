import { expect, test } from 'vitest';
import { agentBudget, limitText } from '../src/studio/agent.ts';

test('agentBudget: caps from the environment, nothing when unset or not a positive number', () => {
  expect(agentBudget({})).toBeUndefined();
  expect(agentBudget({ DIORAMA_AGENT_MAX_COST: '0', DIORAMA_AGENT_MAX_TOKENS: 'lots' })).toBeUndefined();
  expect(agentBudget({ DIORAMA_AGENT_MAX_COST: '2.5' })).toEqual({ maxCostUsd: 2.5 });
  expect(agentBudget({ DIORAMA_AGENT_MAX_COST: '1', DIORAMA_AGENT_MAX_TOKENS: '200000.7' })).toEqual({ maxCostUsd: 1, maxTokens: 200000 });
});

test('limitText: says nothing while a limit is fine, else how near it is and its name', () => {
  expect(limitText({ window: '5h', status: 'ok', usedPercent: 40 })).toBeNull();
  expect(limitText({ window: '5h', status: 'warning', usedPercent: 84.4 })).toBe('5h limit nearly used up (84% used)');
  expect(limitText({ window: '7d', status: 'exceeded', name: 'Opus' })).toBe('Opus 7d limit reached');
  expect(limitText({ window: 'quota', status: 'exceeded', resetsAt: Date.UTC(2026, 10, 8) })).toMatch(/^quota limit reached, resets /);
});
