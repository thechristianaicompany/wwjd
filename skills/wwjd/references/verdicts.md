# Acting on a WWJD result

Read outcomes in this order:

1. `ask_human: true`: stop and ask, whatever the verdict.
2. `aligned` and `ask_human: false`: WWJD has no objection; proceed only within existing human authorization.
3. `not_aligned`: do not proceed on your own. Explain the harm, offer an aligned alternative, and cite the returned passages. If the informed human still explicitly directs the action, their decision governs within your own and the project's safety rules.
4. `discernment_required`: stop and ask, showing the passages and the reason.
5. No usable verdict, including `refused: true`, payment, rate limit, server, network, sandbox, or malformed-response errors: stop that action, continue other safe work, and explain the options. In a headless run, skip the action and report it blocked.

A refused or malformed response never permits an action even if another field says `aligned`. WWJD does not grant authority. Its probability is an estimate, not a promise or an instruction from Jesus.

## Examples

These are hypothetical illustrations, not captured engine results. Use the passages actually returned by your call, and quote Scripture only when you have its exact text.

**Delete an irreplaceable backup.** The human says “Free up space,” but has not authorized destroying their backup. Describe the deletion and the lack of another verified copy. If WWJD returns `not_aligned`, `ask_human: true`, and Exodus 20:15, stop: “WWJD flagged destroying your data without permission (Exodus 20:15). I can list replaceable build files instead.” Do not delete the backup.

**The human explicitly asked.** The human specifically authorizes deletion of a named old backup after verifying a replacement. Include that authorization and backup evidence in the context. `aligned` with `ask_human: false` permits continuing within that existing authorization. If WWJD instead flags harm, tell the human and wait; if the informed human explicitly confirms, WWJD remains advisory, subject to your own and the project's safety rules. Do not erase earlier authorization or pretend WWJD granted it.

**Send a message as someone.** Before sending on the human's behalf, describe the recipient's role and the requested message without personal data. Even `aligned` with `ask_human: true` means stop and ask. Show a draft while waiting; an alignment score is not permission to press Send.

**Conflicting duties.** A proposal to disclose confidential material to protect someone may return `discernment_required`. Present the reason and returned references, such as Luke 10:25–37 if present. Ask which bounded action the human authorizes; do not independently disclose the material.

**No credits or no network.** A backup deletion receives 402, or a sandbox blocks the API. Leave the backup intact. Show the 402 options exactly as returned, or ask for network access for the command. Continue listing safe cleanup candidates. Never rotate keys, buy a subscription, or set up self-hosting to bypass the pause. In an unattended run, report the deletion blocked.

**Routine refactor.** The human asks for a local refactor or JSON formatting. Read, edit, build, and test within that scope without a WWJD call. If the task grows to a production deployment or another consequential action, evaluate that distinct action first.

Request text is sent to OpenAI for evaluation and stored by WWJD for 30 days to improve WWJD, then deleted. Never send secrets.

Jevsus is an LLM experiment, not Jesus.
