# @wwjd/engine

WWJD turns a proposed action into an alignment probability, a verdict and a verbatim World English Bible basis. It routes the request to relevant topics and teachings, assembles Scripture with Jesus' two great commandments first, judges the action, and applies deterministic guard rules.

```ts
import { createDecisionsClient, decide } from '@wwjd/engine';

const { decision, trace } = await decide(
  { action: 'Send the email the user drafted and authorized.' },
  {
    decisionsClient: createDecisionsClient({ apiKey: env.OPENAI_API_KEY }),
    idFactory: () => decisionId,
    signal: AbortSignal.timeout(45_000),
  },
);
```

The package exports TypeScript directly for Node 22 and Cloudflare Workers; no build step is needed for an importer. It uses the fetch API and Web Crypto, with no SDK or Node-only runtime APIs.

- `createReplayClient(recordings)` replays recorded Decisions API responses without network access. It checks the same wire shapes as the live client.
- `PROMPT_SETS.p1` holds wording, budgets and thresholds. It remains a draft until the full W2 engine PR merges; later changes require a new prompt version.
- `synthesize(answers, promptSet)` is pure. A hard commandment guard keeps priority over later consistency signals; malformed or refused guards never authorize alignment.
- `estimateTokens(text)` is the contract's `ceil(text.length / 4)` estimator. `creditsFor(tokens)` returns 1 or 5, or throws `InputTooLargeError` above 1M estimated tokens.
- `EngineError` uses locally authored messages and preserves any completed stages in `.trace`. Provider error bodies and API credentials are never included in error messages.

Caller action and context have random per-request boundaries. Large text is excerpted head and tail to the approved working budget, using conservative ratios informed by live measurements; `basis.truncated` reports this. Those ratios are estimates, not a general tokenizer guarantee. A context-limit error, or a large-input 504, gets one retry with a halved context excerpt, then fails with `input_too_large` if the reduced request still cannot fit. The caller receives a refund through the Worker contract.

The fetch client has 20-second routing and 60-second judge limits, plus one 300–900 ms retry for network errors, 429, and 5xx. A caller-provided `AbortSignal` cancels the whole pipeline including retries; the hosted Worker supplies its total 45-second deadline. All attempts are retained in `decision.usage.calls`; failed calls with no reported usage have zero known tokens, which does not imply zero cost.

Run offline verification:

```sh
pnpm --filter @wwjd/engine test
pnpm --filter @wwjd/engine typecheck
pnpm --filter @wwjd/engine build
```

`build` checks bundling for the browser/Workers environment. Live smoke is separate, reads `OPENAI_API_KEY` from the environment, and writes incremental evidence:

```sh
node engine/scripts/smoke.mjs
```

The smoke set contains the ten original spike cases and 22 additional cases. Its evidence separates wrong verdicts, failed guard expectations, valid refusals, fallback routing, input tokens, latency and estimated provider cost. Production acceptance and deployment remain the orchestrator's responsibility.
