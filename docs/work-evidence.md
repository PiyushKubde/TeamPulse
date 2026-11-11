# Work evidence from connected apps (Sprint 2)

> We are measuring meaningful work, not digital activity.

TeamPulse collects work evidence from apps a person connected:

- GitHub, Slack, Gmail, Google Calendar and Google Sheets;
- only from the scopes that person chose;
- on that person's own viaSocket connection.

TeamPulse links each piece of evidence to the right task. The Phase 1 measurement engine then uses it **when someone asks for an analysis**. Collection never starts an analysis.

## Architecture

```
person's own connection ──viaSocket trigger (user.subscribe)──▶ POST /api/work-evidence/events/:subscription  (bearer token per subscription)
                                                                   │
                                     evidence_inbox (raw, dedupe by hash, retry queue)
                                                                   │ collectors.normalize()
                                     external_evidence (one row per external event per org; updates in place)
                                                                   │ attribution (identities) + matching (rules)
                                     evidence_task_links (suggested → confirmed / rejected by a person)
                                                                   │ only confirmed or ≥ 0.85
                         "Analyse my work" → evidence pack → AI provider (policy & supervised gates) → guardrails → assessment
```

| Module | Role |
| --- | --- |
| `server/evidence/collectors.js` | The five collectors: triggers, scope picker, trigger input, `normalize()` |
| `server/evidence/sources.js` | Sources on the person's own connection: scope from live options only, a real-sample check, subscribe, pause/resume/stop, health checks, identities |
| `server/evidence/ingest.js` | Webhook, inbox, normalization, attribution, storage, scheduled retry |
| `server/evidence/matching.js` | Deterministic evidence→task matching; the links an analysis may use |
| `server/evidence/service.js` | Visibility, lists, the person's corrections, manager resolution, M91 intervention hooks |
| `server/measurement/evidence-pack.js` | Linked evidence enters the Phase 1 pack, grouped; unlinked evidence enters as candidates |
| `public/js/views/evidence.js` | "My work evidence", the manager's evidence review, the task page's "From connected apps" |

Migration `008_external_evidence.sql` only adds tables:
- `external_identities`, `evidence_sources`, `evidence_subscriptions`;
- `evidence_inbox`, `external_evidence`, `evidence_task_links`, `evidence_sync_runs`.

Every row carries `org_id`.

## Triggers used (read from the live viaSocket catalog, 2026-11-09)

| App | Event kind | Trigger key | Version | Scope input |
| --- | --- | --- | --- | --- |
| GitHub | pull_requests | `Pull_Request_Opens_or_Closes` | v22 | `repoFullName` |
| | commits | `New_Commit_Pushed` | v6 | `repoFullName`, `sha` (branch) |
| | review_comments | `new-pull-request-review-comment` | v1 | `repoFullName` |
| | issues | `When_a_new_issue_is_created` | v7 | `repoFullName` |
| | issue_comments | `When_a_new_comment_is_added_to_an_issue` | v6 | `repoFullName` |
| | releases | `New_Release_Published` | v6 | `repoFullName` |
| Slack | messages | `New_Message_in_Channels` | v25 | `channel_id[]` |
| | thread_replies | `New_Thread_Message_Instant` | v1 | `channel` |
| Gmail | received | `New_Email_Arrives` | v11 | label (`searchFields.label`) |
| | sent | `New_Email_Sent` | v6 | label |
| Google Calendar | events | `New_or_Updated_Event` | v30 | `calendarId[]` |
| Google Sheets | rows | `Row_Added_Or_Updated` | v11 | `spreadSheet_id`, `sheet_id`, `column_key`, `record_type` |

**Not available as triggers in the catalog, so not built:**
- GitHub "PR merged" is not a separate trigger; the close event carries `merged`.
- GitHub "review submitted", "issue closed" and "issue updated".
- Slack message deletion is not a separate trigger. A `message_deleted` subtype arriving through the channel trigger is honoured.
- Sheet row deletion.

The catalog also has read-only actions (e.g. `List_Pull_Requests`, `Get_Messages_from_Slack`, `List_all_Events`, `List_Rows_in_Sheet`). They could be used for a history backfill. This sprint does **not** use them: no full-history retrieval.

### Field mapping

- **Catalog examples available:** mapped from them for GitHub PRs and review comments, Slack channel messages, Gmail received mail, Calendar and Sheets.
- **No catalog example:** GitHub commits, issues, issue comments and releases, Slack thread replies and Gmail sent mail. These are mapped from the standard GitHub/Slack API shapes.
- **Checked before switch-on:** a real sample from the person's own scope must map, or that event kind is not switched on.

## Sync model

- **Initial sync:** the latest real event of the chosen scope (catalog `sampleEvent`, read-only). It also proves the mapping. There is no backfill of older history, by design.
- **Incremental:** each new event is pushed by viaSocket.
- **Checkpoint:** the newest event time per source.
- **Dedupe:** by payload hash in the inbox, and by `(org, app, external id)` for evidence. An update to the same item (a PR opened then merged, a calendar change, an edited sheet row) updates one row; the previous sheet values are kept.
- **Retry:**
  - Every event is stored before it is processed.
  - The 15-minute scheduled job retries `RECEIVED` and `FAILED` rows, up to 5 attempts.
  - After 3 failures in a row, the owner gets an in-app notice once a day. Never M91.
