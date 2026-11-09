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

Two ways, both on one embed project:

**A. Full ViaSocket Embed** — *Automation Center → Advanced builder*. Mounts `https://embed.viasocket.com/prod-embedcomponent.js` in the page with a per-user embed token from `GET /api/viasocket/token`. Flow events are accepted only from `https://embedfrontend.viasocket.com`; the browser then asks the server to read the flow back from ViaSocket (`listFlows`) — the browser's copy is never trusted.

**B. Selected apps in context** — *Automation Center → Connected apps* (Slack, Gmail, GitHub, Google Calendar, Google Sheets; each verified on viasocket.com/docs/<slug>.md on 2026-11-09). Connect uses the official `viasocket-apps/browser` `connect()` popup; the server checks the new `auth_id` belongs to that user before storing it. Slack and Gmail are run by TeamPulse itself (actions `row1jrbor` Slack Send_Message V107 and `rowogelpy0h6` Gmail Send Email V55 — the same pinned actions DealSaathi runs live). GitHub, Calendar and Sheets open the builder filtered to that app. Slack is also in context on every task page (**Share to Slack**).

Ready-made automations:

| Automation | Trigger | Does | Needs |
| --- | --- | --- | --- |
| New Task Notification | a task is assigned | Slack message to the chosen channel, or Gmail to the assignee | ViaSocket keys + manager's Slack/Gmail connection |
| External Request → Task Request | `POST /api/inbound/task-requests` with `Authorization: Bearer <intake token>` | creates a **pending task request** (never a task), idempotent by `externalRef` | only the intake token (works without ViaSocket keys) |
| Weekly Team Report | Embarko schedule, Mondays 09:05 IST | builds the weekly summary, notifies managers in-app, delivers via Slack or Gmail | ViaSocket keys + connection for delivery |

Activation: get the three keys at https://flow.viasocket.com/embed-keys?name=TeamPulse and set `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET`.

**Status: VIASOCKET-PENDING (live test).** The keys were not available in the build environment, so no call has reached ViaSocket yet. Every server path is tested against a fake gateway with the SDK's shape (ownership checks, run logging, failure → FAILED after 3, unknown never auto-retried, disconnect → NEEDS_SETUP). To finish: set the keys, connect a test Slack and Gmail, use **Share to Slack** on a task, set up New Task Notification and assign a task to yourself, and check the run history shows the provider's message id.

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
