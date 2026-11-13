# Slack task intake, acceptance and escalation

Work that matters, made visible: a Slack message tags a person, TeamPulse turns it into a task for them, they accept, decline or
transfer it, and M91 escalates if it stalls or its deadline slips. Migration `010_slack_task_intake.sql` (additive; existing
rows are copied unchanged).

## Flow

1. A manager switches a Slack intake channel to **Create tasks for tagged people** (`assign_from_mentions`). Existing intakes keep
   creating pending requests. Only channels the manager chose are read; never every channel, DMs or private chats.
2. Each message is interpreted by deterministic rules (`server/automations/slack-tasks.js`). Conversation, greetings, questions,
   status updates, completions, blockers, bot messages and TeamPulse's own messages are ignored.
3. The person tagged to do the work becomes the **initial assignee** only when their Slack user id is mapped to a TeamPulse person
   **by a manager** (Slack identities). A display name is never matched. Anything else becomes a normal pending request for a
   manager (no tag, several primary tags, unmapped or unconfirmed id, person outside the intake owner's teams) with the reason.
4. The task starts as `PENDING_ACCEPTANCE`. The requester is recorded on the task source and as a participant, never as owner.
   `with help from / cc` tags become `SUPPORT`, `reviewer ...` tags `REVIEWER`; they are not owners and not counted as contributions.
5. The assignee accepts (`ASSIGNED`, their clock starts), declines with a reason (`DECLINED`, the manager decides) or transfers
   to a teammate in their own team, who must accept before ownership moves. Every step is a row in `task_assignments` /
   `task_transfers` plus a task event; nothing is overwritten.
6. Alerts escalate (below). A missed deadline requires an explanation from the owner and a manager review.

## What is extracted (and what is not invented)

Title, description, expected outcome (only if stated: "so that…", "goal:…"), deadline, priority (only if stated; otherwise the
default `MEDIUM`), dependencies and possible blockers (stated phrases), thread context (the parent message when a reply is too
short to say what the work is). Deadlines are resolved only when the words settle them ("tomorrow", "by Friday", "20 Nov",
"in 3 days", "by tomorrow 5pm"), relative to when the message was posted, in the **organization timezone**
(`PATCH /api/organization {timezone}`, admin). A date without a time ends the day (23:59) in that timezone, DST included.
Vague ("soon", "next week", "next Friday", a weekday that is today) or past times leave the deadline unset.

**No AI is used for extraction.** Every result is labelled `extraction: "deterministic"`. Nothing from Slack is sent to an external
provider, so no privacy approval is involved. (AI-assisted extraction is not built; see Not built.)

## Escalation ladder

| Severity | Rule | When | Who | Default |
| --- | --- | --- | --- | --- |
| LOW | `task_assignment` | a task is assigned for acceptance, or handed over by an accepted transfer | the assignee | on |
| MEDIUM | `no_movement` | no meaningful movement since the owner accepted | managers | 24 h (`noMovementHours`) |
| HIGH | `deadline_approaching` | the deadline is within the window (short deadlines warn at once) | owner and managers | 24 h (`deadlineApproachingHours`) |
| CRITICAL | `deadline_missed` | the deadline passed and the task is not done | owner and managers | on |

Every alert is an in-app notification first; M91 is layered on top through the existing queue, retries and callbacks. Thresholds
are set by an **admin** (`PATCH /api/alerts/settings`). Severity is sent to M91 as given (the previous build capped automatic alerts
at HIGH; `deadline_missed` is now CRITICAL and `deadline_approaching` HIGH).

Idempotency keys (rule + task + anchor + person): LOW per assignment event; MEDIUM per idle stretch (anchor = the moment the
stretch began); HIGH per deadline; CRITICAL per missed deadline. A moved deadline closes the old deadline's M91 alerts and is a new
condition; real movement closes the open MEDIUM alert; a new owner starts a new clock; completion or cancellation closes
everything open for the task.

**Meaningful movement:** starting work, a changed percentage or a note of at least 15 characters, the owner reporting or
resolving a blocker, the owner adding evidence, submitting for review. **Not movement:** accepting, opening, notifications,
comments, an unchanged re-save, anything done by someone else, background sync.

**Clock rules:** no clock while `PENDING_ACCEPTANCE` or `DECLINED`; paused while a transfer waits for an answer (the paused time is
subtracted afterwards, whatever the outcome); restarted for a new owner. The clock applies only to work that went through
acceptance, so ordinary tasks behave as before.

## Missed deadlines

The first scan (or a late submission) writes a `deadline_missed` task event, once per deadline; it survives completion and a
moved deadline. The owner sees a required form (category, written explanation — mandatory for "Other" — optional links). The
explanation is stored once per deadline; later context and every manager review (`REVIEWED`, `ACCEPTED`, `NEEDS_CLARIFICATION`,
`FOLLOW_UP_REQUIRED`, with comments) are appended entries, so nothing is overwritten. A manager cannot review their own.

A missed deadline never lowers a rating: it is passed to the measurement as context (blockers outside the person's control, deadline
changes, the explanation and its review) together with prompt rules (`work-eval-2026-11-v4`) saying so, and no score, rank or
penalty is derived from it. Ownership is passed the same way: the Slack tag is a *proposal*, acceptance is acknowledged
responsibility; declining, asking for clarification or handing a task over is explicitly not a mark against the person.

## Slack identities

`POST /api/slack-identities {userId, slackUserId, workspaceId?}` (managers for people in their teams, admins for anyone).
A self-declared id (My Work Evidence) is only a claim until a manager confirms it; a confirmed mapping cannot be removed by the
employee. If a workspace id is stored and the event carries a different one, the mapping is not trusted. Unmapped and unconfirmed
ids seen in task messages are listed for managers (`GET /api/slack-identities → unresolved`).

## API

`GET /api/assignments/inbox`, `GET /api/tasks/:id/workflow`, `POST /api/tasks/:id/accept | decline | transfer`,
`POST /api/transfers/:id/decision | cancel`, `POST /api/tasks/:id/deadline-explanation`, `GET /api/deadline-explanations`,
`POST /api/deadline-explanations/:id/context | review`, `GET /api/slack-intake/overview` (filters: `assigneeId`, `teamId`, `status`,
`acceptance`, `severity`, `due`), `GET/POST/DELETE /api/slack-identities`, `POST /api/intakes/:id/mode`. All authorization is
server-side; out-of-scope records answer 404.

## Data retention (approved by the owner: 24 hours)

Task messages keep their full text as the task's source evidence for as long as the task exists. For **messages that did not
become a task**, `slack_intake_items` keeps only a 500-character excerpt and the sender's name for **24 hours**
(`IGNORED_TEXT_RETENTION_DAYS = 1`), erased by the scheduled job (`purgeIgnoredText`, every 15 minutes on Embarko, so an excerpt
is gone between 24 h and 24 h 15 min after it arrived); bot and TeamPulse messages keep no text at all. Thread context therefore
works for a reply posted within about a day of its parent. This applies only to channels a manager switched to "create tasks
for tagged people".

*Why:* a thread reply like "@Priya can you take this?" is actionable only with its parent, and the parent is usually ordinary
chat that was rightly not made a task. Without a short-lived excerpt, thread replies could use only a parent that itself became a
task or a manager request.

*Scope of the purge:* it blanks `text` and `sender_name` of `outcome = 'IGNORED'` rows only. It never touches tasks, requests,
`TASK_CREATED` or `NEEDS_MANAGER` items. The metadata of ignored messages (channel, timestamp, Slack ids of sender and mentions,
outcome and reason) is **kept**, because it is the idempotency record that stops a redelivered event being processed twice.

The 24-hour excerpt retention was chosen by the owner. The indefinite retention of the metadata of ignored messages (needed for
duplicate protection) is part of the same design and is unchanged. To change the period, edit `IGNORED_TEXT_RETENTION_DAYS`; to
store no excerpt at all, stop saving it in `processSlackTask` (thread context then works only from parents that became tasks or
requests). Nothing else in this feature deletes data.

## Not built / limits

* AI-assisted extraction (rules only; labelled as such). Slack message *edits* and deletions are not followed.
* The viaSocket Slack trigger payload was not verified against a live Slack workspace: field names are read leniently
  (`user`, `team`, `permalink`, `thread_ts`); a permalink appears only if the event carries one. Live Slack and live M91 delivery
  are **not verified**; tests use recorded-event posts and a recording M91 stand-in.
* Individual M91 routing is not assumed: with a channel send link, one alert per condition reaches the channel.
* Thresholds are admin-only, not manager-editable. Employee-initiated transfers are limited to the owner's own team.
