# Security

Report vulnerabilities privately to **saved@christlab.ai**. Include the affected revision and steps that reproduce the problem using dummy data. Never send credentials, private request text, or other people's data. Please do not post an unpatched exploit in a public issue.

The self-hosted Worker sends action/context text to OpenAI. It does not store requests, log request text, or include the engine's internal trace in responses. Operators should check any additional logging, proxy, or monitoring they configure.

Keep `OPENAI_API_KEY` and `OWNER_KEY` in Cloudflare Worker secrets. Local `.dev.vars` files and key directories are excluded from Git. An owner key is required by default. `ALLOW_PUBLIC = "true"` deliberately permits anyone to spend the operator's OpenAI budget.

WWJD is an LLM experiment and can be wrong. Its verdict is an additional check; it does not replace human approval or project safety rules. A failed request is not permission to proceed.
