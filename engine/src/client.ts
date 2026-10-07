import { EngineError } from './errors.ts';
import type { DecisionsAnswer, DecisionsBody, DecisionsCall, DecisionsClient, DecisionsExecutionOptions, DecisionsQuestion, DecisionsResponse, DecisionsUsage } from './types.ts';

type ObjectValue = Record<string, unknown>;
function object(value: unknown): value is ObjectValue { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function probability(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1; }
function tokenCount(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function invalidResponse(): never { throw new EngineError('upstream_error'); }
function validateDistribution(entries: readonly { probability: number }[]): void {
  if (Math.abs(entries.reduce((sum, entry) => sum + entry.probability, 0) - 1) > 0.001) invalidResponse();
}

function readUsage(value: unknown): DecisionsUsage {
  if (!object(value) || !tokenCount(value.input_tokens)) invalidResponse();
  const usage: DecisionsUsage = { input_tokens: value.input_tokens };
  if (tokenCount(value.output_tokens)) usage.output_tokens = value.output_tokens;
  if (tokenCount(value.total_tokens)) usage.total_tokens = value.total_tokens;
  if (object(value.input_tokens_details) && tokenCount(value.input_tokens_details.cached_tokens) && tokenCount(value.input_tokens_details.cache_write_tokens)) {
    usage.input_tokens_details = { cached_tokens: value.input_tokens_details.cached_tokens, cache_write_tokens: value.input_tokens_details.cache_write_tokens };
  }
  if (object(value.output_tokens_details) && tokenCount(value.output_tokens_details.reasoning_tokens)) {
    usage.output_tokens_details = { reasoning_tokens: value.output_tokens_details.reasoning_tokens };
  }
  return usage;
}

function readAnswer(value: unknown, question: DecisionsQuestion): DecisionsAnswer {
  if (!object(value) || value.name !== question.name) invalidResponse();
  const name = question.name;
  if (value.type === 'refusal') return { type: 'refusal', name };
  if (value.type !== question.type) invalidResponse();
  if (question.type === 'predicate') {
    if (!probability(value.probability)) invalidResponse();
    return { type: 'predicate', name, probability: value.probability };
  }
  if (!probability(value.confidence) || !Array.isArray(value.probabilities)) invalidResponse();
  const confidence = value.confidence;
  if (question.type === 'choice') {
    if (!question.choices.some(choice => choice.value === value.choice) || value.probabilities.length !== question.choices.length) invalidResponse();
    const seen = new Set<string | boolean>();
    const probabilities = value.probabilities.map((entry: unknown) => {
      if (!object(entry) || (typeof entry.value !== 'string' && typeof entry.value !== 'boolean') || !probability(entry.probability) || seen.has(entry.value) || !question.choices.some(choice => choice.value === entry.value)) invalidResponse();
      seen.add(entry.value);
      return { value: entry.value, probability: entry.probability };
    });
    validateDistribution(probabilities);
    return { type: 'choice', name, choice: value.choice as string | boolean, confidence, probabilities };
  }
  if (typeof value.score !== 'number' || !Number.isFinite(value.score) || value.score < 0 || value.score > question.levels.length - 1 || value.probabilities.length !== question.levels.length) invalidResponse();
  const seen = new Set<number>();
  const probabilities = value.probabilities.map((entry: unknown) => {
    if (!object(entry) || !Number.isSafeInteger(entry.value) || (entry.value as number) < 0 || (entry.value as number) >= question.levels.length || !probability(entry.probability) || typeof entry.label !== 'string' || question.levels[entry.value as number]?.label !== entry.label || seen.has(entry.value as number)) invalidResponse();
    seen.add(entry.value as number);
    return { value: entry.value as number, label: entry.label, probability: entry.probability };
  });
  validateDistribution(probabilities);
  return { type: 'score', name, score: value.score, confidence, probabilities };
}

/** Validate untrusted wire data and retain only the documented response fields. */
export function readDecisionsResponse(value: unknown, body: DecisionsBody): DecisionsResponse {
  if (!object(value) || typeof value.model !== 'string' || !value.model || !Array.isArray(value.answers) || value.answers.length !== body.questions.length) invalidResponse();
  return {
    model: value.model,
    usage: readUsage(value.usage),
    answers: value.answers.map((answer, index) => readAnswer(answer, body.questions[index]!)),
  };
}

function retryAfter(response: Response): number | undefined {
  const raw = response.headers.get('retry-after');
  if (!raw) return undefined;
  const number = Number(raw);
  if (Number.isFinite(number) && number >= 0) return Math.ceil(number);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - Date.now()) / 1_000)) : undefined;
}

