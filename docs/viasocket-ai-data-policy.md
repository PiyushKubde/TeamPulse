# viaSocket AI: open data-policy questions (UNRESOLVED)

**Status: unresolved as of 2026-11-09. No real employee work data may be sent to viaSocket AI until every question below has a written answer from viaSocket and the owner has accepted them.**

This is enforced in code. Until `AI_VIASOCKET_POLICY_CONFIRMED=true` is set:
- With `AI_PROVIDER=viasocket`, the app reports "viaSocket AI is not enabled".
- Nothing is sent to viaSocket.
- The Anthropic backup is **not** used in its place: this is a policy decision, not a provider failure.

The evaluation runner may still use viaSocket with the **fictional** dataset (`eval/dataset.json`), and only with `--confirm-live`.

## Why it matters

Each analysis sends one task's evidence pack to viaSocket AI. The pack contains:
- the task's description;
- progress notes, comments and the completion submission;
- review comments, blocker descriptions and outcome records.

People's names are left out, but this is still work-performance information about an identifiable employee. The text can also contain customer or business details people wrote into the task.

## What viaSocket's public documentation says ([viasocket.com/docs/ai.md](https://viasocket.com/docs/ai.md), read 2026-11-09)

| Topic | What the docs say |
|---|---|
| Storage | Every call is stored as a conversation thread ("viaSocket keeps the history"). The system prompt is "not stored"; the message (our evidence pack) and the reply are. |
| Listing and reading | Threads can be listed and read back per identifier (`GET /embed/ai/threads`, `…/history`). |
| Deletion | **No delete endpoint is documented.** |
| Retention period | **Not stated.** |
| Use for training | **Not stated** — neither by viaSocket nor by the model vendor it forwards to. |
| Subprocessors | Calls are run on OpenAI, Anthropic or Gemini models, chosen per call. The page does not say under which terms or data-retention settings viaSocket uses those vendors. |
| Region / location | **Not stated.** |
| Security / access | **Not stated** — who at viaSocket can read stored threads. |
| Web tools | The assistant's web search and browser "cannot be turned off". KONVO instructs the model not to use them; this cannot be enforced. |
| Model reporting | Synchronous replies do not name the model that answered; KONVO records the model as requested and "not confirmed". |
| Memory feature | A separate "AI memory" service exists. Its guide could not be read (host not reachable from this environment); KONVO does not use it. |

## Questions to send to viaSocket

1. How long are AI threads (messages and replies) kept? Can retention be shortened or turned off for a project?
2. Can a thread be deleted through the API or on request, and is deletion complete (including backups and logs)?
3. Is any AI message or reply used to train or improve models, by viaSocket or by the model vendor (OpenAI / Anthropic / Google)? Is that contractually excluded?
4. Under which terms does viaSocket send data to each model vendor? Are zero-retention or no-training settings used? Which vendor regions?
5. Where are threads stored, in which country or region? Who at viaSocket can access them, and is access logged?
6. Is there a data processing agreement (DPA) covering employee personal data for the embed organization?
7. Can web search and the browser be disabled for a project or a call?
8. Can the synchronous reply include the model that actually answered and its token usage?
9. Is the AI memory service ever applied to `ai.send` calls that do not ask for it?

Record the answers here (who answered, date, link to the written reply). Then decide, and only then set `AI_VIASOCKET_POLICY_CONFIRMED=true`.

## Anthropic (backup)

Anthropic is used only when viaSocket fails for a provider reason. Its data handling is governed by the owner's Anthropic commercial terms and settings. Confirm they are acceptable for employee work data before setting `ANTHROPIC_API_KEY` in production.

## Already in place, whichever provider

- Only an administrator can start an analysis, only on tasks listed in `AI_SUPERVISED_TASKS`, and the task owner's email must match (supervised mode, the default).
- The preview shows exactly what would be sent, without sending it.
- Names are left out. Linked files and pages are not opened. No external sources are used.
- Each analysis uses a fresh thread under a KONVO-only identifier, `teampulse-ai-<orgId>`, never an employee's own chat.
