import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDecisionsClient } from '../src/client.ts';
import { EngineError } from '../src/errors.ts';
import type { DecisionsAnswer, DecisionsBody, DecisionsResponse } from '../src/types.ts';

const body: DecisionsBody = { model: 'gpt-6-luna', input: 'An offline test.', questions: [{ name: 'aligned', type: 'predicate', instructions: 'Classify the input.' }], safety_identifier: 'opaque-user-hash' };
const response: DecisionsResponse = { model: 'gpt-6-luna-2026-10-07', answers: [{ type: 'predicate', name: 'aligned', probability: 0.97 }], usage: { input_tokens: 19, output_tokens: 0, total_tokens: 19, input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 } } };
const providerError = (status: number, code = 'example_error', retryAfter?: string) => Response.json({ error: { code, message: 'DO_NOT_EXPOSE_secret_or_caller_text' } }, { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('fetch-based Decisions client', () => {
  it('sends the public request contract and preserves the upstream model and usage', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(response));
    const client = createDecisionsClient({ apiKey: 'test-only-key', fetch: fetcher, baseUrl: 'https://offline.invalid/v1/' });
    const result = await client.create(body, { stage: 'stage_b' });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://offline.invalid/v1/decisions');
    expect(init?.headers).toEqual({ authorization: 'Bearer test-only-key', 'content-type': 'application/json' });
    expect(JSON.parse(init?.body as string)).toEqual(body);
    expect(result).toMatchObject({ ...response, attempts: 1, calls: [{ input_tokens: 19, status: 200 }] });
  });

  it.each([401, 403, 400, 404])('does not retry status %i and never reflects provider text', async status => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerError(status));
    const error = await createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body).catch(value => value);
    expect(error).toBeInstanceOf(EngineError);
    expect(error.code).toBe(status === 401 || status === 403 ? 'upstream_auth' : 'upstream_error');
    expect(JSON.stringify(error)).not.toContain('DO_NOT_EXPOSE');
    expect(error.message).not.toContain('DO_NOT_EXPOSE');
    expect(error.calls).toMatchObject([{ input_tokens: 0, status }]);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('leaves the context-budget retry to the engine pipeline', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerError(400, 'context_length_exceeded'));
    await expect(createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body)).rejects.toMatchObject({ code: 'input_too_large', attempts: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('recognizes the live Decisions token-limit error without a specialized code', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ error: { code: 'invalid_request_error', message: 'Decision input exceeds the token limit.' } }, { status: 400 }));
    await expect(createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body)).rejects.toMatchObject({ code: 'input_too_large', attempts: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([429, 500, 503, 504])('retries status %i once and records both attempts', async status => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(providerError(status)).mockResolvedValueOnce(Response.json(response));
    const observe = vi.fn();
    const pending = createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body, { onAttempt: observe });
    await vi.advanceTimersByTimeAsync(299);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ attempts: 2, calls: [{ status, input_tokens: 0 }, { status: 200, input_tokens: 19 }] });
    expect(observe).toHaveBeenCalledTimes(2);
  });

  it.each(['json', 'html'] as const)('lets the engine halve a large input before retrying a %s 504 response', async format => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(format === 'json' ? providerError(504) : new Response('Gateway timeout', { status: 504 }));
    await expect(createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body, { retry504: false })).rejects.toMatchObject({ code: 'upstream_error', upstreamStatus: 504, attempts: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('stops after the second rate limit and preserves Retry-After', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => providerError(429, 'rate_limit', '17'));
    const pending = createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body).catch(value => value);
    await vi.runAllTimersAsync();
    expect(await pending).toMatchObject({ code: 'upstream_rate_limited', retryAfterS: 17, attempts: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('retries a network failure once without retaining the thrown message', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('test-key-must-never-appear'));
    const pending = createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body).catch(value => value);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error).toMatchObject({ code: 'upstream_error', attempts: 2, calls: [{ input_tokens: 0 }, { input_tokens: 0 }] });
    expect(error.message).not.toContain('test-key');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it.each([['stage_a', 20_000], ['stage_b', 60_000]] as const)('enforces the whole %s deadline even if a fetch implementation ignores abort', async (stage, timeout) => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {}));
    const pending = createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body, { stage }).catch(value => value);
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ code: 'upstream_timeout', attempts: 1 });
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('honors a caller deadline during jitter without sending another request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerError(503));
    const pending = createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body, { signal: controller.signal }).catch(value => value);
    await vi.advanceTimersByTimeAsync(50);
    controller.abort();
    expect(await pending).toMatchObject({ code: 'upstream_timeout', attempts: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('does not send any request when the caller already cancelled', async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body, { signal: AbortSignal.abort() })).rejects.toMatchObject({ code: 'upstream_timeout', attempts: 0 });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { ...response, answers: [] },
    { ...response, answers: [{ type: 'predicate', name: 'wrong_question', probability: 0.97 }] },
    { ...response, answers: [{ type: 'predicate', name: 'aligned', probability: 1.2 }] },
    { ...response, usage: { input_tokens: -1 } },
    { ...response, model: '' },
  ])('fails closed on malformed successful data', async value => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(value));
    await expect(createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body)).rejects.toMatchObject({ code: 'upstream_error', attempts: 1 });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('accepts a named refusal and drops undocumented provider fields', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response, secret: 'do-not-retain', answers: [{ type: 'refusal', name: 'aligned', explanation: 'do-not-retain' }] }));
    const result = await createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(body);
    expect(result.answers).toEqual([{ type: 'refusal', name: 'aligned' }]);
    expect(JSON.stringify(result)).not.toContain('do-not-retain');
  });

  describe.each(['choice', 'score'] as const)('%s distributions', type => {
    const labels = ['harms', 'neutral', 'helps'];
    const question = type === 'choice'
      ? { type, name: 'classification', instructions: 'Classify.', choices: labels.map(value => ({ value })) }
      : { type, name: 'classification', instructions: 'Classify.', levels: labels.map(label => ({ label })) };
    const request: DecisionsBody = { ...body, questions: [question] };
    const answer = (probabilities: number[]): DecisionsAnswer => type === 'choice'
      ? { type, name: question.name, choice: 'helps', confidence: 0.8, probabilities: probabilities.map((probability, index) => ({ value: labels[index]!, probability })) }
      : { type, name: question.name, score: 1.8, confidence: 0.8, probabilities: probabilities.map((probability, value) => ({ value, label: labels[value]!, probability })) };

    it.each([[0, 0, 0], [0, 0.1, 0.1], [0.4, 0.4, 0.4]])('rejects malformed probability mass %j', async (...probabilities) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response, answers: [answer(probabilities)] }));
      await expect(createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(request)).rejects.toMatchObject({ code: 'upstream_error', attempts: 1 });
      expect(fetcher).toHaveBeenCalledOnce();
    });

    it.each([[0, 0.2, 0.8], [0, 0.2, 0.8005], [0, 0.2, 0.7995]])('accepts normalized mass with bounded rounding tolerance %j', async (...probabilities) => {
      const expected = answer(probabilities);
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ...response, answers: [expected] }));
      await expect(createDecisionsClient({ apiKey: 'test', fetch: fetcher }).create(request)).resolves.toMatchObject({ answers: [expected] });
    });
  });
});
