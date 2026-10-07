# WWJD API

Hosted base: `https://findjevsus.com`. Send JSON bodies with `Content-Type: application/json`. Authenticated routes take `Authorization: Bearer <WWJD_API_KEY>`; never put the key in a URL or caller text. The script reads the environment/key file so keys need not appear in shell arguments.

## Decision

`POST /v1/wwjd`:

```json
{
  "action": "Delete the old backup directory to free space for the project owner.",
  "context": "The human asked to free space but did not authorize deleting this backup. No second copy has been verified."
}
```

`action` is a nonempty string. `context` is an optional string. The body limit is 8 MB. The token estimate is `ceil((action + context).length / 4)`: up to 100,000 costs 1 credit, up to 1,000,000 costs 5, above that returns 413. The hosted service can adjust the charge using the model's actual caller-token count. Engine/upstream failures are refunded; a valid refusal is charged.

A 200 response has:

| Field | Meaning |
| --- | --- |
| `id`, `object` | Decision ID (`dec_…`); object is `wwjd.decision`. |
| `verdict` | `aligned`, `not_aligned`, or `discernment_required`. |
| `reason` | Why the verdict was reached, including guard, dilemma, or judgment reasons. |
| `alignment_probability` | Estimated alignment, 0–1. |
| `confidence`, `verdict_probabilities` | Probability of the returned verdict, and the three verdict probabilities; confidence is null when refused. |
| `ask_human`, `refused` | Boolean pause advice and evaluation refusal. Refusal is no usable verdict. |
| `scores` | Normalized `love_of_god` and `love_of_neighbor` scores. |
| `guards` | `ten_commandments`, `triggered`, `dilemma`, `manipulation`, `overridden`, and `notes`. Commandments are identified by text and reference, never ordinal. |
| `basis` | `top_rule`, `directives`, `topics`, `teachings`, `passages`, `routing.fallback`, and `truncated`. |
| `summary` | Short explanation attributed to WWJD. |
| `credits` | Hosted only: `charged`, `remaining`, `plan`. |
| `model`, `engine_version`, `prompt_version`, `corpus_version` | Version identity of this decision. |
| `usage`, `latency_ms` | Input token counts, Decisions call counts, per-call usage, and elapsed server time. |
| `retention`, `disclaimer` | Storage disclosure and experiment disclaimer. |

The first six `basis.passages` can include verbatim WEB text. Text is shortened only at verse boundaries; `ref` names the verses shown and `full_ref`, when present, names the original range. Later passages may have references only. `basis.truncated: true` means context was excerpted to fit the model's input limit.

Interpret behavior with [verdicts.md](verdicts.md); HTTP 200 alone is not permission.

## Key registration

`GET /v1/keys/challenge` returns `challenge`, `difficulty` (leading zero bits), and `expires_at`. Solve SHA-256 over UTF-8 `challenge + ":" + nonce`, where `nonce` is a decimal string of at most 32 characters. Count zero bits from the most significant bit of the first digest byte.

`POST /v1/keys` takes `{challenge, nonce, label?}`. It returns 201 with `key`, `key_id`, `plan`, `credits`, and `note`. The key is shown once and grants 10 free credits. A challenge is single use and expires after ten minutes. Registration is rate-limited and has a daily per-IP cap.

The script auto-registers only when no hosted key exists. Lookup: `WWJD_API_KEY` → `$WWJD_CONFIG_DIR/key` → `~/.config/wwjd/key` → project-local `.wwjd/key` when the home path is not writable. It saves privately and prints only a prefix and path. An empty, unreadable, or invalid existing key must be repaired by its owner, not silently replaced with a new free key. Registration 429 directs the human to https://findjevsus.com/docs and `WWJD_API_KEY`.

A parsed JSON error envelope from `POST /v1/keys`, including 503, is a definitive refusal: the script releases `key.lock`. Any registration 429 also releases it, even if the body is not JSON. A network failure, timeout, or non-JSON 5xx can leave registration uncertain; the script keeps a `needs_recovery` lock and prints its absolute path for the human to inspect. It does not create another key while that lock remains.

## Account, feedback, and purchase links

