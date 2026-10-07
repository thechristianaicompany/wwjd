import { readFile, writeFile } from 'node:fs/promises';
import * as corpus from '@wwjd/corpus';
import { createDecisionsClient, synthesize } from '../src/index.ts';
import { buildJudgeQuestions } from '../src/judge.ts';
import { createBudgetedClient } from './live-budget.mjs';

const source = process.argv[2];
const output = process.argv[3];
if (!source || !output) throw new Error('Usage: frame-ab.mjs <smoke.json> <output.json>');
const baseline = JSON.parse(await readFile(source, 'utf8'));
const prompts = baseline.prompt_set;
if (baseline.results.some((entry) => entry.decision?.corpus_version !== corpus.corpusVersion)) throw new Error('Corpus differs from recorded input.');
const client = createDecisionsClient({ apiKey: process.env.OPENAI_API_KEY ?? '' });
const report = { started_at: new Date().toISOString(), source, corpus_version: corpus.corpusVersion, prompt_set: prompts,
  method: 'Paired Stage B calls use identical recorded routing, Scripture, caller text and questions. Only the approved faithful-servant frame line is removed for B. Order alternates by case. No Stage A calls are made.', results: [], cost_usd: 0, conservative_cost_usd: 0 };
const budgetedClient = createBudgetedClient({ client, capUsd: .3, onUpdate: async (budget) => {
  report.cost_usd = budget.known_usage_cost_usd;
  report.conservative_cost_usd = budget.conservative_cost_usd;
  report.budget = budget;
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
} });
for (const [index, entry] of baseline.results.entries()) {
  if (!entry.trace?.stage_b?.input) continue;
  const row = { id: entry.id, expected: entry.expected, variants: {} };
  for (const variant of index % 2 ? ['without_frame', 'approved_frame'] : ['approved_frame', 'without_frame']) {
    const frame = prompts.frames.faithful_servant;
    const input = variant === 'approved_frame' ? entry.trace.stage_b.input : entry.trace.stage_b.input.replace(frame, '');
    if (variant === 'without_frame' && input === entry.trace.stage_b.input) throw new Error('Frame not found in baseline input.');
    const began = Date.now();
    try {
      const response = await budgetedClient.create({ model: prompts.model, input, questions: buildJudgeQuestions(prompts, corpus) }, { stage: 'stage_b' });
      row.variants[variant] = { response, synthesis: synthesize(response.answers, prompts), latency_ms: Date.now() - began };
    } catch (error) {
      row.variants[variant] = { error: error.code ?? 'unknown_error', latency_ms: Date.now() - began };
    }
  }
  report.results.push(row);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ id: row.id, approved: row.variants.approved_frame.synthesis?.verdict, without: row.variants.without_frame.synthesis?.verdict }));
}
report.finished_at = new Date().toISOString();
await writeFile(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output, cost_usd: report.cost_usd, conservative_cost_usd: report.conservative_cost_usd }));
