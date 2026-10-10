import p1 from './p1.json' with { type: 'json' };
import p2 from './p2.json' with { type: 'json' };
import type { PromptSet } from '../src/types.ts';

/** Merged prompt sets are frozen; p2 adds the D24 moral hierarchy (life first) and is the default. */
export const PROMPT_SETS: Readonly<Record<string, PromptSet>> = Object.freeze({ p1: p1 as PromptSet, p2: p2 as PromptSet });
export const DEFAULT_PROMPT_SET_ID = 'p2';
