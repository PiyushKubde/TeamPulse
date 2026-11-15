# viaSocket plan — WorkPulse

Status: **APPROVED 2026-11-15** ("Proceed with the WorkPulse build"; AI via viaSocket's AI API with OpenAI models, added the same day).
Skill: `viasocket-integrations/SKILL.md` version `2026-11-14.1` → https://viasocket.com/docs/skill.md?format=sdk, pages
`app-integrations`, `actions-and-events`, `automations`, `setup`, `ai`, `journey`. SDK: `viasocket-apps@0.19.0` (types read).
Every key, version and id below is in `apps/api/src/integrations/catalog.ts`. They were checked against the live listing by
`npm run viasocket:selftest` and against the catalog by `npx -y viasocket-apps check` (0 FAIL).

## Who connects, where things run

- Each WorkPulse user connects **their own** account with the Connect button (`viasocket-apps/browser` `connect()`, embed
  token signed per user on the server). viaSocket end-user id = WorkPulse user id (UUID), never the email.
- The `auth_id` is accepted only if it is in **that user's** `listConnections()` for that app's `service_id`. It is stored
  AES-GCM encrypted. Expired connections show **Reconnect**, which updates the same `auth_id` in place.
- Every `script_id` (subscriptions, action flows, enabled app) is stored encrypted, used only for its owner, and never
  sent to the browser.

## Table

| app | action / trigger (key, version) | `inputData` key | who supplies it | when |
|---|---|---|---|---|
| linear | trigger `New_Issue_Created` v1 | `team_id` | the user, from their Linear teams (PICK, `listOptions` on this trigger) | once, after Connect |
| linear | trigger `Updated_Issue` v2 | `team_id` | same stored choice | once, after Connect |
| linear | trigger `New_Issue_Comment` v1 | `team_id` | same stored choice | once, after Connect |
| linear | action `Update_Issue_Status` v3 (flow, TWO_WAY only) | `teams` | stored team | once, after Connect |
| linear | action `Update_Issue_Status` v3 | `issue` | WorkPulse: the task's stored external id | per run |
| linear | action `Update_Issue_Status` v3 | `stateID` | the user's status map (PICK, `listOptions` with `teams`) | once, when enabling two-way |
| linear | `runCode` on the enabled app (Linear GraphQL, backfill) | `team`, `after`, `since` | stored team, page cursor, checkpoint | per run (import) |
| jira-software-cloud | trigger `New_Issue` v2 | `project` | the user (PICK) | once, after Connect |
| jira-software-cloud | trigger `New_Issue` v2 / `Updated_Issue` v4 | `status` | left out on purpose: all statuses sync | — |
| jira-software-cloud | trigger `Updated_Issue` v4 | `project` | stored project (PICK via this trigger) | once, after Connect |
| jira-software-cloud | action `Find_Issue_via_JQL` v1 (flow, backfill) | `jql` | WorkPulse builds `project = "<stored>" AND updated >= "<checkpoint>"` from validated values | per run |
| github | trigger `Pull_Request_Opens_or_Closes` v22 | `repoFullName` | the user picks repositories (PICK); one subscription per repo | once, after Connect |
| github | trigger `New_Commit_Pushed` v6 | `repoFullName` / `sha` | stored repo / constant `main` (the trigger's own default branch) | once |
| github | trigger `New_Release_Published` v6 | `repoFullName` | stored repo | once |
| github | trigger `When_a_new_issue_is_created` v7 | `repoFullName` | stored repo; only when the user turns on "import GitHub issues as tasks" | once |
| slack | trigger `New_Message_Posted_in_Channel_Instant` v2 (added 2026-11-15) | `channel_id` | the user picks the intake channel (PICK, `listOptions` on this trigger) | once, after Connect |
| slack | action `Send_Message` v107 (per-user webhook flow) | `destination.messageto` | the user: a channel or a DM to themselves | once, at setup |
| slack | action `Send_Message` v107 | `destination.channel_id` / `destination.userId` | the user (PICK) | once, at setup |
| slack | action `Send_Message` v107 | `markdown_content` | WorkPulse report or alert text (AI summary paragraph optional, validated, length-capped) | per run |
| slack | action `Send_Message` v107 | thread keys, `tagged_users`, `buttons`, `schedule_type`, `bot_details`, `preview` | left out on purpose (plain immediate post) | — |
| gmail | action `Send_Email` v55 (per-user webhook flow) | `to` | WorkPulse: the user's own verified email (constant per user, baked into the flow) | once, at setup |
| gmail | action `Send_Email` v55 | `subject`, `messageBody` | WorkPulse report content | per run |
| gmail | action `Send_Email` v55 (system mail flow of the sending owner/admin) | `to`, `subject`, `messageBody` | WorkPulse: the recipient of a verification, reset or invitation email (validated) | per run |
| gmail | action `Send_Email` v55 | `fromName` | constant `WorkPulse` | — |
| gmail | action `Send_Email` v55 | `from`, `cc`, `bcc`, `replyTo`, `attachments`, `labelIds` | left out on purpose (sends as the connected account) | — |
| viaSocket AI | `user.ai.send` (`json_schema`, strict) | message, prompt, schema | WorkPulse code; model `openai/gpt-6-luna` (structured) and `openai/gpt-6.1-terra` (assistant) | per run |

**Who picks each action:** always WorkPulse's code, from the allowlist. Actions fixed in code (`Send_Message`, `Send_Email`,
`Update_Issue_Status`, `Find_Issue_via_JQL`) are each a **flow per user**: webhook trigger, one step, created with the
automations API and stored as `flow:<name>`. Triggers are `user.subscribe` with a handler that POSTs `context.req.body` to
WorkPulse's events endpoint with a per-subscription bearer token. The only enabled app is Linear's, used solely for the
backfill `runCode`; no `script_id` is ever given to an AI. **The AI never picks an action.** The assistant's tools are
WorkPulse's own read-only functions, run under the caller's permissions.

**Not built (needs no plan row yet):** Trello, Asana, ClickUp, Notion, Google Calendar, Google Sheets. Their triggers exist in
the catalog, but nothing is exposed until an adapter is built and tested.
