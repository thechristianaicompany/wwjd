#!/usr/bin/env node
// Live measurements only: invoke through the project's with-openai-key.sh wrapper.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const endpoint = 'https://api.openai.com/v1/decisions';
const model = 'gpt-6-luna';
const questions = [{ type: 'predicate', name: 'contains_apple', instructions: 'Does the input contain the word apple?' }];
const evidencePath = fileURLToPath(new URL('../../docs/evidence/W2-token-measurements-2026-10-07.json', import.meta.url));
const capUsd = 1.50;
const args = process.argv.slice(2);
const mode = args[0];
if (!['samples', 'probe', 'report'].includes(mode)) {
  throw new Error('Usage: measure-tokens.mjs samples | probe <unique-id> <repeat-count> | report');
}
let evidence;
try {
  evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
  evidence = {
    schema_version: 1,
    started_at: new Date().toISOString(),
    endpoint,
    model,
    questions,
    spend_cap_usd: capUsd,
    pricing: {
      input_usd_per_million: 0.10,
      long_context_over_tokens: 272000,
      long_context_multiplier: 2,
      reservation_contingency_multiplier: 1.1,
      note: 'Reservations include rejected and ambiguous calls. Usage-derived cost is a pricing estimate, not a billing receipt; no output, cache-read, or cache-write charge on Decisions.',
      sources: ['docs/evidence/openai-decisions-guide-2026-10-07.txt', 'docs/evidence/openai-gpt-6-luna-model-2026-10-07.txt'],
    },
    attempts: [],
  };
}
evidence.spend_cap_usd = capUsd;
evidence.allocation_note = 'Parent W2 increased this measurement allocation from $0.75 to $1.50 on 2026-10-07; W2 total remains $3.';

const estimateTokens = (text) => Math.ceil(text.length / 4);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const price = (tokens, contingency = false) => tokens * 0.10 / 1e6 * (tokens > 272000 ? 2 : 1) * (contingency ? 1.1 : 1);
async function save() {
  evidence.updated_at = new Date().toISOString();
  evidence.reserved_spend_upper_estimate_usd = evidence.attempts.reduce((sum, item) => sum + item.reserved_cost_usd, 0);
  evidence.successful_usage_cost_estimate_usd = evidence.attempts.reduce((sum, item) => sum + (item.usage_cost_estimate_usd ?? 0), 0);
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
}
function calibratedOverhead() {
  const points = [1, 1000, 2000].map((n) => evidence.attempts.find((item) => item.id === `calibration_${n}`));
  if (points.some((point) => !Number.isInteger(point?.usage?.input_tokens))) return undefined;
  const offsets = points.map((point) => point.usage.input_tokens - point.repeat_count);
  return offsets.every((offset) => offset === offsets[0]) ? offsets[0] : undefined;
}
function summarize() {
  const overhead = calibratedOverhead();
  evidence.calibration = {
    repeated_unit: ' a',
    unit_tokens_observed: overhead === undefined ? null : 1,
    fixed_request_overhead_tokens: overhead ?? null,
    method: 'Compare API usage.input_tokens for 1, 1000, and 2000 repeats using identical questions; constant usage-minus-repeats is the inferred fixed overhead.',
    limitation: 'The fixed overhead is inferred from this synthetic calibration, not separately returned by the API. Boundary acceptance is based on actual API usage.',
  };
  evidence.sample_ratios = evidence.attempts.filter((attempt) => attempt.kind === 'sample' && attempt.usage).map((attempt) => ({
    id: attempt.id,
    utf16_length: attempt.utf16_length,
    utf8_bytes: attempt.utf8_bytes,
    estimated_input_tokens: attempt.estimated_input_tokens,
    api_usage_input_tokens: attempt.usage.input_tokens,
    raw_request_actual_to_estimated_ratio: attempt.usage.input_tokens / attempt.estimated_input_tokens,
    adjusted_text_tokens: overhead === undefined ? null : attempt.usage.input_tokens - overhead,
    adjusted_text_actual_to_estimated_ratio: overhead === undefined ? null : (attempt.usage.input_tokens - overhead) / attempt.estimated_input_tokens,
  }));
}
async function request(id, input, kind, repeatCount) {
  if (evidence.attempts.some((attempt) => attempt.id === id)) throw new Error(`Attempt ${id} already exists; inspect it before considering a new call.`);
  if (!process.env.OPENAI_API_KEY) throw new Error('Missing OPENAI_API_KEY; invoke through the project wrapper.');
  const overhead = calibratedOverhead();
  const reservedTokens = repeatCount !== undefined && overhead !== undefined
    ? repeatCount + overhead + 256
    : Buffer.byteLength(input) + Buffer.byteLength(JSON.stringify(questions)) + 256;
  const reservedCost = price(reservedTokens, true);
  const spent = evidence.attempts.reduce((sum, item) => sum + item.reserved_cost_usd, 0);
  if (spent + reservedCost > capUsd) throw new Error(`Measurement budget would exceed $${capUsd}; reserved so far $${spent.toFixed(6)}, next $${reservedCost.toFixed(6)}.`);
  const attempt = {
    id, kind, repeat_count: repeatCount, started_at: new Date().toISOString(),
    utf16_length: input.length, utf8_bytes: Buffer.byteLength(input),
    estimated_input_tokens: estimateTokens(input), input_sha256: sha256(input),
    predicted_usage_tokens: repeatCount !== undefined && overhead !== undefined ? repeatCount + overhead : null,
    reservation_tokens: reservedTokens, reserved_cost_usd: reservedCost,
    status: 'pending', timeout_ms: 120000,
  };
  evidence.attempts.push(attempt);
  await save();
  const started = performance.now();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input, questions }),
      signal: AbortSignal.timeout(attempt.timeout_ms),
    });
    attempt.http_status = response.status;
    let payload;
    try { payload = await response.json(); }
    catch { attempt.status = 'invalid_json'; return; }
    if (response.ok) {
      attempt.status = 'accepted';
      attempt.response_model = payload.model;
      attempt.answers = payload.answers;
      attempt.usage = payload.usage;
      if (Number.isInteger(payload.usage?.input_tokens)) attempt.usage_cost_estimate_usd = price(payload.usage.input_tokens);
    } else {
      attempt.status = 'rejected';
      // Error fields only: no request or response headers and no credential values.
      const error = payload.error ?? {};
      const redact = (value) => typeof value === 'string'
        ? value.split(process.env.OPENAI_API_KEY).join('[REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]')
        : value;
      attempt.error = Object.fromEntries(['message', 'type', 'param', 'code'].filter((key) => error[key] !== undefined).map((key) => [key, redact(error[key])]));
    }
  } catch (error) {
    attempt.status = 'transport_error';
    attempt.transport_error_name = error.name;
  } finally {
    attempt.elapsed_ms = Math.round(performance.now() - started);
    attempt.finished_at = new Date().toISOString();
    summarize();
    await save();
    console.log(JSON.stringify({ id, status: attempt.status, http_status: attempt.http_status, input_tokens: attempt.usage?.input_tokens, error: attempt.error, elapsed_ms: attempt.elapsed_ms, reserved_total_usd: evidence.reserved_spend_upper_estimate_usd }));
  }
}

