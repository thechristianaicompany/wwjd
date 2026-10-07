import { excerpt, neutralizeCallerText, wrapCaller } from './boundary.ts';
import { InputTooLargeError } from './errors.ts';
import { buildJudgeQuestions } from './judge.ts';
import { estimateTokens } from './tokens.ts';
import type { BasisPassage, Corpus, DecideInput, PromptSet } from './types.ts';
import type { RouteSelection } from './route.ts';
import type { Passage, Verse } from '@wwjd/corpus';

export interface SelectedPassage extends Passage { full_ref?: string; topic?: string }
export interface Assembly {
  input: string;
  est_non_caller_tokens: number;
  context_budget_chars: number;
  predicted_input_tokens: number;
  truncated: boolean;
  directives: Verse[];
  passages: SelectedPassage[];
}

function rangeRef(verses: Verse[]): string {
  const first = verses[0]!.ref;
  const last = verses.at(-1)!.ref;
  if (first === last) return first;
  const firstPrefix = first.slice(0, first.lastIndexOf(':'));
  const lastPrefix = last.slice(0, last.lastIndexOf(':'));
  return first + '-' + (firstPrefix === lastPrefix ? last.split(':').at(-1) : last.slice(last.lastIndexOf(' ') + 1));
}

/** Scripture cuts always return complete, verbatim verses and an honest displayed range. */
export function cutPassage(passage: SelectedPassage, maxChars: number, corpus: Corpus, atLeastOne = false): SelectedPassage | undefined {
  if (passage.text.length <= maxChars) return { ...passage };
  const verses = corpus.getVerses([passage.ref]);
  const kept: Verse[] = [];
  let length = 0;
  for (const verse of verses) {
    const addition = verse.text.length + (kept.length ? 1 : 0);
    if (length + addition > maxChars && !(atLeastOne && !kept.length)) break;
    kept.push(verse); length += addition;
  }
  if (!kept.length) return undefined;
  const text = kept.map((verse) => verse.text).join(' ');
  return { ...passage, ref: rangeRef(kept), ...(kept.length < verses.length ? { full_ref: passage.full_ref ?? passage.ref } : {}), text };
}

