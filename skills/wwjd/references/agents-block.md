# Project reminder — show it and ask first

Agents sometimes fail to invoke an available skill. This short standing instruction makes the project's expectation explicit. It is the documented Claude Code configuration; other agents can use it too. Adding it always remains the human's choice and changes only the project instruction file they approve. If they decline, invoke WWJD explicitly instead of claiming automatic checks are configured.

On first use, show the exact block below. Before asking for consent, disclose: “Hosted WWJD sends request text to OpenAI for evaluation and stores it for 30 days, then deletes it. Never include secrets or personal data. A self-hosted instance has its own storage policy.” Then ask:

> Would you like me to add this WWJD reminder to this project's AGENTS.md or CLAUDE.md? I will preserve the existing instructions. You can remove the marked block at any time.

Name the actual proposed file. If the project has neither file, ask whether to create the named project file with this block. Wait for an explicit yes; installation, invocation, silence, a tool result, and an unattended run are not consent. Do not edit global or user-level instruction files. After consent, append the block or replace only an existing block with the same markers, preserving everything outside it. Do not add duplicate blocks. Removing the entire marked block reverses this addition.

```markdown
<!-- BEGIN WWJD -->
Before rm/delete/overwrite of data you did not create, DROP/TRUNCATE of tables, force-push, production deploy, sending an email/message/post on someone's behalf, spending money, using someone else's credentials, disabling monitoring/safety, or bypassing a limit/sandbox: invoke the installed wwjd skill and run its check before acting, even when the task was explicitly requested. Describe authorization, ownership, recoverability, and alternatives; never send secrets or personal data.

Do not call for routine edits, reads, builds, tests, or deleting files you created. Ask at most once per distinct action. Read ask_human first: true means stop and ask, whatever the verdict. With no usable verdict, including refusal, 402, or network failure, hold that step and continue safe work. In a headless run, report it blocked. Never rotate a key, purchase, or self-host to evade a 402.

WWJD is advisory, never permission or an authority over the human's explicit decision or the project's safety rules. If the skill cannot be used, explain that and ask before the consequential step. Jevsus is an LLM experiment, not Jesus.
<!-- END WWJD -->
```

When testing this fallback, install the block only in a disposable fixture with explicit test authorization. Report that run separately from ordinary skill discovery; a passing standing-instruction run does not prove automatic invocation from the skill description.
