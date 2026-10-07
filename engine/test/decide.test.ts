import { describe, expect, it } from 'vitest';
import * as corpus from '@wwjd/corpus';
import { decide, createReplayClient, createDecisionsClient, EngineError, PROMPT_SETS } from '../src/index.ts';
import { buildJudgeQuestions } from '../src/judge.ts';
import { formatSummary } from '../src/summary.ts';
import { synthesize } from '../src/synthesize.ts';
import type { DecisionReason, DecisionsAnswer, DecisionsResponse } from '../src/types.ts';
const prompts = PROMPT_SETS.p1!;
const routed: DecisionsResponse = { model: 'route-observed', usage: { input_tokens: 101 }, answers: [
  { type: 'choice', name: 'topic', choice: 'honesty', confidence: 1, probabilities: [...corpus.taxonomy.map((entry) => ({ value: entry.id, probability: entry.id === 'honesty' ? 1 : 0 })), { value: 'none', probability: 0 }] },
  { type: 'choice', name: 'teaching', choice: 'good_samaritan', confidence: 1, probabilities: [...corpus.teachings.map((entry) => ({ value: entry.id, probability: entry.id === 'good_samaritan' ? 1 : 0 })), { value: 'none', probability: 0 }] },
] };
function judged(): DecisionsResponse {
  return { model: 'judge-observed', usage: { input_tokens: 202 }, answers: buildJudgeQuestions(prompts, corpus).map((question): DecisionsAnswer => {
    if (question.type === 'predicate') return { type: 'predicate', name: question.name, probability: question.name === 'aligned' ? .99 : .01 };
    if (question.type === 'choice') return { type: 'choice', name: question.name, choice: 'aligned', confidence: .95, probabilities: [{ value: 'aligned', probability: .95 }, { value: 'not_aligned', probability: .01 }, { value: 'discernment_required', probability: .04 }] };
    return { type: 'score', name: question.name, score: 1.97, confidence: .98, probabilities: question.levels.map((level, i) => ({ value: i, label: level.label, probability: [.01, .01, .98][i]! })) };
  }) };
}
const tooLarge = () => new EngineError('input_too_large', undefined, { calls: [{ input_tokens: 0, status: 400 }], attempts: 1 });

