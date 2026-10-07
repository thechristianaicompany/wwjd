const encoder = new TextEncoder();
const finiteTokens = value => Number.isSafeInteger(value) && value >= 0;
const knownCost = tokens => tokens / 1e6 * (tokens > 272_000 ? .20 : .10);
const fail = (code, message) => Object.assign(new Error(message), { code });

/** Text-only live-script budget. Persist reservations before the provider can run. */
export function createBudgetedClient({ client, capUsd, onUpdate = async () => {} }) {
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new RangeError('A positive finite live budget is required.');
  let knownUsage = 0;
  let conservative = 0;
  let pending = 0;
  let busy = false;
  const snapshot = () => ({ cap_usd: capUsd, known_usage_cost_usd: knownUsage, conservative_cost_usd: conservative, pending_reservation_usd: pending });
  return {
    snapshot,
    get known_usage_cost_usd() { return knownUsage; },
    get conservative_cost_usd() { return conservative; },
    get pending_reservation_usd() { return pending; },
    async create(body, options = {}) {
      if (busy) throw fail('live_budget_busy', 'Budgeted live calls must run serially.');
      const serialized = JSON.stringify(body);
      const request = serialized && JSON.parse(serialized);
      const textInput = typeof request?.input === 'string' || (Array.isArray(request?.input) && request.input.every(message => message.role === 'user' && (typeof message.content === 'string' || (Array.isArray(message.content) && message.content.every(part => part.type === 'input_text' && typeof part.text === 'string')))));
      if (!textInput || typeof request.model !== 'string' || !Array.isArray(request.questions) || !request.questions.length) throw fail('live_budget_invalid_input', 'The live budget wrapper supports text Decisions requests only.');
      // Byte count bounds text tokens; fixed and per-question reserves cover framing.
      const perAttempt = (encoder.encode(serialized).byteLength + 8_192 + 512 * request.questions.length) / 1e6 * .20;
      const reserved = perAttempt * 2; // The Decisions client sends at most two attempts.
      if (conservative + reserved > capUsd) throw fail('live_budget_exceeded', 'The next request would exceed the conservative live budget.');
      busy = true;
      conservative += reserved;
      pending += reserved;
      try {
        try { await onUpdate(snapshot()); }
        catch (error) { conservative -= reserved; pending -= reserved; throw error; }
        const observed = [];
        let response;
        let failure;
        let resolved = false;
        try {
          response = await client.create(request, { ...options, onAttempt(call) { observed.push({ ...call }); options.onAttempt?.(call); } });
          resolved = true;
        } catch (error) { failure = error; }
        const result = resolved ? response : failure;
        const completeCalls = Array.isArray(result?.calls);
        const recorded = completeCalls ? result.calls : observed;
        const calls = [...recorded];
        const declared = finiteTokens(result?.attempts) ? result.attempts : undefined;
        const count = Math.max(calls.length, declared ?? (completeCalls ? calls.length : 2), resolved ? 1 : 0);
        // Bare responses establish final usage, but cannot prove an earlier retry was unsent.
        if (resolved && finiteTokens(response?.usage?.input_tokens) && !calls[count - 1]) calls[count - 1] = { input_tokens: response.usage.input_tokens, status: 200 };
        let settled = 0;
        let knownThisCall = 0;
        for (let index = 0; index < count; index++) {
          const call = calls[index];
          const succeeded = resolved && index === count - 1 && ((call?.status >= 200 && call?.status < 300) || call?.status === undefined);
          const known = finiteTokens(call?.input_tokens) && (call.input_tokens > 0 || succeeded);
          const cost = known ? knownCost(call.input_tokens) : perAttempt;
          settled += cost;
          if (known) knownThisCall += cost;
        }
        conservative += settled - reserved;
        pending -= reserved;
        knownUsage += knownThisCall;
        await onUpdate(snapshot());
        if (!resolved) throw failure;
        return response;
      } finally { busy = false; }
    },
  };
}
