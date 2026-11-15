# viaSocket test report

Last run: 2026-11-15. Project `proj0suIrGwW` (org 4160). Real and mocked results are kept apart.

## A. Real checks (live viaSocket, no customer data)

`npm run viasocket:selftest` uses an isolated end user (`workpulse-selftest`) and synthetic text only.

| Check | Result |
|---|---|
| Setup check: `listConnections('apps-api-test-user')` with the project keys | PASS (keys valid; existing connections belong to someone else and were not used) |
| Catalog: every trigger/action key, version and id exists in the live `listActions` for linear, jira-software-cloud, github, slack, gmail | PASS (13 events) |
| Embed token for the Connect popup (`user.token()`) | PASS |
| `automationToken` → `createFlow` → `setTrigger(webhook)` → `saveSteps` → `readFlow` | PASS |
| Webhook flow run returns the last step's value | PASS (`{"echoed":"workpulse"}`) |
| `runHistory` (logs arrive 5–15 s after a run; response `{ finalResponse: [] }`) | PASS, after fixing the parser (see below) |
| `deleteFlow` cleanup | PASS |
| `user.ai.send` with strict `json_schema` (`openai/gpt-6-luna`) | PASS (`{"priority":"CRITICAL","title":"Fix login outage affecting all customers"}`) |
| `npx -y viasocket-apps check apps/api/src/integrations` | **0 FAIL, 0 WARN over 17 files** (output below) |

Found by the real run and fixed: `runHistory` read `data` instead of `finalResponse`, so the Automation Center's run history
would always have been empty. The fix also maps only documented user-facing fields (`requestSnapshot`, which holds
request headers, never leaves the server).

```
PASS slug linear resolves to rowefyo4xtra (1 place)
PASS slug jira-software-cloud resolves to row7n1sif96o (1 place)
PASS slug github resolves to rowcqz5hd8o5 (1 place)
PASS slug slack resolves to rowbu58rc (1 place)
PASS slug gmail resolves to rowo0bqrhj5g (1 place)
PASS rowm5zd4n3lt is Linear's trigger_id for "New Issue Created"
PASS row6a0fpu4gh is Linear's trigger_id for "Updated Issue"
PASS rowcv4jphhb7 is Linear's trigger_id for "New Issue Comment"
PASS rowdqvg70194 is Jira Software Cloud's trigger_id for "New Issue"
PASS rowvosv9vh09 is Jira Software Cloud's trigger_id for "Updated Issue"
PASS rowru54g3wrd is GitHub's trigger_id for "Pull Request Opens or Closes"
PASS rowaygkq46ev is GitHub's trigger_id for "New Commit Pushed"
PASS rowi8rqh3mlu is GitHub's trigger_id for "New Release Published"
PASS rowbsm4g8zdq is GitHub's trigger_id for "When a new issue is created"
PASS rowcz65p8jcd is Linear's action_id for "Update Issue Status "
PASS rowu6c69h46o is Jira Software Cloud's action_id for "Find Issue via JQL"
PASS row1jrbor is Slack's action_id for "Send Message"
PASS rowogelpy0h6 is Gmail's action_id for "Send Email"
INFO VIASOCKET_TEST_EMBED_TOKEN not set — token check skipped
0 FAIL, 0 WARN over 17 files — paste this output in your report
```

## A2. Real checks added 2026-11-15 (Slack intake)

| Check | Result |
|---|---|
| `user.subscribe('slack', 'New_Message_Posted_in_Channel_Instant', v2)` on the owner's real Slack connection, channel `all-aryans-workspace` | PASS (subscription ACTIVE) |
| `sampleEvent` for that trigger on the real connection | PASS: an Events API envelope (`event`, `team_id`, `event_id`, …); the adapter normalizes it; `token`, `authorizations` and `viasocketHelp` are stripped before storage |
| ngrok tunnel → `/health` from the public URL | PASS |
| A real Slack message arriving and becoming a task | waiting for a human message in the channel |

## B. BLOCKED: needs connected test accounts and a public URL

None of these ran. Each needs a real test account connected through WorkPulse's own Connect button, and for triggers a
public HTTPS `PUBLIC_API_URL` where viaSocket can deliver events (locally, for example, `cloudflared tunnel --url http://localhost:4000`).

