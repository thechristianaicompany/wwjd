import type { DecisionsCall, EngineErrorCode, Trace } from './types.ts';

const MESSAGES: Record<EngineErrorCode, string> = {
  input_too_large: 'The input exceeds the supported token limit.',
  upstream_auth: 'The evaluation provider could not authenticate this request.',
  upstream_rate_limited: 'The evaluation provider is temporarily rate limited.',
  upstream_error: 'The evaluation provider could not complete this request.',
  upstream_timeout: 'The evaluation provider did not respond before the deadline.',
  invalid_input: 'Provide a non-empty action and an optional text context.',
};

export interface EngineErrorDetails { retryAfterS?: number; trace?: Partial<Trace>; calls?: DecisionsCall[]; attempts?: number; upstreamStatus?: number }

/** Messages must be locally authored. Never pass provider error text or secrets. */
export class EngineError extends Error {
  code: EngineErrorCode;
  retryAfterS?: number;
  trace?: Partial<Trace>;
  calls?: DecisionsCall[];
  attempts?: number;
  upstreamStatus?: number;
  constructor(code: EngineErrorCode, message = MESSAGES[code], details: EngineErrorDetails = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.retryAfterS = details.retryAfterS;
    this.trace = details.trace;
    this.calls = details.calls;
    this.attempts = details.attempts;
    this.upstreamStatus = details.upstreamStatus;
  }
}

export class InputTooLargeError extends EngineError {
  constructor() {
    super('input_too_large');
    this.name = 'InputTooLargeError';
  }
}
