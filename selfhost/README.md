# Self-hosted WWJD

This Cloudflare Worker wraps `@wwjd/engine` and `@wwjd/corpus`. It has two routes, no billing, and no request storage. Follow the [root README](../README.md) for prerequisites, login, secrets, and deployment.

The instance requires `OWNER_KEY` unless `ALLOW_PUBLIC` is exactly `"true"`. In public mode, anyone reaching the endpoint can spend your OpenAI money. With an owner key, send `Authorization: Bearer <your owner key>`.

Every decision draws on the World English Bible: it always reads Jesus' two great commandments and the Ten Commandments, plus the passages Ezra's topic and pericope tags select for your action, never the whole Bible at once.

## Local development

From the repository root:

```sh
pnpm install
pnpm --filter selfhost test
pnpm --filter selfhost typecheck
pnpm --filter selfhost exec wrangler deploy --dry-run
```

To evaluate through your own OpenAI account locally, put `OPENAI_API_KEY` and `OWNER_KEY` in `selfhost/.dev.vars` (ignored by Git), then:

```sh
pnpm --filter selfhost dev
curl http://127.0.0.1:8787/v1/health
curl http://127.0.0.1:8787/v1/wwjd \
  -H "Authorization: Bearer $WWJD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"action":"Explain a proposed change to its owner before acting."}'
```

Set your shell's `WWJD_API_KEY` to the same owner key. A valid local evaluation spends your OpenAI credits; the test suite uses dependency-injected fixtures and makes no OpenAI calls. With neither key set, the health route remains available and decision requests fail closed with `503 owner_key_required`.

Input must be JSON with a non-empty `action` string and optional `context` string. The body is limited to 8 MB while streaming, and the caller text to 1M estimated tokens. Responses follow the hosted decision shape with no `credits` and with `retention: "Not stored by this self-hosted instance."` Request text is nevertheless sent to OpenAI for evaluation.
