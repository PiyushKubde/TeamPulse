# Production deployment

KONVO runs on [Embarko](https://embarko.ai) as the app `teampulse` (https://teampulse.embarko.app), replacing the original
KONVO deployment. `embarko.json` holds the app id and the scheduled jobs.

## How it runs

One Node process (Embarko hosts one process per app, 256 MB of memory):

| Part | Where |
|---|---|
| API | `apps/api` (`npm start` → `node dist/server.js`, which applies pending migrations first; see below) |
| Web app | `apps/web/dist`, served by the same process (SPA fallback to `index.html`) |
| Database | SQLite at `<DATA_DIR>/konvo.db` (Embarko keeps `DATA_DIR` across redeploys and replicates it) |
| Uploads | `<DATA_DIR>/uploads` |
| Background jobs | in-process queue, 5 attempts with backoff; sync events a restart left waiting are re-queued every 5 minutes |
| Schedules | Embarko calls `/api/internal/cron/{tick,hourly,nightly,weekly}` with `Bearer CRON_SECRET` (see `embarko.json`) |
| On-call checks, phone answers | every minute in-process; the 5-minute `tick` schedule is the backstop |

Memory: the process is started with `--max-old-space-size=112 --max-semi-space-size=2`; measured locally (macOS) at about
150 MB settled and about 240 MB peak during sign-up and the scheduled jobs. The S3 SDK and the PDF library load only when
used. If Embarko reports OOM restarts, look there first.

## Migrations

The server applies pending migrations itself at start-up (`src/lib/migrate.ts`), with a 30 s busy timeout and retries,
writing Prisma's own `_prisma_migrations` table and checksums. `prisma migrate deploy` is not used in production: it
fails at once with "database is locked" when anything holds the SQLite file for a moment, which crash-looped the second
deploy (2026-11-15).

## Deploying

Deploy only committed code, never the working folder (it holds `.env` and local databases):

```bash
rm -rf /tmp/konvo-deploy && mkdir /tmp/konvo-deploy && git archive HEAD | tar -x -C /tmp/konvo-deploy
DEPLOY_TOKEN=… ~/.claude/skills/embarko-deploy/scripts/deploy.sh /tmp/konvo-deploy teampulse "$(git rev-parse --short HEAD)"
```

Embarko installs dependencies, runs `npm run build` (shared → api → web) and then `npm start`. Build tools are regular
dependencies so the build works without devDependencies.

## Environment (Embarko → App setup, or the env-vars API)

Set by Embarko: `PORT`, `DATA_DIR`, `APP_NAME` (the public URL, `APP_URL` and `PUBLIC_API_URL` follow from it), `CRON_SECRET`.

Set for this app: `NODE_ENV=production`, `APP_ENCRYPTION_KEY` (32 random bytes, base64; **keep it stable**, it decrypts
stored integration ids), `AI_PROVIDER=viasocket`, `AI_SERVICE`, `AI_MODEL_FAST`, `AI_MODEL_ASSISTANT`, the three
`VIASOCKET_*` values, `M91_SEND_LINK`, `M91_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` and
`GOOGLE_REDIRECT_URI=https://teampulse.embarko.app/auth/google/callback` (the callback the original KONVO registered).

## Rollback

`POST https://ship.embarko.ai/api/apps/teampulse/rollback` with the deploy token restores the previous version. The original
KONVO keeps its data in `<DATA_DIR>/teampulse.db`; this version uses `konvo.db`, so neither touches the other's data.

## Before going live with real teams

1. Rotate the secrets that were pasted into chat during development: `VIASOCKET_EMBED_SECRET`, the M91 API key and the
   Embarko deploy token.
2. Run the live integration checks in `docs/viasocket-test-report.md` (section B) with test accounts.
3. Connect Gmail (Integrations) so verification, invitation and password-reset emails are sent.
4. Never run `npm run db:seed` in production (it refuses when `NODE_ENV=production`).
