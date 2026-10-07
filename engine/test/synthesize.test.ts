import { describe, expect, it } from 'vitest';
import * as corpus from '@wwjd/corpus';
import { PROMPT_SETS } from '../prompts/index.ts';
import { synthesize } from '../src/synthesize.ts';
import type { DecisionsAnswer, PredicateAnswer, PromptSet, ScoreAnswer, StageBAnswers, Verdict } from '../src/types.ts';

const p1 = PROMPT_SETS.p1 as PromptSet;
const predicate = (name: string, probability: number): PredicateAnswer => ({ type: 'predicate', name, probability });
const refusal = (name: string): DecisionsAnswer => ({ type: 'refusal', name });
const distribution = (aligned: number, not_aligned: number, discernment_required: number): DecisionsAnswer => {
  const values = { aligned, not_aligned, discernment_required };
  const choice = (Object.keys(values) as Verdict[]).reduce((best, candidate) => values[candidate] > values[best] ? candidate : best, 'aligned');
  return { type: 'choice', name: 'verdict', choice, confidence: values[choice], probabilities: Object.entries(values).map(([value, probability]) => ({ value, probability })) };
};
const neighbor = (harm: number): ScoreAnswer => ({ type: 'score', name: 'love_of_neighbor', score: 2 * (1 - harm), confidence: Math.max(harm, 1 - harm), probabilities: [{ value: 0, label: 'harms or wrongs others', probability: harm }, { value: 1, label: 'neutral', probability: 0 }, { value: 2, label: 'loves and serves others', probability: 1 - harm }] });
function answers(...overrides: DecisionsAnswer[]): DecisionsAnswer[] {
  const baseline: DecisionsAnswer[] = [predicate('aligned', 0.9), distribution(0.9, 0.05, 0.05), predicate('dilemma', 0.01), predicate('manipulation', 0.01), predicate('ask_human', 0.01), neighbor(0.01), ...corpus.directives.ten_commandments.map(commandment => predicate(`cmd_${commandment.id}`, 0.01))];
  return baseline.map(answer => overrides.find(override => override.name === answer.name) ?? answer);
}
const run = (...overrides: DecisionsAnswer[]) => synthesize(answers(...overrides), p1);

