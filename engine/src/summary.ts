import type { Decision, PromptSet, Synthesis } from './types.ts';

export function formatSummary(synthesis: Synthesis, guards: Decision['guards']['ten_commandments'], prompts: PromptSet): string {
  const concern = guards[0];
  const concernText = (guard: Decision['guards']['ten_commandments'][number]) => prompts.summary_strings.commandment_concern
    .replaceAll('{commandment}', guard.commandment.replace(/\.$/, '')).replaceAll('{ref}', guard.ref);
  const values: Record<string, string> = {
    verdict_label: prompts.summary_strings.verdict_labels[synthesis.verdict]!,
    percentage: synthesis.alignment_probability === null ? '' : String(Math.round(synthesis.alignment_probability * 100)),
    commandment_concern: concern ? concernText(concern) : '',
    next_step: synthesis.ask_human ? prompts.summary_strings.ask_human : prompts.summary_strings.proceed,
  };
  let summary = prompts.summary_templates[synthesis.reason].replace(/\{([a-z_]+)\}/g, (whole, key: string) => values[key] ?? whole);
  const triggered = guards.find(guard => guard.probability >= prompts.synthesis.tau_cmd);
  if (triggered && synthesis.reason !== 'refused' && synthesis.reason !== 'manipulation_suspected') {
    const text = concernText(triggered).trim();
    if (!summary.includes(text)) summary += ` ${text}`;
  }
  return summary;
}
