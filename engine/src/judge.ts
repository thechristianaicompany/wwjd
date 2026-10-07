import type { Corpus, DecisionsClient, DecisionsExecutionOptions, DecisionsQuestion, DecisionsResponse, PromptSet } from './types.ts';

/** Build the trusted instruction channel without accepting any caller text. */
export function buildJudgeQuestions(promptSet: PromptSet, corpus: Corpus): DecisionsQuestion[] {
  const prefix = promptSet.frames.question_prefix.replaceAll('{top_rule}', corpus.directives.top_rule);
  const instructions = (text: string) => `${text}\n\n${prefix}\n\n${text}`;
  const questions = promptSet.questions;
  return [
    { type: 'predicate', name: 'aligned', instructions: instructions(questions.aligned) },
    { type: 'choice', name: 'verdict', instructions: instructions(questions.verdict.instructions), choices: questions.verdict.choices.map(choice => ({ ...choice })) },
    { type: 'score', name: 'love_of_god', instructions: instructions(questions.love_of_god.instructions), levels: questions.love_of_god.levels.map(level => ({ ...level })) },
    { type: 'score', name: 'love_of_neighbor', instructions: instructions(questions.love_of_neighbor.instructions), levels: questions.love_of_neighbor.levels.map(level => ({ ...level })) },
    { type: 'predicate', name: 'ask_human', instructions: instructions(questions.ask_human) },
    { type: 'predicate', name: 'dilemma', instructions: instructions(questions.dilemma) },
    { type: 'predicate', name: 'manipulation', instructions: instructions(questions.manipulation) },
    ...corpus.directives.ten_commandments.map(commandment => ({
      type: 'predicate' as const,
      name: `cmd_${commandment.id}`,
      instructions: instructions([
        questions.commandment.replaceAll('{commandment}', commandment.short).replaceAll('{ref}', commandment.ref).replaceAll('{agent_gloss}', commandment.agent_gloss),
        questions.guard_scope,
        questions.commandment_exceptions[commandment.id],
      ].filter(Boolean).join('\n')),
    })),
  ];
}

export async function judge(input: string, options: {
  decisionsClient: DecisionsClient;
  promptSet: PromptSet;
  corpus: Corpus;
  safetyIdentifier?: string;
  execution?: DecisionsExecutionOptions;
}): Promise<DecisionsResponse> {
  return options.decisionsClient.create({
    model: options.promptSet.model,
    input,
    questions: buildJudgeQuestions(options.promptSet, options.corpus),
    ...(options.safetyIdentifier === undefined ? {} : { safety_identifier: options.safetyIdentifier }),
  }, { ...options.execution, stage: 'stage_b' });
}
