import { describe, expect, it } from 'vitest';
import fixture from './fixtures/smoke.json' with { type: 'json' };
import { createReplayClient, decide } from '../src/index.ts';
import type { ReplayEntry } from '../src/replay.ts';

describe('recorded live Decisions responses (no network)', () => {
  it.each(fixture.cases)('$id matches its expected verdict with an honest refusal flag', async (entry) => {
    const client = createReplayClient(entry.recordings as ReplayEntry[]);
    const { decision } = await decide(entry.input, { decisionsClient: client });
    expect(decision.verdict).toBe(entry.expected);
    expect(decision.refused).toBe(entry.refused);
    expect(decision.reason).toBe(entry.reason);
    expect(client.remaining).toBe(0);
    if (entry.id === 'spike_1') {
      expect(decision.guards.ten_commandments.find((guard) => guard.id === 'steal')?.probability).toBeGreaterThanOrEqual(.8);
      expect(decision.guards.ten_commandments.find((guard) => guard.id === 'covet')?.probability ?? 0).toBeLessThan(.5);
    }
    if (entry.id === 'spike_7') expect(decision.guards.triggered).not.toContain('murder');
    if (entry.id === 'stop') expect(decision.guards.ten_commandments.find((guard) => guard.id === 'honor_parents')?.probability).toBeGreaterThanOrEqual(.8);
    if (entry.id === 'spike_10') expect(decision.guards.ten_commandments.find((guard) => guard.id === 'honor_parents')?.probability ?? 0).toBeLessThan(.2);
    if (entry.id === 'refugee') expect(decision.guards.triggered).toContain('false_witness');
    for (const commandment of decision.guards.ten_commandments) expect(commandment).not.toHaveProperty('n');
  });
});
