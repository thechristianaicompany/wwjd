import { excerpt, wrapCaller } from './boundary.ts';
import type { Corpus, DecideInput, DecisionsAnswer, DecisionsBody, PromptSet } from './types.ts';

export interface RouteSelection {
  topics: { id: string; label: string; probability: number }[];
  teachings: { id: string; name: string; ref: string; probability: number }[];
  fallback: boolean;
}

export function routeRequest(input: DecideInput, corpus: Corpus, prompts: PromptSet, boundary: string): DecisionsBody {
  const maxChars = prompts.budgets.max_route_est_tokens * 4;
  const actionBudget = input.context ? Math.min(input.action.length, Math.floor(maxChars / 2)) : maxChars;
  const action = excerpt(input.action, actionBudget, prompts.frames.omission);
  const context = excerpt(input.context ?? '', maxChars - action.length, prompts.frames.omission);
  return {
    model: prompts.model,
    input: [prompts.frames.route, prompts.frames.boundary_rule.replaceAll('{boundary}', boundary),
      wrapCaller('requested_action', action, boundary), wrapCaller('context', context, boundary)].join('\n\n'),
    questions: [
      { type: 'choice', name: 'topic', instructions: prompts.routing.topic_instructions,
        choices: [...corpus.taxonomy.map((topic) => ({ value: topic.id, description: topic.description })),
          { value: 'none', description: prompts.routing.none_description }] },
      { type: 'choice', name: 'teaching', instructions: prompts.routing.teaching_instructions,
        choices: [...corpus.teachings.map((teaching) => ({ value: teaching.id, description: teaching.description })),
          { value: 'none', description: prompts.routing.none_description }] },
    ],
  };
}

export function selectRoute(answers: DecisionsAnswer[], corpus: Corpus, prompts: PromptSet): RouteSelection {
  let fallback = false;
  function select(name: string, ids: string[], limit: number, fallbackIds: string[]) {
    const answer = answers.find((entry) => entry.name === name);
    const selected = answer?.type === 'choice' ? answer.probabilities
      .filter((entry) => typeof entry.value === 'string' && ids.includes(entry.value) && entry.probability >= prompts.routing.min_probability)
      .sort((a, b) => b.probability - a.probability).slice(0, limit)
      .map((entry) => ({ id: entry.value as string, probability: entry.probability })) : [];
    if (selected.length > 0) return selected;
    fallback = true;
    return fallbackIds.filter((id) => ids.includes(id)).slice(0, limit).map((id) => ({ id, probability: 0 }));
  }
  const topics = select('topic', corpus.taxonomy.map((entry) => entry.id), prompts.routing.max_topics, prompts.routing.fallback_topics)
    .map((entry) => ({ ...entry, label: corpus.taxonomy.find((topic) => topic.id === entry.id)!.label }));
  const teachings = select('teaching', corpus.teachings.map((entry) => entry.id), prompts.routing.max_teachings, prompts.routing.fallback_teachings)
    .map((entry) => { const teaching = corpus.teachings.find((item) => item.id === entry.id)!; return { ...entry, name: teaching.name, ref: teaching.ref }; });
  return { topics, teachings, fallback };
}