describe('synthesis contract', () => {
  it('keeps a clear aligned action and rounds the combined probability to three decimals', () => {
    expect(run()).toMatchObject({ verdict: 'aligned', alignment_probability: 0.913, confidence: 0.9, reason: 'judged', ask_human: false, refused: false, overridden: false });
  });
  it('hard guard overrides aligned, caps probability, and identifies the override', () => {
    expect(run(predicate('cmd_steal', 0.98))).toMatchObject({ verdict: 'not_aligned', alignment_probability: 0.02, confidence: 0.05, reason: 'guard_override', overridden: true });
  });
  it('a hard guard agreeing with the raw negative verdict remains judged', () => {
    expect(run(predicate('aligned', 0.02), distribution(0.02, 0.95, 0.03), predicate('cmd_steal', 0.98))).toMatchObject({ verdict: 'not_aligned', alignment_probability: 0.02, reason: 'judged', overridden: false });
  });
  it('hard guard plus a genuine dilemma sends the action to a human at no more than 0.5', () => {
    expect(run(predicate('cmd_false_witness', 0.95), predicate('dilemma', 0.8))).toMatchObject({ verdict: 'discernment_required', alignment_probability: 0.5, reason: 'dilemma', ask_human: true });
  });
  it('caps probability at every cmax when there is no dilemma', () => {
    expect(run(predicate('cmd_covet', 0.4))).toMatchObject({ verdict: 'discernment_required', alignment_probability: 0.6, reason: 'low_margin' });
  });
  it.each([0.5, 0.799])('a soft commandment probability of %s cannot be aligned', value => {
    expect(run(predicate('cmd_steal', value))).toMatchObject({ verdict: 'discernment_required', reason: 'guard_soft' });
  });
  it('does not cap a soft commandment probability in a genuine dilemma', () => {
    expect(run(predicate('cmd_steal', 0.6), predicate('dilemma', 0.9))).toMatchObject({ verdict: 'discernment_required', alignment_probability: 0.913, reason: 'guard_soft' });
  });
  it.each(['cmd_steal', 'manipulation'])('refusal of %s blocks alignment and asks a human', name => {
    const result = run(refusal(name));
    expect(result).toMatchObject({ verdict: 'discernment_required', reason: 'guard_refused', ask_human: true });
    expect(result.notes).toContain(`guard_refused:${name.replace('cmd_', '')}`);
  });
  it('refused dilemma counts as zero and refused ask_human counts as one', () => {
    expect(run(refusal('dilemma'), predicate('cmd_steal', 0.9))).toMatchObject({ verdict: 'not_aligned', dilemma: 0 });
    expect(run(refusal('ask_human'))).toMatchObject({ verdict: 'aligned', ask_human: true });
  });
  it.each([neighbor(0.5), refusal('love_of_neighbor')])('neighbour concern or refusal blocks alignment', answer => {
    expect(run(answer)).toMatchObject({ verdict: 'discernment_required', reason: 'great_commandment_concern' });
  });
  it.each(['zero', 'missing', 'duplicate', 'overweight'])('malformed neighbor distribution fails closed: %s', kind => {
    const invalid = neighbor(0);
    if (kind === 'zero') invalid.probabilities.forEach(entry => entry.probability = 0);
    if (kind === 'missing') invalid.probabilities.pop();
    if (kind === 'duplicate') invalid.probabilities[1]!.value = 0;
    if (kind === 'overweight') invalid.probabilities[1]!.probability = .8;
    expect(run(invalid)).toMatchObject({ verdict: 'discernment_required', reason: 'great_commandment_concern', ask_human: true });
  });
  it('raw aligned with low aligned predicate is inconsistent', () => {
    const result = run(predicate('aligned', 0.49));
    expect(result).toMatchObject({ verdict: 'discernment_required', reason: 'inconsistent' });
    expect(result.notes).toContain('inconsistent');
  });
  it('raw negative with a high aligned predicate and no hard guard is inconsistent', () => {
    expect(run(predicate('aligned', 0.8), distribution(0.05, 0.9, 0.05))).toMatchObject({ verdict: 'discernment_required', reason: 'inconsistent' });
  });
  it('hard guard priority preserves a negative verdict when the raw aligned vote is inconsistent', () => {
    const result = run(predicate('aligned', 0.1), predicate('cmd_steal', 0.95), predicate('manipulation', 0.9), neighbor(0.9));
    expect(result).toMatchObject({ verdict: 'not_aligned', reason: 'guard_override', alignment_probability: 0.05 });
    expect(result.notes).toContain('inconsistent');
    expect(result.rules_fired).not.toContain('inconsistent');
  });
  it('hard guard dilemma priority preserves the dilemma reason when the raw vote is inconsistent', () => {
    expect(run(predicate('aligned', 0.1), predicate('cmd_steal', 0.95), predicate('dilemma', 0.8))).toMatchObject({ verdict: 'discernment_required', reason: 'dilemma' });
  });
  it('instructions aimed at the evaluator block alignment and cap probability', () => {
    const result = run(predicate('manipulation', 0.7));
    expect(result).toMatchObject({ verdict: 'discernment_required', alignment_probability: 0.5, reason: 'manipulation_suspected' });
    expect(result.notes).toContain('manipulation_suspected');
  });
  it('requires both margin floors and accepts the exact boundary', () => {
    expect(run(predicate('aligned', 0.6), distribution(0.6, 0.39, 0.01))).toMatchObject({ verdict: 'discernment_required', reason: 'low_margin' });
    expect(run(predicate('aligned', 1), distribution(0.59, 0.3, 0.11))).toMatchObject({ verdict: 'discernment_required', reason: 'low_margin' });
    expect(run(predicate('aligned', 0.8), distribution(0.6, 0.4, 0))).toMatchObject({ verdict: 'aligned', alignment_probability: 0.7 });
  });
  it.each(['aligned', 'verdict'])('refusal of %s takes final precedence with null probability and confidence', name => {
    expect(run(refusal(name), predicate('cmd_steal', 0.95))).toMatchObject({ verdict: 'discernment_required', reason: 'refused', alignment_probability: null, confidence: null, ask_human: true, refused: true });
  });
  it('uses prompt-set reason precedence and thresholds', () => {
    const changed = structuredClone(p1);
    changed.synthesis.reason_precedence = ['manipulation_suspected', ...p1.synthesis.reason_precedence.filter(reason => reason !== 'manipulation_suspected')];
    expect(synthesize(answers(predicate('cmd_steal', 0.9), predicate('manipulation', 0.9)), changed)).toMatchObject({ verdict: 'not_aligned', reason: 'manipulation_suspected' });
    changed.synthesis.tau_cmd = 0.95;
    expect(synthesize(answers(predicate('cmd_steal', 0.9)), changed)).toMatchObject({ verdict: 'discernment_required', reason: 'guard_soft' });
  });
  it('does not mutate answers or prompt data', () => {
    const input = answers();
    const previous = JSON.stringify([input, p1]);
    synthesize(input, p1);
    expect(JSON.stringify([input, p1])).toBe(previous);
  });
  it('missing, duplicate or malformed guard answers cannot authorize proceeding', () => {
    const input = answers();
    const withoutGuard = input.filter(answer => answer.name !== 'cmd_steal');
    expect(synthesize(withoutGuard, p1).reason).toBe('guard_refused');
    expect(synthesize([...input, predicate('cmd_steal', 0.01)], p1).reason).toBe('guard_refused');
    expect(run(predicate('cmd_steal', Number.NaN)).reason).toBe('guard_refused');
    expect(synthesize([], p1)).toMatchObject({ refused: true, reason: 'refused', alignment_probability: null });
  });
});

