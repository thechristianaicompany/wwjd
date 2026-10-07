import p1 from './p1.json' with { type: 'json' };
import type { PromptSet } from '../src/types.ts';

/** p1 remains a draft until the full W2 engine PR merges. */
export const PROMPT_SETS: Readonly<Record<string, PromptSet>> = Object.freeze({ p1: p1 as PromptSet });
export const DEFAULT_PROMPT_SET_ID = 'p1';