| Route | Request | Success |
| --- | --- | --- |
| `GET /v1/me` | Bearer only | `key_id`, `prefix`, `plan`, `credits_remaining`, `period_end`, `created_at`, `decisions_last_30d`. |
| `POST /v1/feedback` | `decision_id`, `expected_verdict`, `note` (at most 2,000 characters) | 202 with feedback `id`. Feedback text is stored for 30 days. |
| `POST /v1/checkout` | `plan`: `simple` or `pro` | Checkout `url`. A subscribed key gets 409 with `portal_url`. |
| `GET /v1/billing/portal` | Bearer only | Portal `url`, or 409 if no customer exists. |
| `GET /v1/health` | No bearer needed | `ok`, version fields, `model`, `environment`, `version_id`. |

CLI equivalents: `me`, `feedback <decision_id> <expected_verdict> "<note>"`, and `buy simple|pro`. Generating a checkout link does not complete a purchase. After the human pays, run `me`, confirm the plan, and then retry with the same key.

When paid plans are not open (`STRIPE_MODE=off`), checkout and portal return 503 `service_unavailable` with the response message and `error.options.open_source`; there is no purchase link or `Retry-After`. The client keeps exit 21 and explains that paid plans are not open yet, followed by the returned message and open-source link, without a decision-pause instruction.

## Errors and pause rules

Error envelope: `{"error":{"code":"…","message":"…"}}`, with additional fields described below. Do not perform the consequential action when there is no usable verdict.

| HTTP | Code | CLI exit / action |
| --- | --- | --- |
| 400 | `invalid_request` | 1; correct the input without performing the action. |
| 401 | `unauthorized` | 1; ask the owner to supply or correct the key. |
| 402 | `payment_required` | 20; show `error.message` and `error.options` verbatim. |
| 403 | `forbidden` | 1; stop and ask the owner. |
| 404 / 405 | `not_found` / `method_not_allowed` | 1; check the route or method. |
| 409 | `already_subscribed` | `buy` shows `error.portal_url` for managing the existing plan. |
| 413 | `input_too_large` | 1; reduce input, no charge. |
| 429 | `rate_limited` | 21; report `Retry-After` when present and pause. |
| 502 | `upstream_error` | 1; no usable verdict, pause. |
| 503 / 504 | `service_unavailable` / `upstream_timeout` | 21; report `Retry-After` when present and pause. |
| Network / sandbox | API unreachable | 22; ask the human to allow network for this command. |

The timeout is 60 seconds. Never interpret failure, an unknown code, or a malformed response as approval.

HTTP status takes precedence over body parsing for errors: a non-JSON 429, 503, or 504 still exits 21 and reports `Retry-After` when present. An HTML edge error page is not a usable verdict.

Every 402 includes `error.credits` with `plan`, `remaining`, and `needed` (1 or 5). Free keys receive `error.options.open_source` (`url`, `license`, `note`), `simple` ($10/month, 1,500 credits), and `pro` ($30/month, 15,000 credits). Available plans include their actual `checkout_url`. In off mode, `simple` and `pro` instead carry `"available": false` and no `checkout_url`. If a plan has `available: false` or no `checkout_url`, do not offer or generate a purchase link; show the returned message and open-source option. Paid keys receive `open_source` and `manage.url`, plus `error.credits.period_end`. Preserve the returned message, options, and links exactly; do not create another key to evade the balance.

## Self-hosted instance

Set `WWJD_API_BASE` to the instance URL and `WWJD_API_KEY` to its `OWNER_KEY`. A non-default base disables registration and uses that environment bearer. On 401, check that it matches the instance's `OWNER_KEY`. The minimal instance exposes only `POST /v1/wwjd` and `GET /v1/health`; account, feedback, and billing routes are hosted features.

Self-host responses omit `credits`; the client also accepts omitted `retention`. The supplied self-host Worker returns `retention: "Not stored by this self-hosted instance."` and requires an `OWNER_KEY` unless its operator explicitly sets `ALLOW_PUBLIC = 'true'`. Without either, decisions return 503 `owner_key_required`. Public access spends the operator's OpenAI funds.

## Privacy and limits

Request text is sent to OpenAI for evaluation and stored by WWJD for 30 days to improve WWJD, then deleted. Never send secrets.

The local guard scans action, every context source, and feedback before network access. It refuses private-key blocks, obvious key prefixes, and long token-shaped hex/base64 text. False positives can occur; describe the action instead. `--allow-secrets` is an explicit script override, not authorization for an agent to disclose data.

Every decision draws on the World English Bible: it always reads Jesus' two great commandments and the Ten Commandments, plus the passages Ezra's topic and pericope tags select for your action, never the whole Bible at once.

Jevsus is an LLM experiment, not Jesus. If Jevsus says Jesus would do something He wouldn't, Jevsus is wrong.
