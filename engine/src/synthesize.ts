import type { DecisionsAnswer, DecisionReason, PromptSet, StageBAnswers, Synthesis, Verdict } from './types.ts';

const COMMANDMENTS = ['one_god', 'no_idols', 'name_in_vain', 'sabbath', 'honor_parents', 'murder', 'adultery', 'steal', 'false_witness', 'covet'];
const VERDICTS: Verdict[] = ['aligned', 'not_aligned', 'discernment_required'];
const round3 = (value: number) => Math.round(value * 1_000) / 1_000;
const probability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

/** Apply the contract's ordered rules without performing I/O or changing answers. */
export function synthesize(answers: StageBAnswers, promptSet: PromptSet): Synthesis {
  // Missing, duplicate, or malformed answers cannot silently authorize an action.
  const indexed = new Map<string, DecisionsAnswer | undefined>();
  for (const answer of answers) {
    if (typeof answer.name !== 'string') continue;
    indexed.set(answer.name, indexed.has(answer.name) ? undefined : answer);
  }
  const predicate = (name: string): number | null => {
    const answer = indexed.get(name);
    return answer?.type === 'predicate' && probability(answer.probability) ? answer.probability : null;
  };
  const pa = predicate('aligned');
  const verdictAnswer = indexed.get('verdict');
  const v: Record<Verdict, number> = { aligned: 0, not_aligned: 0, discernment_required: 0 };
  let verdictRefused = verdictAnswer?.type !== 'choice';
  if (verdictAnswer?.type === 'choice') {
    for (const verdict of VERDICTS) {
      const matching = verdictAnswer.probabilities.filter(item => item.value === verdict);
      const entry = matching[0];
      if (matching.length !== 1 || !entry || !probability(entry.probability)) verdictRefused = true;
      else v[verdict] = entry.probability;
    }
    if (Math.abs(v.aligned + v.not_aligned + v.discernment_required - 1) > 0.001) verdictRefused = true;
  }
  const raw = VERDICTS.reduce((best, candidate) => v[candidate] > v[best] ? candidate : best, 'aligned');
  let verdict: Verdict = raw;
  let ap = round3(0.5 * (pa ?? 0) + 0.5 * (v.aligned + 0.5 * v.discernment_required));
  const notes: string[] = [];
  const rules = new Set<DecisionReason>();
  const thresholds = promptSet.synthesis;
  const cmdNames = new Set([...COMMANDMENTS.map(id => `cmd_${id}`), ...[...indexed.keys()].filter(name => name.startsWith('cmd_'))]);
  const commands = [...cmdNames].map(name => ({ name, value: predicate(name) }));
  const cmax = Math.max(0, ...commands.map(command => command.value ?? 0));
  const dilemma = predicate('dilemma') ?? 0;
  const manipulationAnswer = predicate('manipulation');
  const manipulation = manipulationAnswer ?? 0;
  const askHumanP = predicate('ask_human') ?? 1;
  let overridden = false;
  const hardGuardFired = cmax >= thresholds.tau_cmd;

  if (hardGuardFired) {
    if (dilemma < thresholds.tau_dilemma) {
      verdict = 'not_aligned';
      ap = Math.min(ap, round3(1 - cmax));
      overridden = raw !== 'not_aligned';
      if (overridden) rules.add('guard_override');
    } else {
      verdict = 'discernment_required';
      ap = Math.min(ap, 0.5);
      rules.add('dilemma');
    }
  }
  if (dilemma < thresholds.tau_dilemma) ap = Math.min(ap, round3(1 - cmax));

  const blockAligned = (reason: DecisionReason) => {
    if (verdict === 'aligned') verdict = 'discernment_required';
    rules.add(reason);
  };
  if (cmax >= thresholds.tau_cmd_soft && cmax < thresholds.tau_cmd) blockAligned('guard_soft');

  const refusedGuards = commands.filter(command => command.value === null).map(command => command.name.slice(4));
  if (manipulationAnswer === null) refusedGuards.push('manipulation');
  if (refusedGuards.length > 0) {
    blockAligned('guard_refused');
    notes.push(...refusedGuards.map(id => `guard_refused:${id}`));
  }

  const neighbor = indexed.get('love_of_neighbor');
  const harmEntries = neighbor?.type === 'score' ? neighbor.probabilities.filter(item => item.value === 0) : [];
  const harm = harmEntries[0];
  const validNeighbor = neighbor?.type === 'score' && neighbor.probabilities.length === 3
    && [0, 1, 2].every(value => neighbor.probabilities.filter(item => item.value === value && probability(item.probability)).length === 1)
    && Math.abs(neighbor.probabilities.reduce((total, item) => total + item.probability, 0) - 1) <= 0.001;
  const neighborRefused = !validNeighbor || harmEntries.length !== 1 || !harm || !probability(harm.probability);
  if (neighborRefused || harm.probability >= thresholds.tau_neighbor) blockAligned('great_commandment_concern');

  const inconsistent = pa !== null && ((raw === 'aligned' && pa < 0.5) || (raw === 'not_aligned' && pa > 0.5 && cmax < thresholds.tau_cmd));
  if (inconsistent) {
    notes.push('inconsistent');
    // A hard commandment guard has priority over the weaker consistency signal.
    if (!hardGuardFired) {
      verdict = 'discernment_required';
      rules.add('inconsistent');
    }
  }
  if (manipulation >= thresholds.tau_manip) {
    notes.push('manipulation_suspected');
    blockAligned('manipulation_suspected');
    ap = Math.min(ap, 0.5);
  }
  if (verdict === 'aligned' && (ap < thresholds.alignment_probability_floor || v.aligned < thresholds.verdict_aligned_floor)) blockAligned('low_margin');

  const refused = pa === null || verdictRefused;
  if (refused) {
    verdict = 'discernment_required';
    rules.add('refused');
  }
  if (rules.size === 0) rules.add('judged');
  const reason = thresholds.reason_precedence.find(candidate => rules.has(candidate)) ?? 'judged';
  return {
    verdict,
    alignment_probability: refused ? null : ap,
    confidence: refused ? null : v[verdict],
    reason,
    refused,
    ask_human: refused || refusedGuards.length > 0 || verdict !== 'aligned' || askHumanP >= 0.5,
    overridden,
    notes,
    pa,
    v,
    cmax,
    dilemma,
    manipulation,
    rules_fired: [...rules],
  };
}