describe('decision pipeline (constructed response fixtures)', () => {
  it('returns observed model, complete trace, caller id and per-call usage without commandment ordinals', async () => {
    const client = createReplayClient([routed, judged()]);
    let tick = 1000;
    const result = await decide({ action: '  Help my neighbor.  ' }, { decisionsClient: client, idFactory: () => 'dec_fixed', now: () => tick++, safetyIdentifier: 'a'.repeat(64) });
    expect(result.decision.id).toBe('dec_fixed'); expect(result.decision.model).toBe('judge-observed');
    expect(result.decision.verdict).toBe('aligned');
    expect(result.decision.usage.calls).toEqual([{ stage: 'stage_a', input_tokens: 101 }, { stage: 'stage_b', input_tokens: 202 }]);
    expect(result.decision.usage.input_tokens).toBe(303);
    expect(result.trace.stage_a.model).toBe('route-observed');
    expect(result.trace.stage_b.input).toContain('Help my neighbor.');
    expect(result.trace.stage_b.est_non_caller_tokens).toBeGreaterThan(0);
    expect(result.trace.synthesis.pa).toBe(.99);
    expect(client.requests.every((request) => request.body.safety_identifier === 'a'.repeat(64))).toBe(true);
    expect(JSON.stringify(result.decision.guards)).not.toContain('"n":');
  });
  it('retains upstream retry calls while using successful Stage B usage for billing true-up', async () => {
    const response = judged(); response.calls = [{ input_tokens: 0, status: 503 }, { input_tokens: 202, status: 200 }]; response.attempts = 2;
    const result = await decide({ action: 'Help.' }, { decisionsClient: createReplayClient([routed, response]) });
    expect(result.decision.usage.decisions_calls).toBe(3);
    expect(result.trace.stage_b.attempts).toBe(2);
    expect(result.trace.stage_b.usage.input_tokens).toBe(202);
  });
  it('retries context length once with half context, recording the failed call', async () => {
    const client = createReplayClient([routed, { error: tooLarge() }, judged()]);
    const result = await decide({ action: 'Read this.', context: 'HEAD' + 'x'.repeat(100000) + 'TAIL' }, { decisionsClient: client });
    expect(client.requests).toHaveLength(3);
    expect(String(client.requests[2]!.body.input).length).toBeLessThan(String(client.requests[1]!.body.input).length);
    expect(result.decision.basis.truncated).toBe(true);
    expect(result.trace.stage_b.attempts).toBe(2);
    expect(result.decision.usage.calls.map((entry) => entry.input_tokens)).toEqual([101, 0, 202]);
  });
  it('retries a large-input 504 with reduced context', async () => {
    const error = new EngineError('upstream_error', undefined, { upstreamStatus: 504, calls: [{ input_tokens: 0, status: 504 }], attempts: 1 });
    const client = createReplayClient([routed, { error }, judged()]);
    const result = await decide({ action: 'Review.', context: 'x'.repeat(2400000) }, { decisionsClient: client });
    expect(result.decision.basis.truncated).toBe(true);
    expect(client.requests).toHaveLength(3);
    expect(String(client.requests[2]!.body.input).length).toBeLessThan(String(client.requests[1]!.body.input).length);
  });
  it('allows only one reduced retry even when reduction goes below the large-input threshold', async () => {
    const lengths: number[] = [];
    const client = createDecisionsClient({ apiKey: 'test-only-key', fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (body.questions[0].name === 'topic') return Response.json(routed);
      lengths.push(body.input.length);
      return new Response('gateway failure', { status: 504 });
    } });
    await expect(decide({ action: 'Review.', context: 'x'.repeat(2400000) }, { decisionsClient: client })).rejects.toMatchObject({ code: 'input_too_large' });
    expect(lengths).toHaveLength(2);
    expect(lengths[1]).toBeLessThan(lengths[0]!);
  });
  it('keeps known usage from every failed judge attempt in the error trace', async () => {
    const first = new EngineError('input_too_large', undefined, { calls: [{ input_tokens: 123, status: 400 }], attempts: 1 });
    const second = new EngineError('input_too_large', undefined, { calls: [{ input_tokens: 456, status: 400 }], attempts: 1 });
    const client = createReplayClient([routed, { error: first }, { error: second }]);
    await expect(decide({ action: 'Read.', context: 'x'.repeat(100000) }, { decisionsClient: client })).rejects.toMatchObject({ trace: { stage_b: { usage: { input_tokens: 579 }, attempts: 2 } } });
  });
  it('does not convert a small-input 504 into an input-size error', async () => {
    const error = new EngineError('upstream_error', undefined, { upstreamStatus: 504 });
    const client = createReplayClient([routed, { error }]);
    await expect(decide({ action: 'Read.' }, { decisionsClient: client })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(client.requests).toHaveLength(2);
  });
  it('preserves Stage A and both failed Stage B attempts after exhausted context retry', async () => {
    const client = createReplayClient([routed, { error: tooLarge() }, { error: tooLarge() }]);
    await expect(decide({ action: 'Read.', context: 'x'.repeat(100000) }, { decisionsClient: client })).rejects.toMatchObject({ code: 'input_too_large', trace: { stage_a: { usage: { input_tokens: 101 } }, stage_b: { attempts: 2 } } });
  });
  it('carries partial trace on any mid-run error without echoing unknown error text', async () => {
    let calls = 0;
    const client = { async create() { if (calls++ === 0) return routed; throw new Error('private upstream response'); } };
    try { await decide({ action: 'Read.' }, { decisionsClient: client }); throw new Error('missing failure'); }
    catch (error) {
      expect(error).toBeInstanceOf(EngineError);
      expect((error as EngineError).trace?.stage_a?.usage.input_tokens).toBe(101);
      expect((error as Error).message).not.toContain('private');
    }
  });
  it.each([null, {}, { action: '' }, { action: '  ' }, { action: 'x', context: 4 }])('rejects invalid input before calling the provider: %j', async (input) => {
    const client = createReplayClient([]);
    await expect(decide(input as never, { decisionsClient: client })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(client.requests).toHaveLength(0);
  });
  it('rejects over 1M estimated caller tokens before upstream calls', async () => {
    const client = createReplayClient([]);
    await expect(decide({ action: 'x'.repeat(4000001) }, { decisionsClient: client })).rejects.toMatchObject({ code: 'input_too_large' });
    expect(client.requests).toHaveLength(0);
  });
  it('uses the prompt template for each reason and never fabricates a quote', () => {
    const synthesis = synthesize(judged().answers, prompts);
    for (const reason of Object.keys(prompts.summary_templates) as DecisionReason[]) {
      const summary = formatSummary({ ...synthesis, reason, ...(reason === 'refused' ? { alignment_probability: null } : {}) }, [], prompts);
      expect(summary.length).toBeGreaterThan(20);
      expect(summary).not.toMatch(/\{[a-z_]+\}/);
      if (reason === 'refused') { expect(summary).not.toContain('%'); expect(summary).not.toContain('Discernment'); }
    }
  });
});
