# What would Jevsus Do?

WWJD gives AI agents one more check before they act: describe an action and receive an alignment probability, Scripture, and a verdict of `aligned`, `not_aligned`, or `discernment_required`.

Agents can delete things, send messages, and make decisions that affect people. We want them to pause first. The starting point is Jesus' two great commandments: love God and love your neighbor.

Every decision draws on the World English Bible: it always reads Jesus' two great commandments and the Ten Commandments, plus the passages Ezra's topic and pericope tags select for your action, never the whole Bible at once.

**Jevsus is an LLM experiment, not Jesus. If Jevsus says Jesus would do something He wouldn't, Jevsus is wrong.** WWJD is one more check, never an authority over a human's explicit instructions or a project's safety rules. An `aligned` verdict does not grant permission the agent did not already have.

Sponsored by [christlab.ai](https://christlab.ai).

## Install the agent skill

```sh
npx skills add thechristianaicompany/wwjd
```

The installer lets you choose your agent and installation location. The skill tells the agent when to ask, what context to include, and how to act on the answer. The script needs Node 18 or later; self-hosting needs Node 22.

**Claude Code setup:** after installing, say: “Set up WWJD for this project. Show me the exact standing instruction before changing CLAUDE.md or AGENTS.md.” Review the [project reminder](skills/wwjd/references/agents-block.md), then explicitly approve it if you want it added. The agent preserves existing project instructions and never changes global configuration. Installing the skill alone never authorizes that edit. If you decline the block, invoke WWJD explicitly; automatic skill selection was unreliable in our Claude tests. Other agents may use the same reminder. See [the measured configurations and limits](skills/wwjd/references/installation-evidence.md).

## The API in 30 seconds

After cloning this repository, run:

```sh
node skills/wwjd/scripts/wwjd.mjs 'Send this reviewed announcement to our mailing list.' \
  --context 'The owner approved this exact message and recipient list.'
```

On the hosted service, the first call registers a key and gives it 10 free credits. The script stores it locally with owner-only permissions. Existing keys can be supplied through `WWJD_API_KEY`. The following direct HTTP example assumes you already supplied that environment variable through your secret manager; automatic registration stores a key in a file and does not set the shell variable:

```sh
curl https://findjevsus.com/v1/wwjd \
  -H "Authorization: Bearer $WWJD_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"action":"Send this reviewed announcement to our mailing list.","context":"The owner approved this exact message and recipient list."}'
```

When `ask_human` is true, ask the human before proceeding, regardless of the verdict. Only `aligned` with `ask_human: false` lets the agent continue within its existing authority. `not_aligned` means stop and explain. `discernment_required`, a refusal, an error, or an unexpected response means pause that step and ask the human. See [the complete verdict rules](skills/wwjd/references/verdicts.md).

Hosted prices: Simple is $10/month for 1,500 credits; Pro is $30/month for 15,000. Up to 100K input tokens costs 1 credit; up to 1M costs 5; larger inputs are rejected. Engine and upstream failures are refunded.

**Hosted privacy:** Request text is sent to OpenAI for evaluation and stored by WWJD for 30 days to improve WWJD, then deleted. Never send secrets. Describe the action instead of including credentials or private keys.

## Self-host in five minutes

Prerequisites: Node 22, pnpm 11.9 through Corepack, a Cloudflare account, and an OpenAI key on a paid usage tier (`gpt-6-luna` is unavailable on the Free tier). Workers Paid is recommended: the Workers Free plan allows only 10 ms CPU per request. Five minutes is a setup target, not measured deployment time.

```sh
git clone https://github.com/thechristianaicompany/wwjd.git
cd wwjd
corepack enable
corepack prepare pnpm@11.9.0 --activate
pnpm install
pnpm --filter selfhost exec wrangler login
pnpm --filter selfhost exec wrangler secret put OPENAI_API_KEY
pnpm --filter selfhost exec wrangler secret put OWNER_KEY
pnpm --filter selfhost deploy
```

Enter your OpenAI key at the first secret prompt. At the second, enter a long, randomly generated owner key stored in your password manager. Do not paste either into source files. Wrangler prints your deployed Worker URL.

```sh
export WWJD_API_BASE='https://your-worker.your-subdomain.workers.dev'
read -r -s -p 'Owner key: ' WWJD_API_KEY; printf '\n'; export WWJD_API_KEY
node skills/wwjd/scripts/wwjd.mjs 'Explain the proposed change before editing the shared project.'
```

The `read` example uses Bash; in another shell, set `WWJD_API_KEY` through your secret manager. With `WWJD_API_BASE`, the skill sends this key as the bearer and does not register a hosted key.

The self-hosted Worker exposes only `POST /v1/wwjd` and `GET /v1/health`. There is no billing, credit counter, D1 database, or R2 bucket. Request text is sent to OpenAI for evaluation, but this Worker does not store it; responses say `Not stored by this self-hosted instance.` OpenAI's own handling still applies.

Without `OWNER_KEY`, decisions return `503 owner_key_required`. To deliberately serve unauthenticated requests, set `ALLOW_PUBLIC` to the literal string `"true"` in `selfhost/wrangler.jsonc` and redeploy. **Anyone who reaches a public instance can spend your OpenAI money.** This setting bypasses the owner-key check even if an owner key is set.

See [self-host development and verification](selfhost/README.md).

## License and sources

The code and Ezra topic/pericope mappings are [AGPL-3.0](LICENSE). World English Bible text is public domain. The full corpus, its pinned sources, and its rebuild scripts are included; see [corpus sources](corpus/sources/SOURCES.md).

For vulnerabilities or accidental data exposure, see [SECURITY.md](SECURITY.md).
