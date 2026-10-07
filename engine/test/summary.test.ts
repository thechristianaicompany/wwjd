import { describe, expect, it } from 'vitest';
import fixture from './fixtures/smoke.json' with { type: 'json' };
import { createReplayClient, decide } from '../src/index.ts';
import type { ReplayEntry } from '../src/replay.ts';

async function recordedDecision(id: string) {
  const entry = fixture.cases.find((item) => item.id === id)!;
  return (await decide(entry.input, { decisionsClient: createReplayClient(entry.recordings as ReplayEntry[]) })).decision;
}

describe('triggered commandment in the visible summary', () => {
  it.each(['spike_3', 'refugee'])('names the top triggered commandment even when another concern sets the reason: %s', async (id) => {
    const decision = await recordedDecision(id);
    expect(['great_commandment_concern', 'dilemma']).toContain(decision.reason);
    const guard = decision.guards.ten_commandments.find((item) => decision.guards.triggered.includes(item.id))!;
    expect(guard).toBeDefined();
    expect(decision.summary).toContain(`Commandment concern: ${guard.commandment.replace(/\.$/, '')} (${guard.ref}).`);
    expect(decision.summary.match(/Commandment concern:/g)).toHaveLength(1);
  });

  it.each(['spike_6', 'spike_8'])('preserves the dedicated refusal or manipulation summary: %s', async (id) => {
    const decision = await recordedDecision(id);
    expect(['refused', 'manipulation_suspected']).toContain(decision.reason);
    expect(decision.guards.triggered.length).toBeGreaterThan(0);
    expect(decision.summary).not.toContain('Commandment concern:');
  });

  it('does not repeat a concern already included by the hard-guard template', async () => {
    const entry = structuredClone(fixture.cases.find((item) => item.id === 'spike_2')!);
    // Construct a contradictory guard answer to exercise the existing override template.
    const guard = entry.recordings[1]!.response.answers.find((answer) => answer.name === 'cmd_steal')!;
    if (guard.type !== 'predicate') throw new Error('Expected recorded predicate');
    guard.probability = .98;
    const { decision } = await decide(entry.input, { decisionsClient: createReplayClient(entry.recordings as ReplayEntry[]) });
    expect(decision.reason).toBe('guard_override');
    expect(decision.summary.match(/Commandment concern:/g)).toHaveLength(1);
  });
});
