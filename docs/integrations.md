# Integrations setup

KONVO uses viaSocket for every external app: sign-in, tokens, webhooks and the AI. The server needs three values.
The person who owns the viaSocket workspace gets them once:

```bash
npx -y viasocket-apps setup --no-open     # prints a sign-in link; click Allow; writes .env
```

or copies them from https://flow.viasocket.com/embed-keys?project=<project id> into `.env`:

```
VIASOCKET_ORG_ID=…
VIASOCKET_PROJECT_ID=…
VIASOCKET_EMBED_SECRET=…    # server only; never in frontend code, logs or Git
```

Check them with `npm run viasocket:selftest`.

## Live sync needs a public address

`npm run dev` opens an ngrok tunnel automatically when `PUBLIC_API_URL` is empty and ngrok is installed and signed in;
the worker re-points every subscription to the current address on start-up.

Triggers (new or updated issues, PRs, Slack messages) are delivered by viaSocket to
`$PUBLIC_API_URL/api/integrations/events/<provider>/<subscriptionId>`. Without `PUBLIC_API_URL` you can still connect,
import existing issues and send reports; live sync stays off and the Integrations page says so. Locally, use a tunnel:

```bash
cloudflared tunnel --url http://localhost:4000      # then set PUBLIC_API_URL to the https URL it prints
```

After changing `PUBLIC_API_URL`, re-save each connection's choices so the handlers point at the new address.

## Per app

| App | What the user chooses once | What happens |
|---|---|---|
| Linear | team; sync mode; optional status map for two-way; optional people matching | new/updated issues and comments sync; **Import existing issues** backfills 90 days; two-way pushes status changes |
| Jira | project; sync mode; people matching | new/updated issues sync; import via JQL |
| GitHub | repositories; optionally "import new issues as tasks" | PRs, commits and releases become evidence, matched to a task by key (ENG-42 / PROJ-7 / org/repo#12); others wait in Reviews → Unmatched |
| Slack | a channel to turn into tasks; a channel or DM for reports | every human message in the intake channel is read by AI: work requests become tasks (title, priority, due date, assignee when a real member is named), chatter is skipped, a confirmation is posted back; bot messages are ignored. Reports and blocker escalations go to the delivery destination |
| Gmail | (none) | reports emailed from your account to your own address. When an owner/admin connects Gmail and no SMTP is set, it also sends KONVO's system email (verification, password reset, invitations) |

## Sync modes

- **Import only**: a one-time backfill; later changes are not applied.
- **One-way** (default): external changes update the external-owned fields (title, description, status, priority,
  assignee, due date, labels). Impact, complexity, assessments, evidence verification and feedback are never touched.
- **Two-way** (Linear, opt-in): status changes in KONVO are pushed to the mapped Linear state. A field changed on both
  sides since the last sync becomes a conflict for a person to resolve. Nothing is overwritten silently.

## Unknown values

A status or priority KONVO doesn't recognise is imported with a safe default (TODO / MEDIUM) and the task is flagged
**Needs review**. With AI enabled, a suggested mapping and confidence are recorded. A manager or admin approves or
changes it in **Integrations → Mappings**, and the waiting events are re-applied.

## AI

`AI_PROVIDER=viasocket` (default) uses OpenAI models through viaSocket with the same three keys: no model key, billed by
viaSocket. `AI_PROVIDER=openai` uses `OPENAI_API_KEY` directly. AI is on whenever its credentials are present (the
separate data-policy switch was removed at the owner's request on 2026-11-15); `AI_PROVIDER=` (empty) turns it off.
