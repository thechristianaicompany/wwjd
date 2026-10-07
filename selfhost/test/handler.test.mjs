import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHandler, MAX_BODY_BYTES, RETENTION } from '../src/handler.ts';

const OWNER = 'fixture-owner-password';
const BASE_ENV = { OWNER_KEY: OWNER, OPENAI_API_KEY: 'fixture-upstream-password' };
const decision = { id: 'dec_fixture', object: 'wwjd.decision', verdict: 'aligned', alignment_probability: 0.9, ask_human: false, refused: false };
function fixture(overrides = {}) {
  const calls = [];
  const client = { create() { throw new Error('Fixture never calls an upstream.'); } };
  const corpus = { corpusVersion: 'c1' };
  const handler = createHandler({
    decide: async (input, options) => { calls.push({ input, options }); return { decision, trace: { private: 'trace-not-for-response' } }; },
    createDecisionsClient: ({ apiKey }) => { assert.equal(apiKey, BASE_ENV.OPENAI_API_KEY); return client; },
    corpus, engineVersion: '1.0.0-fixture', promptVersion: 'p1', ...overrides,
  });
  return { handler, calls, client, corpus };
}
function request(body = { action: 'Explain a proposed edit to its owner.' }, headers = {}) {
  return new Request('http://localhost/v1/wwjd', {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${OWNER}`, ...headers }, body: JSON.stringify(body),
  });
}

test('owner key missing or blank fails closed before reading or calling engine', async () => {
  for (const env of [{}, { OWNER_KEY: '' }, { OWNER_KEY: '  ' }, { ALLOW_PUBLIC: 'TRUE' }, { ALLOW_PUBLIC: '1' }]) {
    const { handler, calls } = fixture();
    const result = await handler(request(), env);
    assert.equal(result.status, 503);
    assert.equal((await result.json()).error.code, 'owner_key_required');
    assert.equal(calls.length, 0);
  }
});

test('owner authentication rejects missing, wrong, truncated, and malformed bearer tokens', async () => {
  for (const authorization of ['', 'Basic fake', 'Bearer wrong-password', `Bearer ${OWNER.slice(0, -1)}`, `Bearer ${OWNER} extra`]) {
    const { handler, calls } = fixture();
    const result = await handler(request(undefined, { Authorization: authorization }), BASE_ENV);
    assert.equal(result.status, 401);
    assert.match((await result.json()).error.message, /OWNER_KEY/);
    assert.equal(calls.length, 0);
  }
});

test('valid owner reaches engine once, returns decision without trace or credits, and discloses local retention', async () => {
  const { handler, calls, client, corpus } = fixture();
  const result = await handler(request({ action: '  Ask before editing.  ', context: 'The files belong to the owner.' }), BASE_ENV);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.ok(result.headers.get('X-WWJD-Request-Id'));
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), '*');
  assert.deepEqual(await result.json(), { ...decision, retention: RETENTION });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].input, { action: 'Ask before editing.', context: 'The files belong to the owner.' });
  assert.equal(calls[0].options.decisionsClient, client);
  assert.equal(calls[0].options.corpus, corpus);
});

test('only literal ALLOW_PUBLIC=true permits an unauthenticated request', async () => {
  const { handler, calls } = fixture();
  const result = await handler(request(undefined, { Authorization: '' }), { OPENAI_API_KEY: BASE_ENV.OPENAI_API_KEY, ALLOW_PUBLIC: 'true' });
  assert.equal(result.status, 200);
  assert.equal(calls.length, 1);
});

test('health works without keys and reports versions; routes and preflight do not call engine', async () => {
  const { handler, calls } = fixture();
  const health = await handler(new Request('http://localhost/v1/health'), { CF_VERSION_METADATA: { id: 'version-fixture' } });
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true, engine_version: '1.0.0-fixture', prompt_version: 'p1', corpus_version: 'c1', model: 'gpt-6-luna', environment: 'selfhost', version_id: 'version-fixture' });
  assert.equal((await handler(new Request('http://localhost/v1/wwjd'), BASE_ENV)).status, 405);
  assert.equal((await handler(new Request('http://localhost/v1/keys', { method: 'POST' }), BASE_ENV)).status, 404);
  const preflight = await handler(new Request('http://localhost/v1/wwjd', { method: 'OPTIONS' }), {});
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('Access-Control-Allow-Headers'), 'Authorization, Content-Type');
  assert.equal(calls.length, 0);
});

test('invalid JSON shape, empty action, non-string context and wrong content type return 400', async () => {
  const { handler, calls } = fixture();
  for (const body of [null, [], 4, {}, { action: '' }, { action: '  ' }, { action: 'Act', context: null }, { action: 3 }]) {
    assert.equal((await handler(request(body), BASE_ENV)).status, 400);
  }
  assert.equal((await handler(request(undefined, { 'Content-Type': 'text/plain' }), BASE_ENV)).status, 400);
  const broken = new Request('http://localhost/v1/wwjd', { method: 'POST', headers: request().headers, body: '{' });
  assert.equal((await handler(broken, BASE_ENV)).status, 400);
  assert.equal(calls.length, 0);
});

test('streamed bytes enforce 8 MB with no content length, including multibyte text', async () => {
  const { handler, calls } = fixture();
  let cancelled = false;
  const chunk = new TextEncoder().encode('愛'.repeat(350_000));
  let count = 0;
  const body = new ReadableStream({
    pull(controller) { count++; controller.enqueue(chunk); },
    cancel() { cancelled = true; },
  });
  const req = new Request('http://localhost/v1/wwjd', { method: 'POST', headers: request().headers, body, duplex: 'half' });
  assert.equal(req.headers.get('Content-Length'), null);
  const result = await handler(req, BASE_ENV);
  assert.equal(result.status, 413);
  assert.equal((await result.json()).error.code, 'input_too_large');
  assert.equal(cancelled, true);
  assert.ok(count <= Math.ceil(MAX_BODY_BYTES / chunk.length) + 1);
  assert.equal(calls.length, 0);
});

test('content length and estimated token cap each reject before engine evaluation', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(request(undefined, { 'Content-Length': String(MAX_BODY_BYTES + 1) }), BASE_ENV)).status, 413);
  assert.equal((await handler(request({ action: 'A', context: 'x'.repeat(4_000_000) }), BASE_ENV)).status, 413);
  const boundary = await handler(request({ action: 'A', context: 'x'.repeat(3_999_999) }), BASE_ENV);
  assert.equal(boundary.status, 200);
  assert.equal(calls.length, 1);
});

test('missing upstream configuration cannot issue an evaluation', async () => {
  const { handler, calls } = fixture();
  const result = await handler(request(), { OWNER_KEY: OWNER });
  assert.equal(result.status, 503);
  assert.equal((await result.json()).error.code, 'service_unavailable');
  assert.equal(calls.length, 0);
});

test('engine errors map to public status codes without leaking error text or trace', async () => {
  const cases = [['input_too_large', 413, 'input_too_large'], ['invalid_input', 400, 'invalid_request'], ['upstream_auth', 502, 'upstream_error'], ['upstream_error', 502, 'upstream_error'], ['upstream_timeout', 504, 'upstream_timeout'], ['upstream_rate_limited', 503, 'service_unavailable']];
  for (const [code, status, publicCode] of cases) {
    const error = Object.assign(new Error('private upstream diagnostic'), { code, trace: { text: 'private request' }, retryAfterS: 4.2 });
    const { handler } = fixture({ decide: async () => { throw error; } });
    const result = await handler(request(), BASE_ENV);
    assert.equal(result.status, status);
    const body = await result.text();
    assert.equal(JSON.parse(body).error.code, publicCode);
    assert.doesNotMatch(body, /private|trace/);
    if (status === 503) assert.equal(result.headers.get('Retry-After'), '5');
  }
});
