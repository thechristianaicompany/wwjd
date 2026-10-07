import { describe, expect, it, vi } from 'vitest';
import { createBudgetedClient } from '../scripts/live-budget.mjs';
import { createDecisionsClient } from '../src/client.ts';

const body = { model: 'gpt-6-luna', input: 'An offline action.', questions: [{ type: 'predicate', name: 'aligned', instructions: 'Classify.' }] };
const response = (tokens = 100) => ({ model: 'test-only', answers: [], usage: { input_tokens: tokens }, calls: [{ input_tokens: tokens, status: 200 }], attempts: 1 });
const attemptReserve = request => (new TextEncoder().encode(JSON.stringify(request)).byteLength + 8_192 + 512 * request.questions.length) / 1e6 * .20;

describe('live budget reservation and settlement', () => {
  it.each([
    { model: 'test-only', answers: [{ type: 'predicate', name: 'aligned', probability: 1 }] },
    { model: 'test-only', answers: [], usage: { input_tokens: 0 } },
  ])('retains the reservation when the actual client rejects a malformed HTTP 200 response', async payload => {
    const fetcher = vi.fn(async () => Response.json(payload));
    const budget = createBudgetedClient({ client: createDecisionsClient({ apiKey: 'offline-test-only', fetch: fetcher }), capUsd: 1 });
    await expect(budget.create(body)).rejects.toMatchObject({ code: 'upstream_error', calls: [{ status: 200, input_tokens: 0 }] });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(budget.known_usage_cost_usd).toBe(0);
    expect(budget.conservative_cost_usd).toBeCloseTo(attemptReserve(body), 12);
  });

  it('preserves known positive usage when the actual client rejects an HTTP 200 response', async () => {
    const client = createDecisionsClient({ apiKey: 'offline-test-only', fetch: async () => Response.json({ model: 'test-only', answers: [], usage: { input_tokens: 123 } }) });
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await expect(budget.create(body)).rejects.toMatchObject({ code: 'upstream_error' });
    expect(budget.known_usage_cost_usd).toBeCloseTo(.0000123, 12);
    expect(budget.conservative_cost_usd).toBeCloseTo(.0000123, 12);
  });

  it('accepts zero cost only after the actual client validates a successful zero-usage response', async () => {
    const payload = { model: 'test-only', answers: [{ type: 'predicate', name: 'aligned', probability: 1 }], usage: { input_tokens: 0 } };
    const client = createDecisionsClient({ apiKey: 'offline-test-only', fetch: async () => Response.json(payload) });
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await expect(budget.create(body)).resolves.toMatchObject(payload);
    expect(budget.known_usage_cost_usd).toBe(0);
    expect(budget.conservative_cost_usd).toBe(0);
  });

  it('persists both possible attempts before any provider I/O, then charges known successful usage', async () => {
    const updates = [];
    const client = { create: vi.fn(async () => {
      expect(updates).toHaveLength(1);
      expect(updates[0].pending_reservation_usd).toBeCloseTo(attemptReserve(body) * 2, 12);
      return response();
    }) };
    const budget = createBudgetedClient({ client, capUsd: 1, onUpdate: async snapshot => { updates.push(snapshot); } });
    await expect(budget.create(body)).resolves.toEqual(response());
    expect(budget.snapshot()).toMatchObject({ known_usage_cost_usd: .00001, pending_reservation_usd: 0 });
    expect(budget.conservative_cost_usd).toBeCloseTo(.00001, 12);
    expect(updates).toHaveLength(2);
  });

  it('enforces the expensive input tier for successful known billing', async () => {
    const budget = createBudgetedClient({ client: { create: async () => response(300_000) }, capUsd: 1 });
    await budget.create({ ...body, input: 'x'.repeat(1_500_000) });
    expect(budget.known_usage_cost_usd).toBeCloseTo(.06, 12);
    expect(budget.conservative_cost_usd).toBeCloseTo(.06, 12);
  });

  it('rejects custom long input before I/O when two bounded attempts cannot fit the cap', async () => {
    const client = { create: vi.fn() };
    const updates = vi.fn();
    const budget = createBudgetedClient({ client, capUsd: .3, onUpdate: updates });
    await expect(budget.create({ ...body, input: '日'.repeat(700_000) })).rejects.toMatchObject({ code: 'live_budget_exceeded' });
    expect(client.create).not.toHaveBeenCalled();
    expect(updates).not.toHaveBeenCalled();
    expect(budget.conservative_cost_usd).toBe(0);
  });

  it('accounts for every known retry and keeps failed zero-usage attempts reserved', async () => {
    const calls = [{ input_tokens: 0, status: 503 }, { input_tokens: 50, status: 200 }];
    const onAttempt = vi.fn();
    const client = { async create(_body, options) { for (const call of calls) options.onAttempt(call); return { ...response(50), calls, attempts: 2 }; } };
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await budget.create(body, { onAttempt });
    expect(onAttempt).toHaveBeenCalledTimes(2);
    expect(budget.conservative_cost_usd).toBeCloseTo(attemptReserve(body) + .000005, 12);
    expect(budget.known_usage_cost_usd).toBeCloseTo(.000005, 12);
    expect(budget.pending_reservation_usd).toBe(0);
  });

  it('uses observations if a thrown error has no call metadata', async () => {
    const failure = new Error('offline fixture');
    const client = { async create(_body, options) { options.onAttempt({ input_tokens: 300, status: 503 }); options.onAttempt({ input_tokens: 0, status: 504 }); throw failure; } };
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await expect(budget.create(body)).rejects.toBe(failure);
    expect(budget.conservative_cost_usd).toBeCloseTo(.00003 + attemptReserve(body), 12);
    expect(budget.known_usage_cost_usd).toBeCloseTo(.00003, 12);
  });

  it('retains an unobserved attempt when an error has no complete attempt metadata', async () => {
    const failure = new Error('offline fixture');
    const client = { async create(_body, options) { options.onAttempt({ input_tokens: 300, status: 503 }); throw failure; } };
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await expect(budget.create(body)).rejects.toBe(failure);
    expect(budget.conservative_cost_usd).toBeCloseTo(.00003 + attemptReserve(body), 12);
    expect(budget.known_usage_cost_usd).toBeCloseTo(.00003, 12);
  });

  it('counts known usage from every failed and successful transport attempt', async () => {
    const client = { async create() { return { ...response(500), calls: [{ input_tokens: 300, status: 503 }, { input_tokens: 500, status: 200 }], attempts: 2 }; } };
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await budget.create(body);
    expect(budget.known_usage_cost_usd).toBeCloseTo(.00008, 12);
    expect(budget.conservative_cost_usd).toBeCloseTo(.00008, 12);
  });

  it('keeps the possible retry reserved when successful usage arrives without attempt metadata', async () => {
    const client = { async create() { return { usage: { input_tokens: 500 } }; } };
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await budget.create(body);
    expect(budget.known_usage_cost_usd).toBeCloseTo(.00005, 12);
    expect(budget.conservative_cost_usd).toBeCloseTo(.00005 + attemptReserve(body), 12);
  });

  it('retains both possible attempts when a failure is ambiguous', async () => {
    const failure = new Error('offline fixture');
    const budget = createBudgetedClient({ client: { create: async () => { throw failure; } }, capUsd: 1 });
    await expect(budget.create(body)).rejects.toBe(failure);
    expect(budget.conservative_cost_usd).toBeCloseTo(attemptReserve(body) * 2, 12);
    expect(budget.pending_reservation_usd).toBe(0);
  });

  it('releases only the second unsent attempt on an explicitly single-attempt failure', async () => {
    const failure = Object.assign(new Error('offline fixture'), { calls: [{ input_tokens: 0, status: 401 }], attempts: 1 });
    const budget = createBudgetedClient({ client: { create: async () => { throw failure; } }, capUsd: 1 });
    await expect(budget.create(body)).rejects.toBe(failure);
    expect(budget.conservative_cost_usd).toBeCloseTo(attemptReserve(body), 12);
  });

  it('releases both reservations when metadata establishes no attempt was sent', async () => {
    const failure = Object.assign(new Error('offline fixture'), { calls: [], attempts: 0 });
    const budget = createBudgetedClient({ client: { create: async () => { throw failure; } }, capUsd: 1 });
    await expect(budget.create(body)).rejects.toBe(failure);
    expect(budget.conservative_cost_usd).toBe(0);
  });

  it('counts failed unknown attempts against admission of later requests', async () => {
    const failure = new Error('offline fixture');
    const client = { create: vi.fn(async () => { throw failure; }) };
    const budget = createBudgetedClient({ client, capUsd: attemptReserve(body) * 3 });
    await expect(budget.create(body)).rejects.toBe(failure);
    await expect(budget.create(body)).rejects.toMatchObject({ code: 'live_budget_exceeded' });
    expect(client.create).toHaveBeenCalledOnce();
  });

  it('cannot call the provider if reservation persistence fails', async () => {
    const client = { create: vi.fn() };
    const budget = createBudgetedClient({ client, capUsd: 1, onUpdate: async () => { throw new Error('offline persistence failure'); } });
    await expect(budget.create(body)).rejects.toThrow('offline persistence failure');
    expect(client.create).not.toHaveBeenCalled();
    expect(budget.conservative_cost_usd).toBe(0);
  });

  it('blocks concurrent calls so persisted reservation snapshots cannot race', async () => {
    let resolve;
    const client = { create: vi.fn(() => new Promise(done => { resolve = done; })) };
    const budget = createBudgetedClient({ client, capUsd: 1 });
    const first = budget.create(body);
    await Promise.resolve();
    await expect(budget.create(body)).rejects.toMatchObject({ code: 'live_budget_busy' });
    resolve(response());
    await first;
    expect(client.create).toHaveBeenCalledOnce();
  });

  it('rejects unsupported image input without provider I/O', async () => {
    const client = { create: vi.fn() };
    const budget = createBudgetedClient({ client, capUsd: 1 });
    await expect(budget.create({ ...body, input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AA' }] }] })).rejects.toMatchObject({ code: 'live_budget_invalid_input' });
    expect(client.create).not.toHaveBeenCalled();
  });
});
