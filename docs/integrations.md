# Integrations

## Google sign-in

1. Google Cloud Console → **APIs & Services → OAuth consent screen**: set the app name, support email, and scopes `openid`, `email`, `profile`.
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. Authorized redirect URIs:
   - `http://localhost:3000/auth/google/callback` (local)
   - `https://<app-name>.embarko.app/auth/google/callback` (Embarko; also any custom domain)
4. Set `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `GOOGLE_REDIRECT_URI` (exactly one of the URIs above).

Flow: `/auth/google` stores state, nonce and a PKCE verifier server-side (10 minutes, single use) → Google → `/auth/google/callback` exchanges the code, verifies the ID token's RS256 signature against Google's JWKS, issuer, audience, expiry and nonce, then upserts the user by `sub`. A new user has no role until they create an organization, accept an invitation sent to their Google-verified email, or have a join request approved.

**Status:** implemented and covered by tests with a simulated Google (signed tokens, forged signature, wrong audience/nonce/issuer, expiry). A live Google sign-in needs the credentials above.

## ViaSocket

TeamPulse uses `viasocket-apps` **0.19.0** (apps by slug, actions and triggers by key with a pinned version). The plan,
every value and who supplies it: [`viasocket-plan.md`](../viasocket-plan.md). Keys: `VIASOCKET_ORG_ID`,
`VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET` (server only).

| | What | Whose account | Where in TeamPulse |
| --- | --- | --- | --- |
| A1 | Task assigned to me → Slack DM / channel or Gmail | the person's own | Settings → Profile → My notifications |
| A2 | Task assigned in my team → team channel / DM me / email assignee / email me | the manager's own | Automation Center → Ready-made |
| B | Weekly report (Mondays 09:05 IST) → Slack or Gmail; managers: their teams, admins: organization | the manager's / admin's own | Automation Center → Ready-made; Reports |
| C | Gmail label / Slack channel → **pending** task requests | the manager's own | Automation Center → Ready-made → Gmail / Slack intake |
| D | Full builder; restricted builders from My Tasks, Team Tasks, Reports | the person's own | Automation Center → Advanced builder; "Automate" buttons |

Isolation: every connection, enabled flow (`script_id`), subscription and flow belongs to one TeamPulse user id; the
server checks ownership before every run; only the per-user embed token reaches the browser.
Loops and duplicates: every outgoing message carries "Sent by TeamPulse" and the intake ignores it; Slack bot posts and
thread replies are ignored; an intake channel can never also be an outgoing channel; each email/message creates at most
one request (`externalRef` = message id); intake never assigns or approves.

## M91 (MSG91) alerts

M91 rings a person's phone (through silent mode) until they answer, and returns the answer to the software.
Implemented against the official contract, https://m91-api.msg91.com/api/public/api.md (Platform API, read 2026-11-09):

| Step | Call | TeamPulse |
| --- | --- | --- |
| Invite a person | `POST /api/v1/recipients {phone, label}` | when someone saves a phone in *Settings → Profile*; they must accept in the M91 app |
| Raise an alert | `POST /api/v1/alerts {phone, title, description, severity, responseOptions, other, isAutoClose, customId, callbackUrl}` | queued per alert rule with M91 switched on; `customId` = stable hash per condition and person, so repeats never ring twice |
| Answer / close callback | M91 → `POST /api/webhooks/m91?token=<M91_CALLBACK_TOKEN>` | stored once per `idempotencyKey`; the alert is **read back** (`GET /api/v1/alerts/:id?phone=`) before anything is recorded, because M91's callback signature cannot be verified yet |
| Resolve | `POST /api/v1/alerts/close {phone, alertId}` | when the task is completed/cancelled, the blockers are resolved, or an unassigned task gets an owner |

Severity per rule: deadline missed and critical task blocked → `HIGH` (M91 phones after 3 minutes if nobody opened it); deadline approaching, no progress, unassigned, blocker unresolved → `MEDIUM`; others `LOW`. `CRITICAL` is never sent automatically.
Buttons: "I’m on it" (`SHARED`, closes it) and "Seen" (`PERSONAL`); free-text replies on. The answer appears in *Alerts → M91 alert history* and on the task's history.
Failure handling: 429, 5xx and network errors retry with backoff (1, 2, 4, 8 min; 5 attempts); 4xx (not invited, not accepted, validation) fail without retry and say why; people without a phone are `SKIPPED`; admins can retry from the history page.

**To activate:** in the M91 app create an API key (*Settings → API keys*, `m91sk_…`), set `M91_API_KEY` and a random `M91_CALLBACK_TOKEN` (e.g. `openssl rand -hex 24`), make sure `APP_URL` is the https address, then turn on M91 in *Settings → Alert settings*. Each person adds their phone in *Settings → Profile* and accepts the invitation in the M91 app.

**Status:** request/response shapes are covered by contract tests (stubbed `fetch`, `test/m91.test.js`) and the lifecycle by API tests. A live alert has not been sent: no `M91_API_KEY` was available.
