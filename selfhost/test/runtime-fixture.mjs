// Test-only Wrangler entry. It exercises the production HTTP wrapper, not the engine.
// Never used by wrangler.jsonc; all evaluation fields are explicit fixture values.
import * as corpus from '@wwjd/corpus';
import { createHandler } from '../src/handler.ts';

export default {
  fetch: createHandler({
    corpus, engineVersion: 'fixture-only', promptVersion: 'fixture-only',
    createDecisionsClient: () => ({ create() { throw new Error('The runtime fixture must never call a provider.'); } }),
    decide: async () => ({
      decision: {
        id: `dec_${crypto.randomUUID().replaceAll('-', '')}`, object: 'wwjd.decision',
        verdict: 'aligned', reason: 'judged', alignment_probability: 0.9, confidence: 0.9,
        ask_human: false, refused: false,
        verdict_probabilities: { aligned: 0.9, not_aligned: 0.05, discernment_required: 0.05 },
        scores: { love_of_god: 1, love_of_neighbor: 1 },
        guards: { ten_commandments: [], triggered: [], dilemma: 0, manipulation: 0, overridden: false, notes: [] },
        basis: {
          top_rule: corpus.directives.top_rule, directives: corpus.directives.great_commandments,
          topics: [], teachings: [], passages: [], routing: { fallback: false }, truncated: false,
        },
        summary: 'Test fixture only. No alignment evaluation was performed.',
        model: 'fixture-only', engine_version: 'fixture-only', prompt_version: 'fixture-only', corpus_version: corpus.corpusVersion,
        usage: { input_tokens: 0, decisions_calls: 0, est_input_tokens: 0, calls: [] }, latency_ms: 0,
        disclaimer: "Jevsus is an LLM experiment, not Jesus. If Jevsus says Jesus would do something He wouldn't, Jevsus is wrong.",
      },
      trace: {},
    }),
  }),
};