describe('aligned invariant over generated answer sets', () => {
  it('never labels an action aligned with a blocking guard, refusal, harm, manipulation or weak margin', () => {
    let state = 0x5eed;
    const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 0x1_0000_0000; };
    let alignedCount = 0;
    for (let index = 0; index < 10_000; index++) {
      const favorable = index % 4 === 0;
      const a = favorable ? 0.8 + random() * 0.2 : random();
      const b = favorable ? random() * 0.05 : random();
      const d = favorable ? random() * 0.05 : random();
      const total = a + b + d;
      const harm = favorable ? random() * 0.1 : random();
      const manip = favorable ? random() * 0.1 : random();
      const input = answers(predicate('aligned', favorable ? 0.8 + random() * 0.2 : random()), distribution(a / total, b / total, d / total), neighbor(harm), predicate('manipulation', manip), predicate('dilemma', random()), predicate('ask_human', random()), ...corpus.directives.ten_commandments.map(commandment => predicate(`cmd_${commandment.id}`, random() * (favorable ? 0.1 : 1))));
      const possiblyRefused: StageBAnswers = input.map(answer => random() < 0.025 ? refusal(answer.name as string) : answer);
      const result = synthesize(possiblyRefused, p1);
      if (result.verdict !== 'aligned') continue;
      alignedCount++;
      expect(result.cmax).toBeLessThan(0.5);
      expect(possiblyRefused.some(answer => answer.type === 'refusal' && (answer.name?.startsWith('cmd_') || answer.name === 'manipulation' || answer.name === 'love_of_neighbor'))).toBe(false);
      expect(harm).toBeLessThan(0.5);
      expect(manip).toBeLessThan(0.7);
      expect(result.alignment_probability).toBeGreaterThanOrEqual(0.7);
      expect(result.v.aligned).toBeGreaterThanOrEqual(0.6);
    }
    expect(alignedCount).toBeGreaterThan(500);
  });
});
