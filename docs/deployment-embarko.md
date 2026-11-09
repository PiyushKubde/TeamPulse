# Deploying TeamPulse on Embarko

TeamPulse is one Node server app. Embarko installs dependencies and runs `npm start`, which listens on `PORT` and `0.0.0.0`, applies migrations to the SQLite database in `DATA_DIR`, and serves the frontend.

## 1. Deploy

From the repository folder:

```bash
tar -czf /tmp/teampulse.tar.gz --exclude=node_modules --exclude=.git --exclude='.env*' --exclude=data --exclude='*.db' -C . .
```

```bash
curl -sS -X POST 'https://ship.embarko.ai/apps' --oauth2-bearer "$DEPLOY_TOKEN" -H 'X-App-Name: teampulse' -H 'X-Agent-Name: deploy' -F 'source=@/tmp/teampulse.tar.gz'
```

Poll until `live`:

```bash
curl -sS 'https://ship.embarko.ai/apps/teampulse/status' --oauth2-bearer "$DEPLOY_TOKEN"
```

After the first deploy, put the reply's `app.id` into `embarko.json` as `"appId"` and commit it, so redeploys always reach the same app. Without a deploy token the app is temporary (deleted after 24h) and schedules are not applied — request one with `POST https://ship.embarko.ai/api/public/deploy-tokens/request` (your email) and redeploy with it. With the Embarko connector in Claude, `deploy_app` does the same.

## 2. Environment variables (App setup → Environment)

Embarko sets `PORT`, `DATA_DIR`, `APP_NAME` and `CRON_SECRET` itself — do not set them.

| Variable | Value |
| --- | --- |
| `APP_URL` | `https://teampulse.embarko.app` (or your custom domain) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | from Google Cloud |
| `GOOGLE_REDIRECT_URI` | `https://teampulse.embarko.app/auth/google/callback` |
| `NODE_ENV` | `production` (also implied on Embarko) |
| `ALLOW_ORG_CREATION` | `true` for the first admin to create the org; then `false` if only invitations/join codes should be used |
| `VIASOCKET_ORG_ID`, `VIASOCKET_PROJECT_ID`, `VIASOCKET_EMBED_SECRET` | optional, enables the Automation Center |
| `M91_AUTH_KEY`, `M91_CALLBACK_TOKEN` | optional, once M91 sending is implemented |

Never set `DEV_LOGIN` on Embarko (it is ignored there anyway).

## 3. URLs to register

| Where | URL |
| --- | --- |
| Google OAuth client → Authorized redirect URI | `https://teampulse.embarko.app/auth/google/callback` |
| M91 delivery callbacks | `https://teampulse.embarko.app/api/webhooks/m91?token=<M91_CALLBACK_TOKEN>` |
| External requests (ViaSocket flow HTTP step) | `POST https://teampulse.embarko.app/api/inbound/task-requests` with `Authorization: Bearer <intake token>` |

ViaSocket needs no callback URL: the embed posts flow events to the page, and the server reads flows back through the SDK.

## 4. Schedules

`embarko.json` declares two jobs (Embarko calls them with `Authorization: Bearer $CRON_SECRET`; anything else gets 401):

- `/tasks/alerts` every 15 minutes — alert rules, M91 queue, automation retries.
- `/tasks/weekly-report` Mondays 09:05 Asia/Kolkata.

They are the only schedulers in production, so a redeploy cannot start a second copy; every job is also idempotent. Run them once after deploying (needs the deploy token):

```bash
curl -sS -X POST 'https://ship.embarko.ai/api/apps/teampulse/schedules/run' --oauth2-bearer "$DEPLOY_TOKEN"
```

Each run's outcome should be `ok`.

## 5. Check

1. `https://teampulse.embarko.app/api/health` → `{"ok":true,"database":"ok","google":"configured",…}`.
2. Sign in with Google, create the organization, invite a manager and an employee, and walk one task through review.
3. Logs: the start-up lines say which integrations are configured.

## Data and backups

The database is `DATA_DIR/teampulse.db` (SQLite, WAL), and evidence files are under `DATA_DIR/uploads`. Embarko keeps `DATA_DIR` across redeploys but **does not back it up** — schedule your own copies. Migrations only add tables and columns; they are applied at every start and recorded in `schema_migrations`. Leave Embarko's `_litestream_*` tables alone.
