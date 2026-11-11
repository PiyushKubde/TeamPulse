# Work intelligence: assistant, contribution journeys, copilot, signals

This is the final sprint's layer on top of tasks, measurement (docs/ai-work-measurement.md) and work evidence
(docs/work-evidence.md). **No new data is collected.** Everything here reads records TeamPulse already holds.
AI is optional and only writes up facts that have already been selected.

## Principles kept in the code

| Rule | Where |
| --- | --- |
| Facts separate from interpretation | Journey steps carry `fact: true, stageBy: 'rule'`. Assistant answers say "from records". The AI write-up is labelled "an interpretation". |
| No counts, ranks or productivity scores | Lists sort by person name or by urgency, never by volume. "Team today" leaves routine progress out. |
| No fabricated impact | Outcomes are `verified`, `claimed` or `none`. A claim is never shown as verified. The AI write-up drops any reference it was not given. |
| No penalty for external blockers | Blockers with outside-control wording are marked and the next step says "this is not on the person". |
| No double counting | Shared evidence and outcomes appear once, and each person's part stays attributed to them. |
| No silent attribution | Weak matches appear as "Possibly part of this work" and need a person to confirm them. "Not part of this work" unlinks evidence without deleting it. |
| No cross-org access, role-scoped | Every query is org-scoped. Team questions and team signals need manager rights (403). People outside the manager's teams return 404. |

## Employee AI Work Assistant (`#/assistant`)

- **Analyse my day:** `GET /api/assistant/day?day=YYYY-MM-DD&tz=<minutes>`. It returns:
  - a one-sentence summary;
  - completed, delivered, moved-forward and blocked work, each with notes and linked evidence;
  - meaningful contributions with a stated reason;
  - missing context, such as delivered work without evidence or unlinked app evidence;
  - next priorities, ordered: changes requested → overdue → due soon → blocked → continue → start;
  - the person's open signals.
- **Questions:** `POST /api/assistant/ask` with `{question | intent, taskId?, tz}`.
  - Questions are mapped to fixed intents: accomplished today, most meaningful, difficult problems, pending, focus next, find evidence for a task, and this week.
  - An unknown question gets the list of questions it can answer. Free text is not generated.
- **Optional AI write-up:** `POST /api/assistant/day/ai`.
  - Allowed only when the AI provider is configured **and** `AI_MODE=on`. In supervised mode it returns 403 `ai_supervised`, and with no provider it returns 503.
  - The viaSocket data-policy gate is unchanged.
  - The output is schema-checked, and any reference not present in the input is dropped.

## Contribution graph: journeys (`#/contributions`, `#/journey/:taskId`)

- **Stages:** reported → planned → investigated → implemented → reviewed → (rework, blocked) → delivered → accepted → outcome.
- **Steps come from** the source request, task creation, progress notes, comments, blockers, submissions, reviews, linked evidence and impact records. Commits are grouped per author and repository, and Slack messages per thread.
- **Every step** carries its source, author, time and link, and states how it was verified: recorded by the app, a person's account, or a reported figure.
- **Also on the journey page:**
  - the contributors, with roles, including co-contributors on visible work;
  - what is missing;
  - possible links, with confirm or reject;
  - related tasks;
  - the existing assessment, which stays the source of truth for complexity.
- **API:** `GET /api/journeys?userId&from&to` and `GET /api/journeys/:taskId`.

## Manager AI Copilot (Team Intelligence → Copilot)

The same `/api/assistant/ask` with `team: true`. It answers these questions:

- team today and this week;
- complex problems solved;
- who is blocked and why;
- verified outcomes;
- what waits for review;
- delays;
- who may need help;
- what needs attention.

Every item links to its record.

**Contribution Reviews** (`#/reviews`) gathers, in one place, every decision only a manager can make:

- submissions;
- analyses;
- outcomes to verify;
- evidence attribution;
- team signals.

## Proactive signals

Signals are stored in `work_signals` (migration 009). They are detected by fixed rules in `server/intelligence/signals.js`:

| Kind | Condition |
| --- | --- |
| stalled | No progress for more than the org's `noProgressHours` threshold |
| deadline | Due within 48 hours at under 75% progress |
| blocker | Unresolved for `blockerUnresolvedHours` or more; high severity if critical; outside-control blockers marked |
| rework | Changes requested two or more times. The suggested step is to clarify the criteria, not to blame. |
| unverified_impact | Outcome claim pending for more than 3 days |
| missing_evidence | Delivered in the last 14 days with no link, file, app evidence or outcome |
| duplicate_effort | Similar titles assigned to different people |
| unlinked_work | A merged PR or release not linked to a task for more than a day |
| awaiting_review | Analysis pending more than 2 days, or submission pending more than 24 hours |

**Lifecycle:**

- Signals are upserted by `dedupe_key`, so there are no duplicates across runs.
- A signal resolves itself when its condition clears.
- A resolved signal reopens if the condition returns.
- A **dismissed** signal stays dismissed. Dismissing needs a reason, which is kept in the signal's history and in the audit log.

**When detection runs:**

- inside the existing `/tasks/alerts` cron run;
- lazily when signals are read, at most every 10 minutes per org.

**M91 is used only for interventions:**

- Existing rules still decide phone alerts. For example, `blocker_unresolved` is on by default.
- A significant unverified outcome raises `impact_verification_needed`, which is in-app only by default and can be enabled per org.
- Signals never page anyone directly, and tests send no real alerts.

## Navigation

| Role | Sidebar |
| --- | --- |
| Manager | Team Dashboard (with "Where to intervene"), Team Work, Team Intelligence, Contribution Reviews, Reports; then under "My work": My Work, My Evidence, AI Work Assistant, Contributions, Task Requests, Automation Center, Alerts, Settings |
| Employee | Dashboard (with "Today" → Analyse my day), My Work, My Evidence, AI Work Assistant, Contributions, Task Requests, Connected Apps, Alerts, Settings |

viaSocket appears as **Connected apps**, presented as three steps: connect → choose what to collect → analyse. Outcomes & impact is reached from Contributions.
