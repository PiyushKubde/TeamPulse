# Phone alerts (M91)

M91 rings phones at full volume, through silent mode, until somebody answers. KONVO uses both of its credentials:

| | Credential | Who rings | Set up by |
|---|---|---|---|
| **On-call** | `M91_SEND_LINK` (one channel) | everyone in your on-call channel | the operator, once, in `.env` |
| **People** | `M91_API_KEY` (direct alerts) | one person's own phone | each user, in Settings → Profile → Phone alerts |

Every alert has two answers. Each one is named after its condition (`customId`), so a repeat doesn't ring again while it's
open, and it is closed when the condition clears, which re-arms it. Nothing is wired into a generic error handler or a
logger: only the conditions below ring anybody.

## On-call: when KONVO itself breaks

Checked every minute by the API process (so a dead worker is still noticed). Answers: **I'll handle it** · **Seen**.

| Condition (`customId`) | Rings when | Severity |
|---|---|---|
| `workpulse-database-down` | PostgreSQL unreachable for 3 checks in a row | CRITICAL (also phones) |
| `workpulse-worker-stalled` (scheduled jobs) | no worker heartbeat for 10 min, or the hourly job hasn't run for 2 h | HIGH |
| `workpulse-ingest-backlog` | over 200 app events waiting for 10 minutes | HIGH |
| `workpulse-sync-dead-<app>` | 3+ events from one app failed after all retries in the last hour | HIGH |
| `workpulse-api-errors` | over 20 server errors in 5 minutes | HIGH |
| `workpulse-email-failing` | 3 emails in a row failed (verification, reset, invitations) | HIGH |
| `workpulse-ai-failing` | 5 AI calls in a row failed (work continues without AI) | MEDIUM (rings, never phones) |
| `workpulse-delivery-failing` | 5 Slack/Gmail deliveries in a row failed | MEDIUM |

In the app: **Phone alerts (M91)** in the sidebar shows (to owners and admins) the channel, every condition with its
state, what is ringing now, the history, and a **Send test alert** button. From the command line: `npm run m91:test -w @workpulse/api` (a connection test that raises nothing, then
one LOW test alert).

## People: their own phone

Everyone gives a mobile number: at sign-up, when joining from a team invitation, and, for Google sign-ups and older
accounts, in a required step right after signing in. KONVO invites it to M91 straight away. An inviter can also add the
teammate's number to the invitation: their M91 invitation goes out at once and the number is pre-filled when they join. People who signed up earlier see a banner until they add one on the **Phone alerts
(M91)** page. The only manual step is the person accepting the invitation once in the M91 app
([iPhone](https://apps.apple.com/app/id6759090472) ·
[Android](https://play.google.com/store/apps/details?id=com.msg91.m91)); the worker checks pending invitations every
5 minutes, re-sends any that failed, and notifies the person when alerts are on. Every moment can be switched off on
that page.

Tests never reach real phones: `M91_API_KEY` and `M91_SEND_LINK` are blanked in `vitest.config.ts` and
`playwright.config.ts`, and the M91 tests use a fake transport.

| Moment | Who | Answers | What KONVO does with the answer |
|---|---|---|---|
| A critical task, or one due within 24 h, is assigned to you | assignee | **On it** · **Can't take it** (asks why) | starts the task / re-assigns it to the next best fit and records the reason |
| A task you manage is blocked for over 48 h | their managers | **I'll unblock it** · **Seen** | records who is unblocking and tells the assignee |
| Your critical task is overdue | assignee | **Working on it** · **Need more time** (asks why) | records it; "need more time" tells their manager |
| Someone disputes a rating or record | their manager | **I'll review it** · **Seen** | — |
| Your app connection expired | connection owner | **I'll reconnect** · **Seen** | — |

Answers are read back every minute by the worker (no public URL needed). Alerts close by themselves when the situation
clears (task finished or re-assigned, blocker resolved, dispute settled, connection back).

## Verified

- 2026-11-15: send link connection test → channel "New test"; one LOW test alert → `delivered: 1`.
- Personal alerts: built and covered by mocked tests (`apps/api/test/api-phone-alerts.test.ts`). The **real** check is
  waiting for `M91_API_KEY`: add it, connect your phone in Settings → Profile, and press **Send a test alert**.
