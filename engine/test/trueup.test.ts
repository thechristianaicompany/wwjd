import { describe, expect, it } from 'vitest';
import fixture from './fixtures/smoke.json' with { type: 'json' };
import { createReplayClient, decide, ENGINE_VERSION, estimateTokens } from '../src/index.ts';
import type { ReplayEntry } from '../src/replay.ts';
import type { DecideInput, DecisionsClient } from '../src/types.ts';

function syntheticUsageClient(): DecisionsClient {
  const replay = createReplayClient(fixture.cases[0]!.recordings as ReplayEntry[]);
  return {
    async create(body, options) {
      const response = await replay.create(body, options);
      if (options?.stage !== 'stage_b') return response;
      // Simulate upstream usage for all sent input and judge questions, independently
      // of the engine's est_non_caller_tokens value used by the billing true-up.
      const input_tokens = estimateTokens(String(body.input) + JSON.stringify(body.questions));
      return { ...response, usage: { input_tokens }, calls: [{ input_tokens, status: 200 }], attempts: 1 };
    },
  };
}

function contextInput(tokens: number, action = 'Review the supplied text.'): DecideInput {
  return { action, context: 'x'.repeat(tokens * 4 - action.length) };
}

describe('Stage B caller-token true-up', () => {
  it.each(fixture.cases)('removes engine overhead from recorded c2 usage: $id', async (entry) => {
    const { trace } = await decide(entry.input, { decisionsClient: createReplayClient(entry.recordings as ReplayEntry[]) });
    const callerTokens = trace.stage_b.usage.input_tokens - trace.stage_b.est_non_caller_tokens;
    const callerEstimate = estimateTokens(entry.input.action);
    expect(Math.abs(callerTokens - callerEstimate)).toBeLessThanOrEqual(1_000);
  });

  it.each([
    { name: '90K caller remains in the one-credit tier', input: contextInput(90_000), expected: 90_000, extraCredits: false },
    { name: 'exactly100K caller with a repeated 2K action is charged only once', input: contextInput(100_000, 'a'.repeat(8_000)), expected: 100_000, extraCredits: false },
    { name: '101K caller exceeds the true-up threshold', input: contextInput(101_000), expected: 101_000, extraCredits: true },
    { name: '101K unrepeated action is not deducted as engine overhead', input: { action: 'a'.repeat(404_000) }, expected: 101_000, extraCredits: true },
  ])('$name', async ({ input, expected, extraCredits }) => {
    const { trace, decision } = await decide(input, { decisionsClient: syntheticUsageClient() });
    const callerTokens = trace.stage_b.usage.input_tokens - trace.stage_b.est_non_caller_tokens;
    expect(decision.basis.truncated).toBe(false);
    expect(Math.abs(callerTokens - expected)).toBeLessThanOrEqual(1);
    expect(callerTokens > 100_000).toBe(extraCredits);
  });

  it('returns the exported patched engine version', async () => {
    const entry = fixture.cases[0]!;
    const { decision } = await decide(entry.input, { decisionsClient: createReplayClient(entry.recordings as ReplayEntry[]) });
    expect(ENGINE_VERSION).toBe('1.0.1');
    expect(decision.engine_version).toBe(ENGINE_VERSION);
  });
});
