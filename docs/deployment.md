# Production deployment

Not deployed. The production host is still to be chosen. The setup below is host-neutral: any platform that runs
Node.js 22+ with managed PostgreSQL and Redis (Render, Railway, Fly.io, AWS, or a VM with Docker Compose).

## Services

| Service | Command | Notes |
|---|---|---|
| API | `npm start` (`node apps/api/dist/server.js`) | stateless; scale horizontally; `GET /health` |
| Worker | `npm run worker` (`node apps/api/dist/worker.js`) | one or more instances; registers the hourly, nightly and weekly schedules in Redis (idempotent) |
| Web | static files from `apps/web/dist` | serve behind the same origin as `/api` (reverse proxy), or set `CORS_ORIGINS` to the web origin |
| PostgreSQL 15+ | managed | `DATABASE_URL` |
| Redis 6.2+ | managed | `REDIS_URL`; BullMQ needs `maxmemory-policy noeviction` |
| S3-compatible storage | managed | `S3_*`; private bucket; files are served through short-lived signed URLs |

## Steps

```bash
npm ci
npm run build            # shared → api (prisma generate + tsc) → web (vite)
npm run db:deploy        # prisma migrate deploy
npm start & npm run worker
```

Required environment (see `.env.example` for every variable): `NODE_ENV=production`, `DATABASE_URL`, `REDIS_URL`,
`APP_ENCRYPTION_KEY` (32 random bytes, base64; **keep it stable**, it decrypts stored integration ids), `APP_URL`,
`PUBLIC_API_URL` (https, reachable by viaSocket), `CORS_ORIGINS`, SMTP settings, `S3_*`, and the three `VIASOCKET_*` values.
Set `REQUIRE_EMAIL_VERIFICATION=true` once SMTP works.

Reverse proxy: terminate TLS, forward `X-Forwarded-For` (the app trusts one proxy hop), and route `/api/*` to the API and
everything else to `apps/web/dist/index.html` (SPA fallback).

## Before going live

1. Rotate `VIASOCKET_EMBED_SECRET` (it was pasted into a chat during development): https://flow.viasocket.com/embed-keys?project=proj0suIrGwW
2. Run the live integration checks in `docs/viasocket-test-report.md` (section B) with test accounts; set `verifiedLiveAt` per app in `apps/api/src/integrations/catalog.ts`.
3. Decide on `AI_DATA_POLICY_CONFIRMED` after reviewing the AI provider's data-processing terms.
4. Never run `npm run db:seed` in production (it refuses when `NODE_ENV=production`).
5. Back up PostgreSQL; set retention in Settings → Organization.
