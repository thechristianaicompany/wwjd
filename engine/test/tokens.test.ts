import { describe, expect, it } from 'vitest';
import { EngineError, InputTooLargeError } from '../src/errors.ts';
import { creditsFor, estimateTokens } from '../src/tokens.ts';

describe('contract token estimate and credits', () => {
  it.each([['', 0], ['a', 1], ['four', 1], ['fives', 2], ['日本語の文', 2], ['😀😀😀', 2]] as const)('estimates %j as %i', (text, count) => {
    expect(estimateTokens(text)).toBe(count);
  });
  it.each([[0, 1], [100_000, 1], [100_001, 5], [1_000_000, 5]] as const)('charges %i tokens as %i credit(s)', (tokens, credits) => {
    expect(creditsFor(tokens)).toBe(credits);
  });
  it('rejects one token over the limit with the exported error class', () => {
    expect(() => creditsFor(1_000_001)).toThrow(InputTooLargeError);
    expect(() => creditsFor(1_000_001)).toThrow(expect.objectContaining({ code: 'input_too_large' }));
  });
  it.each([-1, NaN, Infinity, -Infinity])('does not grant credits for invalid numeric input %s', value => {
    expect(() => creditsFor(value)).toThrow(EngineError);
  });
});
