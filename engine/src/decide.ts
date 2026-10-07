import * as defaultCorpus from '@wwjd/corpus';
import { DEFAULT_PROMPT_SET_ID, PROMPT_SETS } from '../prompts/index.ts';
import { assemble, responsePassages } from './assemble.ts';
import { createBoundary } from './boundary.ts';
import { EngineError } from './errors.ts';
import { ENGINE_VERSION } from './index.ts';
import { buildJudgeQuestions } from './judge.ts';
import { routeRequest, selectRoute } from './route.ts';
import { formatSummary } from './summary.ts';
import { synthesize } from './synthesize.ts';
import { creditsFor, estimateTokens } from './tokens.ts';
import type { DecideInput, DecideOptions, Decision, DecisionStage, DecisionsBody, DecisionsCall, DecisionsResponse, StageTrace, Trace } from './types.ts';

export async function decide(input: DecideInput, opts: DecideOptions): Promise<{ decision: Decision; trace: Trace }> {
  if (!input || typeof input.action !== 'string' || !input.action.trim() || (input.context !== undefined && typeof input.context !== 'string')) throw new EngineError('invalid_input');
  if (opts.safetyIdentifier !== undefined && (typeof opts.safetyIdentifier !== 'string' || opts.safetyIdentifier.length > 128)) throw new EngineError('invalid_input');
  const caller = { action: input.action.trim(), context: input.context ?? '' };
  const estimated = estimateTokens(caller.action + caller.context);
  creditsFor(estimated);
  const corpus = opts.corpus ?? defaultCorpus;
  const prompts = opts.promptSet ?? PROMPT_SETS[DEFAULT_PROMPT_SET_ID]!;
  const now = opts.now ?? Date.now;
  const started = now();
  const boundary = createBoundary();
  const trace: Partial<Trace> = {};
  const calls: Decision['usage']['calls'] = [];
  const allStageBCalls: DecisionsCall[] = [];
  let stageBLatencyMs = 0;

  async function call(stage: DecisionStage, body: DecisionsBody, extra: Partial<Trace['stage_b']> = {}, largeInput = false): Promise<DecisionsResponse> {
    const began = now();
    const observed: DecisionsCall[] = [];
    const safety = opts.safetyIdentifier === undefined ? {} : { safety_identifier: opts.safetyIdentifier };
    let response: DecisionsResponse;
    try {
      response = await opts.decisionsClient.create({ ...body, ...safety }, {
        stage, signal: opts.signal, retry504: !largeInput, onAttempt: (attempt) => observed.push(attempt),
      });
    } catch (error) {
      const safe = error instanceof EngineError ? error : new EngineError('upstream_error');
      const attempts = safe.calls ?? observed;
      calls.push(...attempts.map((entry) => ({ stage, input_tokens: entry.input_tokens })));
      if (stage === 'stage_b') { allStageBCalls.push(...attempts); stageBLatencyMs += now() - began; }
      const record: StageTrace = {
        answers: [], usage: { input_tokens: attempts.reduce((total, entry) => total + entry.input_tokens, 0) },
        model: body.model, attempts: safe.attempts ?? attempts.length, latency_ms: now() - began, calls: attempts,
      };
      if (stage === 'stage_a') trace.stage_a = record;
      else trace.stage_b = { ...record, input: String(body.input), est_non_caller_tokens: 0, ...extra, calls: [...allStageBCalls], attempts: allStageBCalls.length, latency_ms: stageBLatencyMs, usage: { input_tokens: allStageBCalls.reduce((total, entry) => total + entry.input_tokens, 0) } };
      throw safe;
    }
    const attempts = response.calls ?? (observed.length ? observed : [{ input_tokens: response.usage.input_tokens }]);
    calls.push(...attempts.map((entry) => ({ stage, input_tokens: entry.input_tokens })));
    if (stage === 'stage_b') { allStageBCalls.push(...attempts); stageBLatencyMs += now() - began; }
    const record: StageTrace = { answers: response.answers, usage: response.usage, model: response.model,
      attempts: response.attempts ?? attempts.length, latency_ms: now() - began, calls: attempts };
    if (stage === 'stage_a') trace.stage_a = record;
    else trace.stage_b = { ...record, input: String(body.input), est_non_caller_tokens: 0, ...extra, calls: [...allStageBCalls], attempts: allStageBCalls.length, latency_ms: stageBLatencyMs };
    return response;
  }

  try {
    const routed = await call('stage_a', routeRequest(caller, corpus, prompts, boundary));
    const routing = selectRoute(routed.answers, corpus, prompts);
    let assembled = assemble(caller, routing, corpus, prompts, boundary);
    const judgeBody = (): DecisionsBody => ({ model: prompts.model, input: assembled.input, questions: buildJudgeQuestions(prompts, corpus) });
    let judged: DecisionsResponse;
    try {
      judged = await call('stage_b', judgeBody(), { est_non_caller_tokens: assembled.est_non_caller_tokens }, assembled.predicted_input_tokens > prompts.budgets.large_input_retry_tokens);
    } catch (error) {
      const retryable = error instanceof EngineError && (error.code === 'input_too_large' || (error.upstreamStatus === 504 && assembled.predicted_input_tokens > prompts.budgets.large_input_retry_tokens));
      if (!retryable) throw error;
      assembled = assemble(caller, routing, corpus, prompts, boundary, Math.floor(assembled.context_budget_chars / 2));
      try {
        // The reduced retry must not acquire another generic 504 retry below 500K.
        judged = await call('stage_b', judgeBody(), { est_non_caller_tokens: assembled.est_non_caller_tokens }, true);
      } catch (retryError) {
        if (retryError instanceof EngineError && (retryError.code === 'input_too_large' || retryError.upstreamStatus === 504)) throw new EngineError('input_too_large');
        throw retryError;
      }
    }
    const synthesis = synthesize(judged.answers, prompts);
    trace.synthesis = { pa: synthesis.pa, v: synthesis.v, cmax: synthesis.cmax, dilemma: synthesis.dilemma, manipulation: synthesis.manipulation, rules_fired: synthesis.rules_fired };
    const tenCommandments = corpus.directives.ten_commandments.flatMap((commandment) => {
      const answer = judged.answers.find((entry) => entry.name === `cmd_${commandment.id}`);
      return answer?.type === 'predicate' && answer.probability >= .2 ? [{ id: commandment.id, commandment: commandment.short, ref: commandment.ref, probability: answer.probability }] : [];
    }).sort((a, b) => b.probability - a.probability);
    const score = (name: string) => { const answer = judged.answers.find((entry) => entry.name === name); return answer?.type === 'score' ? answer.score / 2 : null; };
    const decision: Decision = {
      id: opts.idFactory?.() ?? `dec_${crypto.randomUUID().replaceAll('-', '')}`,
      object: 'wwjd.decision', verdict: synthesis.verdict, reason: synthesis.reason, alignment_probability: synthesis.alignment_probability,
      confidence: synthesis.confidence, ask_human: synthesis.ask_human, refused: synthesis.refused, verdict_probabilities: synthesis.v,
      scores: { love_of_god: score('love_of_god'), love_of_neighbor: score('love_of_neighbor') },
      guards: { ten_commandments: tenCommandments, triggered: tenCommandments.filter((entry) => entry.probability >= prompts.synthesis.tau_cmd).map((entry) => entry.id),
        dilemma: synthesis.dilemma, manipulation: synthesis.manipulation, overridden: synthesis.overridden, notes: synthesis.notes },
      basis: { top_rule: corpus.directives.top_rule, directives: assembled.directives, topics: routing.topics, teachings: routing.teachings,
        passages: responsePassages(assembled.passages, corpus, prompts), routing: { fallback: routing.fallback }, truncated: assembled.truncated },
      summary: formatSummary(synthesis, tenCommandments, prompts), model: judged.model, engine_version: ENGINE_VERSION, prompt_version: prompts.id, corpus_version: corpus.corpusVersion,
      usage: { input_tokens: calls.reduce((total, entry) => total + entry.input_tokens, 0), decisions_calls: calls.length, est_input_tokens: estimated, calls },
      latency_ms: now() - started, disclaimer: prompts.disclaimer,
    };
    return { decision, trace: trace as Trace };
  } catch (error) {
    const safe = error instanceof EngineError ? error : new EngineError('upstream_error');
    safe.trace = { ...safe.trace, ...trace };
    throw safe;
  }
}