function contextLengthError(value: unknown): boolean {
  if (!object(value) || !object(value.error)) return false;
  if (['context_length_exceeded', 'input_too_large', 'max_tokens_exceeded'].includes(String(value.error.code))) return true;
  return typeof value.error.message === 'string' && /decision input exceeds the token limit|context.{0,30}(?:length|limit)|(?:input|maximum).{0,30}(?:tokens?|length).{0,50}(?:exceed|limit)|too many (?:input )?tokens/i.test(value.error.message);
}

function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const aborted = () => { cleanup(); reject(new EngineError('upstream_timeout')); };
    const cleanup = () => signal.removeEventListener('abort', aborted);
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) aborted();
  });
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new EngineError('upstream_timeout')); return; }
    const aborted = () => { clearTimeout(timer); reject(new EngineError('upstream_timeout')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve(); }, ms);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

export function createDecisionsClient(opts: { apiKey: string; fetch?: typeof fetch; baseUrl?: string }): DecisionsClient {
  const fetcher = opts.fetch ?? globalThis.fetch;
  const endpoint = `${(opts.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '')}/decisions`;
  return {
    async create(body: DecisionsBody, options: DecisionsExecutionOptions = {}): Promise<DecisionsResponse> {
      if (!opts.apiKey.trim()) throw new EngineError('upstream_auth');
      if (body.safety_identifier !== undefined && (typeof body.safety_identifier !== 'string' || body.safety_identifier.length > 128)) throw new EngineError('invalid_input');
      const stage = options.stage ?? (body.questions.every(question => question.name === 'topic' || question.name === 'teaching') ? 'stage_a' : 'stage_b');
      const controller = new AbortController();
      const externalAbort = () => controller.abort();
      if (options.signal?.aborted) controller.abort();
      else options.signal?.addEventListener('abort', externalAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), stage === 'stage_a' ? 20_000 : 60_000);
      const calls: DecisionsCall[] = [];
      let upstreamStatus: number | undefined;
      const record = (call: DecisionsCall) => { calls.push(call); options.onAttempt?.(call); };
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          upstreamStatus = undefined;
          if (controller.signal.aborted) throw new EngineError('upstream_timeout');
          const started = Date.now();
          let response: Response;
          try {
            response = await withAbort(fetcher(endpoint, {
              method: 'POST',
              headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
              body: JSON.stringify(body),
              signal: controller.signal,
            }), controller.signal);
          } catch {
            record({ input_tokens: 0, latency_ms: Date.now() - started });
            if (controller.signal.aborted) throw new EngineError('upstream_timeout');
            if (attempt === 1) throw new EngineError('upstream_error');
            await pause(300 + Math.floor(Math.random() * 601), controller.signal);
            continue;
          }
          let value: unknown;
          upstreamStatus = response.status;
          const retryableStatus = (response.status === 429 || response.status >= 500) && !(response.status === 504 && options.retry504 === false);
          try { value = await withAbort(response.json(), controller.signal); }
          catch {
            record({ input_tokens: 0, status: response.status, latency_ms: Date.now() - started });
            if (controller.signal.aborted) throw new EngineError('upstream_timeout');
            if (retryableStatus && attempt === 0) {
              await pause(300 + Math.floor(Math.random() * 601), controller.signal);
              continue;
            }
            if (response.status === 401 || response.status === 403) throw new EngineError('upstream_auth');
            if (response.status === 429) throw new EngineError('upstream_rate_limited', undefined, { retryAfterS: retryAfter(response) });
            throw new EngineError('upstream_error');
          }
          const knownTokens = object(value) && object(value.usage) && tokenCount(value.usage.input_tokens) ? value.usage.input_tokens : 0;
          record({ input_tokens: knownTokens, status: response.status, latency_ms: Date.now() - started });
          if (response.ok) return { ...readDecisionsResponse(value, body), attempts: calls.length, calls };
          if (response.status === 400 && contextLengthError(value)) throw new EngineError('input_too_large');
          if (response.status === 401 || response.status === 403) throw new EngineError('upstream_auth');
          if (retryableStatus && attempt === 0) {
            await pause(300 + Math.floor(Math.random() * 601), controller.signal);
            continue;
          }
          if (response.status === 429) throw new EngineError('upstream_rate_limited', undefined, { retryAfterS: retryAfter(response) });
          throw new EngineError('upstream_error');
        }
        throw new EngineError('upstream_error');
      } catch (error) {
        const safe = error instanceof EngineError ? error : new EngineError('upstream_error');
        safe.calls = calls;
        safe.attempts = calls.length;
        if (safe.code !== 'upstream_timeout') safe.upstreamStatus = upstreamStatus;
        throw safe;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', externalAbort);
      }
    },
  };
}
