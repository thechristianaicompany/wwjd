/** Wire types mirror the Decisions API; caller text belongs only in `input`. */
export type Verdict = 'aligned' | 'not_aligned' | 'discernment_required';
export type DecisionReason = 'judged' | 'dilemma' | 'guard_override' | 'guard_soft' | 'guard_refused' | 'great_commandment_concern' | 'inconsistent' | 'manipulation_suspected' | 'low_margin' | 'refused';
export type DecisionStage = 'stage_a' | 'stage_b';
export type EngineErrorCode = 'input_too_large' | 'upstream_auth' | 'upstream_rate_limited' | 'upstream_error' | 'upstream_timeout' | 'invalid_input';

export interface PredicateQuestion { type: 'predicate'; name: string; instructions: string }
export interface ChoiceQuestion { type: 'choice'; name: string; instructions: string; choices: { value: string | boolean; description?: string }[] }
export interface ScoreQuestion { type: 'score'; name: string; instructions: string; levels: { label: string; description?: string }[] }
export type DecisionsQuestion = PredicateQuestion | ChoiceQuestion | ScoreQuestion;
export interface PredicateAnswer { type: 'predicate'; name: string | null; probability: number }
export interface ChoiceAnswer { type: 'choice'; name: string | null; choice: string | boolean; confidence: number; probabilities: { value: string | boolean; probability: number }[] }
export interface ScoreAnswer { type: 'score'; name: string | null; score: number; confidence: number; probabilities: { value: number; label: string; probability: number }[] }
export interface RefusalAnswer { type: 'refusal'; name: string | null }
export type DecisionsAnswer = PredicateAnswer | ChoiceAnswer | ScoreAnswer | RefusalAnswer;
export type StageBAnswers = readonly DecisionsAnswer[];

export interface DecisionsBody {
  model: string;
  input: string | { role: 'user'; type?: 'message'; content: string | { type: 'input_text'; text: string }[] }[];
  questions: DecisionsQuestion[];
  safety_identifier?: string;
}
export interface DecisionsUsage {
  input_tokens: number;
  input_tokens_details?: { cached_tokens: number; cache_write_tokens: number };
  output_tokens?: number;
  output_tokens_details?: { reasoning_tokens: number };
  total_tokens?: number;
}
/** Failed upstream calls have zero known tokens; no usage is inferred. */
export interface DecisionsCall { input_tokens: number; status?: number; latency_ms?: number }
export interface DecisionsResponse {
  answers: DecisionsAnswer[];
  usage: DecisionsUsage;
  model: string;
  attempts?: number;
  calls?: DecisionsCall[];
}
export interface DecisionsExecutionOptions {
  stage?: DecisionStage;
  signal?: AbortSignal;
  onAttempt?: (call: DecisionsCall) => void;
  /** False lets the pipeline excerpt a large input before its sole 504 retry. */
  retry504?: boolean;
}
export interface DecisionsClient { create(body: DecisionsBody, options?: DecisionsExecutionOptions): Promise<DecisionsResponse> }

export interface PromptSet {
  id: string;
  model: string;
  frames: { route: string; data_rule: string; boundary_rule: string; faithful_servant: string; question_prefix: string; trusted_closing: string; omission: string };
  labels: { great_commandments: string; ten_commandments: string; routed_teachings: string; routed_scripture: string; broader_context: string };
  routing: { max_topics: number; max_teachings: number; min_probability: number; fallback_topics: string[]; fallback_teachings: string[]; topic_instructions: string; teaching_instructions: string; none_description: string };
  budgets: {
    max_route_est_tokens: number; max_scripture_est_tokens: number; max_stage_b_est_tokens: number;
    repeat_action_max_est_tokens: number; response_passages_with_text: number; response_passage_max_chars: number;
    model_working_tokens: number; real_to_estimated_token_ratios: { ascii: number; non_ascii: number }; large_input_retry_tokens: number;
  };
  broader_context: { enabled: boolean; book: string; chapters: number[] };
  questions: {
    aligned: string; ask_human: string; dilemma: string; manipulation: string; commandment: string; guard_scope: string;
    verdict: { instructions: string; choices: { value: string; description: string }[] };
    love_of_god: { instructions: string; levels: { label: string; description: string }[] };
    love_of_neighbor: { instructions: string; levels: { label: string; description: string }[] };
    commandment_exceptions: Record<string, string>;
  };
  synthesis: {
    tau_cmd: number; tau_dilemma: number; tau_cmd_soft: number; tau_neighbor: number; tau_manip: number;
    alignment_probability_floor: number; verdict_aligned_floor: number; reason_precedence: DecisionReason[];
  };
  summary_templates: Record<DecisionReason, string>;
  summary_strings: { verdict_labels: Record<string, string>; proceed: string; ask_human: string; commandment_concern: string };
  disclaimer: string;
}
export type Corpus = Pick<typeof import('@wwjd/corpus'), 'directives' | 'taxonomy' | 'teachings' | 'getPack' | 'getTeachingText' | 'getVerses' | 'corpusVersion'>;
export interface DecideInput { action: string; context?: string }
export interface DecideOptions {
  decisionsClient: DecisionsClient;
  promptSet?: PromptSet;
  corpus?: Corpus;
  safetyIdentifier?: string;
  now?: () => number;
  idFactory?: () => string;
  /** Cancels both stages and retry waits under the caller's total deadline. */
  signal?: AbortSignal;
}
export interface Synthesis {
  verdict: Verdict;
  alignment_probability: number | null;
  confidence: number | null;
  reason: DecisionReason;
  refused: boolean;
  ask_human: boolean;
  overridden: boolean;
  notes: string[];
  pa: number | null;
  v: Record<Verdict, number>;
  cmax: number;
  dilemma: number;
  manipulation: number;
  rules_fired: DecisionReason[];
}
export interface StageTrace {
  answers: DecisionsAnswer[];
  usage: DecisionsUsage;
  model: string;
  attempts: number;
  latency_ms: number;
  calls?: DecisionsCall[];
}
export interface Trace {
  stage_a: StageTrace;
  stage_b: StageTrace & { input: string; est_non_caller_tokens: number };
  synthesis: Pick<Synthesis, 'pa' | 'v' | 'cmax' | 'dilemma' | 'manipulation' | 'rules_fired'>;
}
export interface BasisPassage { ref: string; full_ref?: string; title?: string; kind: 'jesus_teaching' | 'nt' | 'ot'; topic?: string; text?: string }
export interface Decision {
  id: string;
  object: 'wwjd.decision';
  verdict: Verdict;
  reason: DecisionReason;
  alignment_probability: number | null;
  confidence: number | null;
  ask_human: boolean;
  refused: boolean;
  verdict_probabilities: Record<Verdict, number>;
  scores: { love_of_god: number | null; love_of_neighbor: number | null };
  guards: {
    ten_commandments: { id: string; commandment: string; ref: string; probability: number }[];
    triggered: string[];
    dilemma: number;
    manipulation: number;
    overridden: boolean;
    notes: string[];
  };
  basis: {
    top_rule: string;
    directives: { ref: string; text: string }[];
    topics: { id: string; label: string; probability: number }[];
    teachings: { id: string; name: string; ref: string; probability: number }[];
    passages: BasisPassage[];
    routing: { fallback: boolean };
    truncated: boolean;
  };
  summary: string;
  model: string;
  engine_version: string;
  prompt_version: string;
  corpus_version: string;
  usage: { input_tokens: number; decisions_calls: number; est_input_tokens: number; calls: { stage: DecisionStage; input_tokens: number }[] };
  latency_ms: number;
  disclaimer: string;
}
