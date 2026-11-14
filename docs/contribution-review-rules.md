# Which assessments reach a manager's Reviews

Every submitted task is assessed (automatically when AI is on, or by the controlled backlog start below). Every assessment is
**recorded**. Only some are **queued** for a manager. This page is the exact rule. It lives in
`server/measurement/lifecycle.js` and is exercised by `test/review-threshold.test.js` and `test/contribution-lifecycle.test.js`.

There are no scores, no rankings and no activity counts anywhere in these rules.

## The six states of a submitted task

| State | What it means | In the manager's review queue? |
|---|---|---|
| Not assessed yet (client-side) | Submitted, no assessment record: still running, submitted before AI was on, or AI unavailable | No (shown under "Not yet assessed" with a count) |
| `NOT_ENOUGH_EVIDENCE` | The evidence cannot support a judgement. Nothing was rated, nothing invented. **This is not a performance verdict.** | No |
| `ROUTINE` | Assessed, below the threshold below. Recorded on the person's history. | No |
| `SUBMITTED_FOR_REVIEW` | Meaningful work, waiting for a manager | **Yes** |
| `APPROVED` / `ADJUSTED` | A manager decided; both count as manager-reviewed contributions | No (history) |
| `DISPUTED` | A manager disagreed, with a written reason | No (history), stays visible on the person's record and to the employee |

A manager can always open and review any assessment, including routine work. The rules only decide what is queued.

## The exact rule

An assessment whose manager decision is still pending is **queued** when it is *meaningful* and was *not decided*:

1. **The employee corrected or disputed it** (`employee_status` is `CORRECTION_PROPOSED` or `DISPUTED`) → queued, always, even if the
   evidence was thin or the work looked routine. A human challenge must be seen by a human. *This is checked first.*
2. Otherwise, if there was **not enough evidence** (the answer came from rules, `provider = 'rules'`, or `evidence_state = 'insufficient'`)
   → **not queued**, state `NOT_ENOUGH_EVIDENCE`.
3. Otherwise queued if **any** of these hold on the *effective* rating (a manager's adjustment replaces the AI's rating):
   - complexity is assessed at **level 3 or higher** (`MEANINGFUL_LEVEL = 3`);
   - impact is assessed at **level 3 or higher**;
   - the impact block is based on **verified** or **evidence-supported** outcomes.
4. Otherwise → `ROUTINE`, recorded, not queued.

Decided assessments (`APPROVED`, `ADJUSTED`, `DISPUTED`) are never queued again; they are history.

### What the guardrails already guarantee before these rules run

- An AI rating of complexity 3+ needs evidence from the work itself *and* corroboration beyond the employee's own description
  (an artefact, a review comment, a blocker, a verified outcome); otherwise it is lowered to 2.
- An AI impact above 3 is capped until a manager verifies the outcome; shared outcomes and external blockers are never held against a person.
- Every rated dimension must cite evidence that exists; unsupported ratings are replaced by "insufficient evidence", not guessed.

## Where the rule is used

- Manager Reviews queue and the "awaiting your review" counts (`assistant.js`, `assessments.js` `waitsForManager`).
- The proactive "unreviewed assessment" signal (`signals.js`).
- The lifecycle badge on the employee's My Contributions, the person page and Work Intelligence (`lifecycleOfAssessment`).

## Assessing work that was submitted before assessments existed

Nothing is back-filled automatically, and switching AI on does not start anything. `server/measurement/backlog.js`:

- **Who:** a manager, for the teams they manage (an admin only if explicitly assigned to manage a team, like any admin acting as a manager).
  Employees cannot. An admin who manages no team sees only a count on the admin overview, never task titles or people.
- **Which tasks:** submitted (`SUBMITTED_FOR_REVIEW` or `COMPLETED`, with an owner) that have **no assessment record at all** and no queued or running analysis.
  A task that has *any* assessment, reviewed or not, is never a candidate, so a manager's decision is never replaced and no duplicate is ever created.
- **When:** only if the AI provider is configured **and** the mode is `on`. In `supervised` or `off` mode, or with no provider, starting is refused with the reason and nothing is sent.
- **How much:** at most 25 tasks per start; the response says how many remain. Starting again is idempotent.
- **Record:** an `assessment.backlog_started` audit entry. Tasks with too little evidence are answered by rules (no model call).

## Roles in one place

| | Employee | Manager | Admin |
|---|---|---|---|
| Own tasks, submissions, own assessments and history | yes | yes (own) | yes (own) |
| Team tasks, assignments, People, Reviews, assessment approve/adjust/dispute, contribution verification, reports, Work Intelligence | no | their teams | **only for a team they are explicitly assigned to manage** |
| Organization, users, invitations, roles, permissions, integrations, system settings, audit, system health | no | set-up screens for their own teams only (invitations, permissions of their people) | yes |

An admin is not a manager. An admin acts as a manager for a team only after being assigned as that team's manager in *Teams & members*;
nothing else grants it, and it covers only that team.
