import { describe, expect, it } from 'vitest';
import { EngineError } from '../src/errors.ts';
import { createReplayClient } from '../src/replay.ts';
import type { DecisionsBody, DecisionsResponse } from '../src/types.ts';

const body: DecisionsBody = { model: 'gpt-6-luna', input: 'Fixture-only action.', questions: [{ type: 'predicate', name: 'aligned', instructions: 'Classify.' }] };
const response: DecisionsResponse = { model: 'gpt-6-luna', answers: [{ type: 'predicate', name: 'aligned', probability: 0.99 }], usage: { input_tokens: 42 } };

describe('offline fixture replay client', () => {
  it('replays each response once and fails closed when exhausted', async () => {
    const client = createReplayClient([response]);
    expect(await client.create(body)).toMatchObject({ ...response, attempts: 1, calls: [{ input_tokens: 42 }] });
    expect(client.remaining).toBe(0);
    await expect(client.create(body)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(client.requests).toHaveLength(1);
  });
  it('checks stage order without consuming an unmatched fixture', async () => {
    const client = createReplayClient([{ stage: 'stage_b', response }]);
    await expect(client.create(body, { stage: 'stage_a' })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(client.remaining).toBe(1);
    await expect(client.create(body, { stage: 'stage_b' })).resolves.toMatchObject(response);
  });
  it('preserves safe partial-error accounting and does not mutate the source error', async () => {
    const source = new EngineError('upstream_rate_limited', 'unsafe source message', { retryAfterS: 7, calls: [{ status: 429, input_tokens: 0 }], attempts: 1 });
    const client = createReplayClient([{ error: source }]);
    const error = await client.create(body).catch(value => value);
    expect(error).not.toBe(source);
    expect(error).toMatchObject({ code: 'upstream_rate_limited', retryAfterS: 7, attempts: 1, calls: [{ status: 429, input_tokens: 0 }] });
    expect(error.message).not.toContain('unsafe');
    expect(source.message).toBe('unsafe source message');
  });
  it('copies returned values and captured requests to isolate fixtures between tests', async () => {
    const client = createReplayClient([response, response]);
    const first = await client.create(body);
    first.usage.input_tokens = 0;
    const captured = client.requests;
    captured[0]!.body.input = 'modified';
    expect((await client.create(body)).usage.input_tokens).toBe(42);
    expect(client.requests[0]!.body.input).toBe('Fixture-only action.');
    expect(response.usage.input_tokens).toBe(42);
  });
  it('validates response question identity so an unrelated recording cannot pass', async () => {
    const client = createReplayClient([{ ...response, answers: [{ type: 'refusal', name: 'different' }] }]);
    await expect(client.create(body)).rejects.toMatchObject({ code: 'upstream_error' });
  });
  it('rejects all-zero neighbor score distributions in recorded fixtures', async () => {
    const labels = ['harms', 'neutral', 'helps'];
    const request: DecisionsBody = { ...body, questions: [{ type: 'score', name: 'love_of_neighbor', instructions: 'Classify.', levels: labels.map(label => ({ label })) }] };
    const client = createReplayClient([{ ...response, answers: [{ type: 'score', name: 'love_of_neighbor', score: 2, confidence: 1, probabilities: labels.map((label, value) => ({ label, value, probability: 0 })) }] }]);
    await expect(client.create(request)).rejects.toMatchObject({ code: 'upstream_error' });
  });
});
