# ViaSocket plan — TeamPulse (A, B, C, D)

Status: **PROPOSED — waiting for the yes.** Source of truth: https://viasocket.com/docs/skill.md?format=sdk (skill `2026-11-04.3`),
with the `viasocket-apps` package (upgrade 0.7.0 → 0.19.0: apps by slug, actions by key + pinned version, triggers by `subscribe`).

## Scoping (all four)

- viaSocket `userId` = the TeamPulse user's id (UUID), never an email. Every connection, enabled app (`script_id`) and
  subscription belongs to exactly one TeamPulse user and is used only on that user's behalf.
- `auth_id` and every `script_id` stay on the server; before any run the server checks the signed-in user owns it.
  The browser only gets that user's embed token.
- Automations only send messages or create **pending** task requests. They never create, assign or approve tasks, so
  TeamPulse's approval and permission rules are untouched.

## A. Task assigned → Slack / Gmail

A1 (new, the default): each employee turns on "Notify me" in *Settings → Profile* with **their own** Slack or Gmail.
A2 (exists): a manager posts every assignment in their team to a team Slack channel, or emails the assignee, from the manager's connection.
Who picks the action: TeamPulse's code (on every assignment), from the channel the user chose.

| app | action (key, version) | key of `inputData` | who supplies it | when |
| --- | --- | --- | --- | --- |
| slack | `Send_Message` `v107` | `destination.messageto` | the employee: "DM me" (`user`) or "a channel" (`channel`) | once, after Connect |
| slack | `Send_Message` `v107` | `destination.userId` | the employee picks themself (PICK "Users") | once, after Connect |
| slack | `Send_Message` `v107` | `destination.channel_id` | the user picks a channel (PICK "Channels") | once, after Connect / at setup |
| slack | `Send_Message` `v107` | `markdown_content` | TeamPulse: task title, priority, due date, link | per run |
| slack | `Send_Message` `v107` | thread keys, `tagged_users`, `buttons`, `schedule_type`, `bot_details`, `preview` | left out on purpose (plain immediate post) | — |
| gmail | `Send_Email` `v55` | `to` | TeamPulse: the assignee's Google-verified email | per run |
| gmail | `Send_Email` `v55` | `subject`, `messageBody` | TeamPulse: task details + link | per run |
| gmail | `Send_Email` `v55` | `fromName` | constant `TeamPulse` (same for every user) | — |
| gmail | `Send_Email` `v55` | `from`, `cc`, `bcc`, `replyTo`, `attachments`, `labelIds` | left out on purpose (sends as the connected account) | — |

## B. Weekly team report (Mondays 09:05 IST, Embarko schedule)

Each manager (and admin) sets up their own report for **their own scope** (today: one per organization → change to one per manager).
Same two actions as A, from the manager's own connection.

| app | action | key | who supplies it | when |
| --- | --- | --- | --- | --- |
| slack | `Send_Message` `v107` | `destination.messageto` | constant `channel` | — |
| slack | `Send_Message` `v107` | `destination.channel_id` | the manager (PICK "Channels") | once, at setup |
| slack / gmail | `markdown_content` / `messageBody`, `subject` | TeamPulse: verified outcomes, contributions, blockers, missed commitments with reasons | per run (weekly) |
| gmail | `Send_Email` `v55` | `to` | the manager types recipients at setup (default: their own email) | once, at setup |

## C. Incoming email / Slack message → pending task request

A manager subscribes **their own** Gmail or Slack; each matching message becomes a PENDING task request for their team
(source "external", never assigned, idempotent by message id). The handler runs on viaSocket and posts the event to
`POST /api/viasocket/events/:subscriptionId` with a per-subscription bearer token (stored hashed). Field mapping is
taken from a real `sampleEvent`, never from the page sample.

| app | trigger (key, version) | key | who supplies it | when |
| --- | --- | --- | --- | --- |
| gmail | `New_Email_Arrives` `v11` | `thread` | constant `first_email_only` (replies are not new requests) | — |
| gmail | `New_Email_Arrives` `v11` | `query` | constant `["label"]` (recommended) or the manager adds sender/subject | once, at setup |
| gmail | `New_Email_Arrives` `v11` | `searchFields.label` | the manager picks a Gmail label, e.g. "TeamPulse" (PICK) | once, at setup |
| gmail | `New_Email_Arrives` `v11` | `searchFields.senderEmail`, `.subject` | the manager types them, only if chosen | once, at setup |
| slack | `New_Message_Posted_in_Channel_Instant` `v2` | `channel_id` | the manager picks one intake channel (PICK "Channel") | once, at setup |

Request fields (TeamPulse, per event): title ← subject / first line; description ← body / message; requester ← sender;
externalRef ← message id / channel+ts. Bot messages are ignored (no loops with A/B posts).

## D. Full Embed + selected apps in context

- Full Embed: *Automation Center → Advanced builder* (exists): `viaSocket.mount` with the user's embed token; flow
  events checked against `https://embedfrontend.viasocket.com` and read back with `user.listFlows()`.
- Selected apps in context, each a drawer with the prebuilt UI restricted by `filteredServices` to that one app's
  chosen events, started from a TeamPulse event that TeamPulse POSTs to the user's published flow:
  - *My Tasks* → "When a task is assigned to me" → **Google Calendar** (create an event for the deadline).
  - *Reports* → "When my weekly report is ready" → **Google Sheets** (add the summary as a row).
  - *Automation Center → Connected apps* → **GitHub** builder filtered to GitHub.
  Flows are the user's own; TeamPulse stores each published flow's id + status per user and sends only that user's data.

## Missing configuration / needed from the person

1. Yes to this plan (and the A1/A2 and per-manager B choices).
2. ViaSocket keys on Embarko — I set them with the deploy token after the yes (they are already in local `.env`).
3. Test accounts of your own, connected through TeamPulse's own Connect button on https://teampulse.embarko.app
   (signed in as you): a Slack workspace with a test channel, and a Gmail account. For C also a Gmail label (e.g.
   "TeamPulse") and a Slack test channel. Not the existing connections of `apps-api-test-user` (other people's).
4. Your yes before each real send: every test message goes only to you / your test channel.