| Item | Why it's blocked | How to run it |
|---|---|---|
| Linear: Connect, team `listOptions`, `sampleEvent` for each trigger, subscribe, receive a real issue create/update/comment, two-way `Update_Issue_Status`, backfill `runCode` | no Linear test workspace connected; no public URL | connect a Linear **test** workspace in Integrations, set `PUBLIC_API_URL`, create and edit an issue in a test team |
| Jira: Connect, project `listOptions`, triggers, `Find_Issue_via_JQL` backfill | no Jira Cloud test project | same, with a test project |
| GitHub: Connect, repo `listOptions`, PR/commit/release triggers | no test repository | same, with a test repository |
| Slack: Connect, channel/user `listOptions`, `Send_Message` via the per-user flow | no Slack test workspace | connect, choose a test channel or yourself, press **Send test message** |
| Gmail: `Send_Email` via the per-user flow | no Gmail test account | connect, press **Send test message** (it goes to your own address) |
| Adapter field mapping against a real `sampleEvent` | the Linear/Jira trigger pages have "no sample yet"; adapters accept both the raw webhook envelope and the bare record | after connecting, compare Sync History → Inspect with the adapters, and adjust if a field differs |

**Not deployed or switched on:** live sync is off until `PUBLIC_API_URL` is set. Each app card says "Not yet verified with
a live account" until `verifiedLiveAt` is set in `catalog.ts` after these checks pass.

## C. Mocked tests (deterministic, `apps/api/test/api-integrations.test.ts`)

A fake transport stands in for viaSocket. These prove WorkPulse's own logic, not viaSocket's behaviour. 24 tests, all
passing: the connection ownership check, encryption at rest, subscription per catalog trigger and per repo, cross-user
404s, provider failure (rate limit / downtime) recorded on the connection, disconnect + revoke, expired connections,
bad/unknown tokens (401), malformed bodies (400), the spec's Linear example normalized, duplicate deliveries absorbed,
out-of-order events skipped as stale, status/priority/due updates, internal fields never overwritten, one-way vs two-way
conflict detection and resolution, import-only skipping live events, unknown status flagged → mapping approved →
reprocessed, invalid payloads failing permanently, transient failures retried then dead-lettered, retry endpoint scoping,
archive on delete, comment sync, GitHub evidence matched by task key, and unmatched evidence never auto-applied.

## D. The skill's "Finished when" list

**App integrations** (`skill/app-integrations.md`):

| Line | Status | How |
|---|---|---|
| Confirmed | DONE | plan shown 2026-11-15, approved the same day; table in `viasocket-plan.md` (AI via viaSocket added at the person's request) |
| Who connects | DONE in code, **UNTESTED live** | each WorkPulse user, Connect button with the app's icon; `auth_id` per user, ownership-checked, encrypted; Reconnect in place |
| Where and when each value comes from | DONE | every `inputData` key decided in the table: once after Connect (PICK), per run (WorkPulse data), constant with a reason, or left out on purpose |
| Who picks the action | DONE | WorkPulse code only; fixed actions are per-user flows; the only enabled app is Linear's, for backfill `runCode`; AI never picks |
| Where it runs | DONE | actions from the server; script_ids owner-checked and encrypted; events via handler → authenticated endpoint, each saved as a SyncEvent; the browser holds only the embed token |
| Tested | **BLOCKED** | no action ran on a test connection and no subscription saw a real event (section B). Automations and AI did run for real (section A) |
| Proof | PARTIAL | checker output above (0 FAIL); one real call's response: the webhook flow `{"echoed":"workpulse"}` and the AI `json_schema` answer above. No real app action response yet |

**Automations** (`automations.md`):

| Line | Status |
|---|---|
| 1. `automationToken` for the test user | DONE |
| 2. `createFlow`/`setTrigger`/`saveSteps` without throwing; `readFlow` shows trigger and steps | DONE (code-only step) |
| 3. Plugin trigger `sampleEvent` | not applicable (WorkPulse flows use webhook triggers; app events use `subscribe`) |
| 4. It ran once and `runHistory` shows it | DONE for the self-test flow; **BLOCKED** for `Send_Message`/`Send_Email`/`Update_Issue_Status`/`Find_Issue_via_JQL` flows (need connections) |
| 5. Checker 0 FAIL, resolving every action_id | DONE |

Progress events were sent to viaSocket's journey endpoint at each milestone (no code, names or secrets).
