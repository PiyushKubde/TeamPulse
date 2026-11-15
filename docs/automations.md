# How WorkPulse's automations work

Everything below runs by itself once an app is connected and its one-time choices are made. Nobody has to press a button.
Each connection works in two directions:

- **Into WorkPulse:** work and evidence arrive and become tasks or evidence.
- **Out of WorkPulse:** reports, alerts and status updates go out.

## 0. Who gets each task (automatic, every source)

Every new task, whether from the task form (Auto-assign, the default for managers), the AI assistant, a Slack message,
or a new open Linear, Jira or GitHub issue without a known assignee, gets an owner automatically:

1. **A named person** ("assign to Neha Gupta", a Linear assignee whose name matches a member) gets it, as long as the
   requester is allowed to assign them (admins: anyone; managers: their teams; members: themselves).
2. **Otherwise AI picks the best fit** among the people the requester may assign, weighing role and title, team, recent
   completed work and current load (open tasks, estimated hours). It prefers individual contributors for execution work.
3. **Without AI**, a rule decides: overlap between the task's words and each person's recent work, minus their load.

The choice and its reason are written to the task's Activity ("assigned automatically to Rohan Das: recent run-queue
work and spare capacity"), and the person is notified. Tasks imported as already completed or cancelled stay unassigned,
because guessing who did past work would give false credit in the scores. The assistant creates tasks immediately; there
is no review step.

## 1. Into WorkPulse (event-driven, within seconds)

viaSocket watches the app for you and forwards each event to WorkPulse. WorkPulse saves the event once (duplicates are
ignored), and the background worker turns it into a task.

| App | You choose once | Event | What WorkPulse does |
|---|---|---|---|
| Slack | intake channel | a person posts a message | AI decides: a work request becomes a task (title, priority, due date, assignee if a real member is named); chatter is skipped; bot messages are ignored; a "✅ Task created" confirmation is posted back |
| Linear | team | issue created / updated / commented | creates the task, then keeps title, status, priority, assignee, due date and labels in sync; comments are added; deleted issues archive the task |
| Jira | project | issue created / updated | same as Linear |
| GitHub | repositories | PR opened/merged, commit pushed, release published | evidence on the task whose key it mentions (ENG-42, M91-7); otherwise it waits in Reviews → Unmatched. New issues become tasks if you turn that on |

Rules that always apply:
- An update older than what WorkPulse already has is skipped.
- Impact ratings, manager assessments, evidence verification and feedback are never changed by an app.
- Statuses and priorities WorkPulse doesn't know (like "QA Ready") are imported as To do, marked "Needs review", and listed
  under Integrations → Unrecognised values. AI suggests a meaning; a manager approves once and every waiting task is fixed.
- Failures are retried 5 times with increasing delays. If they still fail, they show in Sync History with a Retry button,
  and the connection owner is notified.

**One-time import:** "Import existing issues" copies the last 90 days from Linear or Jira.

## 2. Out of WorkPulse

| What | When | Where it goes |
|---|---|---|
| "Task created" confirmation | right after a Slack message becomes a task | your Slack destination |
| Status update | when a Linear-imported task changes status in WorkPulse | the Linear issue (only if you switched on "Update the Linear issue", with a status mapping) |
| Daily report | weekdays 18:00, your time zone | your Slack destination |
| Weekly report | Mondays 08:00 UTC | in-app for everyone, and Slack for people with a destination; team reports go to each team's manager |
| Blocker escalation | hourly check: anything blocked over 48 h | in-app and Slack for the person's managers |
| Any report on demand | "Send to Slack" / "Email me" on a report | your Slack destination / your own email |
| System email | verification, password reset, invitations | SMTP if configured, else the Gmail an owner/admin connected |

## 3. Scheduled jobs inside WorkPulse (no app needed)

| Job | Schedule | What it does |
|---|---|---|
| Deadline reminders | hourly | in-app notice for tasks due within 24 h |
| Overdue alerts | hourly | in-app notice for overdue tasks |
| Morning planning nudge | weekdays 09:00 local | "Plan your day" if no plan exists |
| End-of-day review nudge | weekdays 17:00 local | "Close your day" if the plan isn't reviewed |
| Recurring tasks | when one is completed | the next occurrence is created |
| Score snapshots and goal check | nightly 02:00 UTC | weekly scores for every person and team; goal progress recalculated from key results; goals falling behind are marked "At risk" and their owner is notified |

## 4. Where to watch it

- **Automation Center:** every live subscription and delivery flow, its event counts, run history and failed deliveries.
- **Sync History:** every received event and its outcome (created, updated, skipped as stale, needs mapping, failed),
  with Inspect and Retry.
- **Notifications** (bell): everything above that concerns you.

## 5. Local requirements

`npm run dev` starts the API, the worker (which runs every scheduled job) and the web app, and opens an ngrok tunnel so
viaSocket can deliver events to your machine. On restart the worker re-points all subscriptions to the new address.
