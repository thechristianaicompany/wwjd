import { readDecisionsResponse } from './client.ts';
import { EngineError } from './errors.ts';
import type { DecisionStage, DecisionsBody, DecisionsClient, DecisionsExecutionOptions, DecisionsResponse } from './types.ts';

export type ReplayEntry = DecisionsResponse | { response: DecisionsResponse; stage?: DecisionStage } | { error: EngineError; stage?: DecisionStage };
export interface ReplayDecisionsClient extends DecisionsClient {
  readonly requests: readonly { body: DecisionsBody; stage?: DecisionStage }[];
  readonly remaining: number;
}

/** In-memory fixture queue. Performs no network access and validates fixture shapes. */
export function createReplayClient(fixtures: readonly ReplayEntry[]): ReplayDecisionsClient {
  const queue = [...fixtures];
  const requests: { body: DecisionsBody; stage?: DecisionStage }[] = [];
  let next = 0;
  return {
    get requests() { return structuredClone(requests); },
    get remaining() { return queue.length - next; },
    async create(body: DecisionsBody, options: DecisionsExecutionOptions = {}): Promise<DecisionsResponse> {
      if (options.signal?.aborted) throw new EngineError('upstream_timeout');
      const entry = queue[next];
      if (!entry) throw new EngineError('upstream_error', 'The replay fixture queue is exhausted.');
      if ('stage' in entry && entry.stage !== undefined && options.stage !== entry.stage) throw new EngineError('upstream_error', 'The replay fixture stage does not match the request.');
      next += 1;
      requests.push({ body: structuredClone(body), ...(options.stage ? { stage: options.stage } : {}) });
      if ('error' in entry) {
        const source = entry.error;
        const error = new EngineError(source.code, undefined, {
          retryAfterS: source.retryAfterS,
          trace: source.trace ? structuredClone(source.trace) : undefined,
          calls: source.calls ? structuredClone(source.calls) : undefined,
          attempts: source.attempts,
          upstreamStatus: source.upstreamStatus,
        });
        for (const call of error.calls ?? []) options.onAttempt?.(call);
        throw error;
      }
      const source = 'response' in entry ? entry.response : entry;
      const response = readDecisionsResponse(structuredClone(source), body);
      const calls = structuredClone(source.calls ?? [{ input_tokens: response.usage.input_tokens }]);
      for (const call of calls) options.onAttempt?.(call);
      return { ...response, attempts: source.attempts ?? calls.length, calls };
    },
  };
}
