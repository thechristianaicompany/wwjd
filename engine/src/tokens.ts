import { EngineError, InputTooLargeError } from './errors.ts';

/** Contract estimate uses JavaScript string length, including UTF-16 code units. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function creditsFor(estTokens: number): 1 | 5 {
  if (!Number.isFinite(estTokens) || estTokens < 0) throw new EngineError('invalid_input');
  if (estTokens <= 100_000) return 1;
  if (estTokens <= 1_000_000) return 5;
  throw new InputTooLargeError();
}