if (mode === 'samples') {
  for (const repeats of [1, 1000, 2000]) await request(`calibration_${repeats}`, ' a'.repeat(repeats), 'calibration', repeats);
  const samples = {
    prose: 'An operator asks the assistant to prepare a release summary. The assistant reads the approved change list, checks the test results, and describes what changed in clear language. It includes known limitations so that the person deciding whether to deploy can make an informed choice. The assistant asks before taking an action beyond the permission it received.\n'.repeat(24),
    code: Array.from({ length: 60 }, (_, index) => `export function summarize${index}(items) {\n  const active = items.filter((item) => item.enabled === true);\n  return active.map(({ id, name }) => ({ id, label: name.trim() }));\n}\n`).join('\n'),
    json: JSON.stringify(Array.from({ length: 120 }, (_, index) => ({ id: `item_${index}`, enabled: index % 2 === 0, name: 'Approved release', tags: ['release', 'tested'], count: index, note: 'The operator approved this change.' })), null, 2),
    japanese: '利用者は、承認済みの変更内容とテスト結果を確認して、公開前の説明文を作成するように依頼しました。アシスタントは事実を正確に伝え、分からない点を明示します。許可された範囲を超える操作が必要な場合は、実行する前に利用者へ確認します。\n'.repeat(40),
  };
  for (const [id, input] of Object.entries(samples)) await request(id, input, 'sample');
} else if (mode === 'probe') {
  const [, id, count] = args;
  const repeats = Number(count);
  if (!/^[a-z][a-z0-9_]*$/.test(id ?? '') || !Number.isSafeInteger(repeats) || repeats < 1 || repeats > 1100000) throw new Error('Probe requires a unique lowercase id and repeat count between 1 and 1100000.');
  if (calibratedOverhead() === undefined) throw new Error('The three small calibration calls must agree before large probes.');
  await request(id, ' a'.repeat(repeats), 'limit_probe', repeats);
} else {
  summarize();
  await save();
  console.log(JSON.stringify({ calibration: evidence.calibration, sample_ratios: evidence.sample_ratios, reserved_spend_upper_estimate_usd: evidence.reserved_spend_upper_estimate_usd, successful_usage_cost_estimate_usd: evidence.successful_usage_cost_estimate_usd }, null, 2));
}
