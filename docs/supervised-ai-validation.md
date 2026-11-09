# Supervised live-AI validation (one real task)

Do **not** run this until the owner provides an Anthropic API key and gives explicit approval. Nothing here has been run yet.

## What the app guarantees in supervised mode

With a real provider configured, `AI_MODE` defaults to **supervised**:

| Requirement | How it is enforced |
| --- | --- |
| Explicitly selected task | Only task ids listed in `AI_SUPERVISED_TASKS` can be analysed; every other task gets "not selected. Nothing was sent." |
| Correct organization and owner | Each entry is `taskId:owner-email`. The task must be visible to the admin in their own organization, and its owner's email must match, or the request is refused before anything is sent |
| Who can start it | Admins only |
| Existing evidence only | The evidence pack is built from TeamPulse records. External sources: 0. Files and links are not opened. Names are left out |
| No external app retrieval | No ViaSocket or connector calls in the analysis path |
| No M91, email or Slack | Supervised runs emit **no event**: no in-app notification, no M91 delivery, no ViaSocket flow, no outbox row. Automatic analysis on submit/approve is off |
| No other data change | One `ai_evaluation_runs` row, one `contribution_assessments` row with its dimension rows, one `assessment.created` audit row. The task itself is untouched (tested) |
| History preserved | A re-analysis creates a new assessment. Earlier ones and people's responses stay and are shown |
| AI vs simulated | The card shows "Live AI · <model>", "Simulated — development only, not AI", or "Rules only (no AI call)", plus a fallback badge when another model answered |

## Before the test

1. Pick one task, ideally completed with good evidence, and note its id and the owner's email.
2. On the task page, as an admin, click "See exactly what would be sent to the AI". This calls the preview endpoint, which makes no AI call and writes nothing. Check the content is acceptable to send to viaSocket AI (and Anthropic, if the backup is set), and check `wouldCallModel: true`.
3. Take a backup (the scheduled job makes a daily verified one).

## Configuration (Embarko → App setup → Environment, set by the owner)

```
AI_PROVIDER=viasocket                 # viaSocket built-in AI (uses the existing VIASOCKET_* keys)
AI_VIASOCKET_SERVICE=anthropic
AI_VIASOCKET_MODEL=claude-sonnet-5-5
ANTHROPIC_API_KEY=<owner-provided key> # backup if viaSocket AI fails (optional)
AI_MODEL=claude-opus-5-5              # backup model
AI_MODE=supervised
AI_SUPERVISED_TASKS=<task-uuid>:<owner@email>
# optional: AI_EFFORT=medium, AI_TIMEOUT_MS=120000, AI_FALLBACKS=on
```

The feature branch must be deployed first. That deploys migration 007, which is additive, and needs the owner's approval.

The startup log should say: `AI work analysis: viasocket, model anthropic/claude-sonnet-5-5; backup anthropic claude-opus-5-5; mode supervised (1 selected task(s))`.

Before the test, ask viaSocket how long AI threads are kept and whether they are used for training: every analysis is stored there as a thread.
`/api/health` should show `ai: configured`, `aiMode: supervised`.

## The test

1. As an admin, open the task. The card says the task is selected for a supervised test.
2. Press **Analyse this work**. It usually takes under a minute, and the card refreshes itself.
3. Check:
   - The card shows "Live AI · viaSocket AI · anthropic/claude-sonnet-5-5", or "viaSocket AI failed — answered by the anthropic backup".
   - Every evidence chip links to something real on the task.
   - "Rules TeamPulse applied" is reasonable.
   - Nothing is claimed that the task does not show.
   - Impact is labelled as estimated unless an outcome is verified.
4. Record findings next to the eval dataset expectations.

### Failure cases

The run fails with a readable message and no assessment:

| Problem | Message |
| --- | --- |
| Bad key | "rejected the API key (401)" |
| Wrong model | "does not know this model (404)" |
| Timeout or overload | Retried; "did not answer in time" / "provider failed" |

## After the test

- Leave `AI_MODE=supervised` (or set `off`) until the evaluation dataset has been run live and its references reviewed.
- To stop everything: remove `ANTHROPIC_API_KEY` or set `AI_MODE=off`. Existing assessments stay readable.
