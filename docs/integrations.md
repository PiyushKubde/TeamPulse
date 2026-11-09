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

Concept, per MSG91's guide *How the M91 alert flow moves an alert from software to a person*: software sends a titled alert to a person, the person responds, and the answer comes back to the software.

What is built:
- Per-rule M91 switch and thresholds (*Settings → Alert settings*); in-app notification for every alert regardless.
- `alert_deliveries` queue: atomic claim, retry with exponential backoff (1, 2, 4, 8 min; 5 attempts), `FAILED`/`NOT_CONFIGURED` with manual retry, history page.
- `POST /api/webhooks/m91?token=<M91_CALLBACK_TOKEN>` (or header `X-Callback-Token`): stores each callback once (by `Idempotency-Key` header or SHA-256 of the body), matches it to the delivery, and records the person's response on the task's history.

**Status: M91-PENDING.** The official API documentation (https://m91.msg91.com/docs, msg91.com) was blocked by the build environment's network policy, and TeamPulse does not guess endpoints or payloads. `server/integrations/m91.js` holds the two functions to complete — `send()` and `parseCallback()` — and sets `apiImplemented = false`, so alerts are marked `NOT_CONFIGURED` and delivered in-app. To activate: implement those two functions from the official docs, set `M91_AUTH_KEY` and `M91_CALLBACK_TOKEN`, register the callback URL `https://<app>/api/webhooks/m91?token=<M91_CALLBACK_TOKEN>` with M91, and turn on M91 in Alert settings. The queue, retries and callback handling are already tested with a fake transport.