- **Rate limit:** 120 events/minute per subscription (429).
- **Health:** at most hourly, one read-only `listConnections` per owner. A missing or expired connection sets the source to `NEEDS_RECONNECT`, and disconnecting the account pauses its flows.
- **Writes to external apps:** none. Collection only reads.
- **Unknown:** whether viaSocket retries a delivery TeamPulse answered with an error is not documented.

## Attribution: whose work is it?

- **Identities.** People record who they are in each app (GitHub login, Slack member id, email). An identity is also read from the person's own connection label when it is an email or login. Each identity has one owner per organization, so nobody can claim another person's commits.
- **Labels.** Each event is labelled:
  - `self`: the collector's own;
  - `member`: another member's;
  - `external`: an outside email address;
  - `unknown`: an author nobody claimed. These are visible and never guessed.
- **Personal sources.** Gmail sent mail, calendar events and sheet rows belong to the collector: their mailbox, calendar or tracker.
- **"Not mine".** A person can dispute evidence attributed to them. It stops counting, and a manager decides whose it is.
- **Shared work.** A teammate's commit on someone's task is linked as **shared**, with the teammate as contributor. Managers set shared or individual ownership.

## Matching

| Method | When | Confidence |
| --- | --- | --- |
| `explicit_ref` | The event names the task (`TP-` + first 8 characters of the task id) | 0.95 |
| `resource_ref` | The event's URL is one of the task's links | 0.90 |
| `resource_ref` | The event is in a repository the task links to, by the task's owner, during the task | 0.70 |
| `text_time` | Shares words with the task, by its owner, during the task | 0.40–0.70 |
| `ai` | The model, during an analysis, says an unlinked "candidate" belongs | 0.60 |
| `manual` | A person links it | confirmed |

- Nothing is confirmed automatically.
- Only confirmed links and suggestions of 0.85 or more are used in an analysis.
- A person's confirm or reject decision is never overwritten.
- No task or task request is created from a message. The existing intake approval flow is unchanged.

## How evidence enters an analysis

- **Grouping:** one person's commits in one repository are one item ("series"), and a Slack thread is one item. Activity counts never appear.
- **Labels on every item:**
  - author relative to the employee: employee, teammate, external person or unknown;
  - verification: `system_recorded` (a fact recorded by the app), `self_reported` (someone's words) or `reported_figure` (a spreadsheet value).
- **Candidates:** the employee's unlinked evidence from the task's period is offered as candidates. The model may only say whether each belongs; citations of candidates are removed.
- **Facts vs interpretation:** the output has `observed_facts` (each with valid references) and `evidence_matches`. Interpretation stays in the reasons.
- **New guardrails** (`guardrails-2026-11-v5`, prompt `v3`, rubric `default-2026-11-v2`):
  - The employee's own messages and emails are their account. They never corroborate L3+ complexity; app-recorded facts and other people's words do.
  - Ownership, problem-solving, collaboration and quality cannot be rated from other people's evidence alone.
  - Impact resting only on a spreadsheet figure is capped at 2. Above 3 still needs a manager-verified outcome.
  - All Phase 1 and Phase 1.1 guardrails still apply, whichever provider answered.
- **Unchanged gates:** the provider gates are untouched. ViaSocket AI stays blocked until `AI_VIASOCKET_POLICY_CONFIRMED=true`, and supervised mode remains the default.

## Who sees what

- Evidence is visible to:
  - the person who collected it;
  - the person it is attributed to;
  - managers with either of them in scope;
  - admins.
- Another organization gets a 404.
- The collector can remove evidence: its content is deleted and its links are dropped.
- The manager's Team intelligence page shows significant contributions with reasons, open blockers (with the outside-control flag), the evidence review queue, and people in alphabetical order. It never shows commit, message, email or meeting counts.

## M91

M91 is used only for human interventions, through the existing alert rules (per-rule M91 switch, dedupe, retries, close-on-resolve, authenticated callbacks):

| Rule | When | M91 by default |
| --- | --- | --- |
| `evidence_attribution_review` | Disputed evidence on a task that has an assessment | on |
| `evidence_attribution_note` | Disputed evidence elsewhere | off (in-app) |
| `assessment_disputed` | An employee disputes an analysis | on |
| `impact_verification_needed` | Reserved: a reported figure linked to an outcome awaiting verification | off |

Sync errors and individual evidence events never go to M91.

## Not verified live

- **Unit/API and browser tests only.** Every collector, webhook, matcher and screen is tested with a stand-in viaSocket gateway and with events posted to the real webhook.
- **No live trigger tested.** No user-owned GitHub, Slack, Gmail, Calendar or Sheets connection has delivered a live event yet.
- **Mappings not checked against live payloads.** The catalog's example payloads come from the connector author's account. The live check is the real-sample step when a source is switched on.