export function assemble(input: DecideInput, route: RouteSelection, corpus: Corpus, prompts: PromptSet, boundary: string, contextBudgetChars?: number): Assembly {
  const passages: SelectedPassage[] = [];
  const seen = new Set<string>();
  const scriptureParts: string[] = [];
  let scriptureChars = 0;
  const limit = prompts.budgets.max_scripture_est_tokens * 4;
  function add(passage: SelectedPassage, mandatory = false) {
    if (seen.has(passage.ref)) return;
    const heading = `[${passage.ref}${passage.title ? ` — ${passage.title}` : ''}]\n`;
    const remaining = limit - scriptureChars - heading.length - 2;
    const fitted = cutPassage(passage, remaining, corpus);
    if (!fitted) { if (mandatory) throw new InputTooLargeError(); return; }
    const rendered = `[${fitted.ref}${fitted.title ? ` — ${fitted.title}` : ''}]\n${fitted.text}`;
    scriptureParts.push(rendered); scriptureChars += rendered.length + 2;
    passages.push(fitted); seen.add(passage.ref);
  }
  function label(text: string) { if (scriptureChars + text.length + 2 <= limit) { scriptureParts.push(text); scriptureChars += text.length + 2; } }
  const directives = [...corpus.directives.great_commandments, corpus.directives.new_commandment, corpus.directives.golden_rule];
  label(prompts.labels.great_commandments);
  for (const verse of directives) add({ ...verse, kind: 'jesus_teaching' }, true);
  label(prompts.labels.ten_commandments);
  add({ ...corpus.directives.ten_commandments_passage, title: prompts.labels.ten_commandments, kind: 'ot' }, true);
  label(prompts.labels.routed_teachings);
  for (const teaching of route.teachings) {
    const text = corpus.getTeachingText(teaching.id);
    if (text) add({ ref: teaching.ref, text, title: teaching.name, kind: 'jesus_teaching' });
  }
  label(prompts.labels.routed_scripture);
  for (const topic of route.topics) for (const passage of corpus.getPack(topic.id)?.passages ?? []) add({ ...passage, topic: topic.id });
  if (prompts.broader_context.enabled) {
    label(prompts.labels.broader_context);
    for (const topic of route.topics) {
      for (const ref of corpus.taxonomy.find((item) => item.id === topic.id)?.anchors ?? []) {
        const match = /^(.*?) (\d+):/.exec(ref);
        if (match?.[1] === prompts.broader_context.book && prompts.broader_context.chapters.includes(Number(match[2]))) {
          add({ ref, text: corpus.getVerses([ref]).map((verse) => verse.text).join(' '), kind: 'jesus_teaching', topic: topic.id });
        }
      }
    }
  }
  const rule = corpus.directives.top_rule;
  const frame = [rule, prompts.frames.data_rule, prompts.frames.boundary_rule.replaceAll('{boundary}', boundary), prompts.frames.faithful_servant].filter(Boolean).join('\n');
  const repeat = estimateTokens(input.action) <= prompts.budgets.repeat_action_max_est_tokens;
  const closing = prompts.frames.trusted_closing.replaceAll('{top_rule}', rule);
  function render(action: string, context: string) {
    return [frame, wrapCaller('requested_action', action, boundary), wrapCaller('context', context, boundary), ...scriptureParts,
      ...(repeat ? [wrapCaller('requested_action', action, boundary)] : []), closing].join('\n\n');
  }
  const ratio = (text: string) => /^[\x00-\x7F]*$/.test(text)
    ? prompts.budgets.real_to_estimated_token_ratios.ascii : prompts.budgets.real_to_estimated_token_ratios.non_ascii;
  const nonCaller = render('', '');
  const questions = JSON.stringify(buildJudgeQuestions(prompts, corpus));
  // These are measured conservative estimates, not a tokenizer or a proof for every script.
  const fixedReal = Math.ceil(estimateTokens(nonCaller + questions) * ratio(nonCaller + questions));
  const fixedEst = estimateTokens(nonCaller);
  let availableChars = Math.max(0, (prompts.budgets.max_stage_b_est_tokens - fixedEst) * 4);
  let availableReal = Math.max(0, prompts.budgets.model_working_tokens - fixedReal);
  if (fixedEst > prompts.budgets.max_stage_b_est_tokens || fixedReal > prompts.budgets.model_working_tokens) throw new InputTooLargeError();
  function fit(text: string, copies: number, capChars = Infinity) {
    const tokenRatio = ratio(text);
    let budget = Math.max(0, Math.floor(Math.min(availableChars / copies, availableReal * 4 / tokenRatio / copies, capChars)));
    let fitted = excerpt(text, budget, prompts.frames.omission);
    while (true) {
      const expanded = neutralizeCallerText(fitted).length;
      const excess = Math.max(expanded * copies - availableChars, (Math.ceil(expanded / 4) * tokenRatio * copies - availableReal) * 4 / tokenRatio);
      if (excess <= 0 || budget === 0) break;
      budget = Math.max(0, budget - Math.max(1, Math.ceil(excess)));
      fitted = excerpt(text, budget, prompts.frames.omission);
    }
    const expanded = neutralizeCallerText(fitted).length;
    availableChars -= expanded * copies;
    availableReal -= Math.ceil(expanded / 4) * tokenRatio * copies;
    return { text: fitted, budget, predicted: Math.ceil(expanded / 4) * tokenRatio * copies };
  }
  const action = fit(input.action, repeat ? 2 : 1);
  const context = fit(input.context ?? '', 1, contextBudgetChars);
  const repeatedAction = repeat ? neutralizeCallerText(action.text) : '';
  return { input: render(action.text, context.text), est_non_caller_tokens: estimateTokens(nonCaller + questions + repeatedAction),
    context_budget_chars: Math.min(context.budget, (input.context ?? '').length), predicted_input_tokens: Math.ceil(fixedReal + action.predicted + context.predicted),
    truncated: action.text !== input.action || context.text !== (input.context ?? ''), directives, passages };
}

export function responsePassages(passages: SelectedPassage[], corpus: Corpus, prompts: PromptSet): BasisPassage[] {
  return passages.map((passage, i) => {
    if (i < prompts.budgets.response_passages_with_text) return cutPassage(passage, prompts.budgets.response_passage_max_chars, corpus, true)!;
    return { ref: passage.ref, ...(passage.full_ref ? { full_ref: passage.full_ref } : {}), ...(passage.title ? { title: passage.title } : {}), kind: passage.kind };
  });
}
