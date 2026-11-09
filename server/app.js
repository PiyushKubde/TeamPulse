// The HTTP app. Every protected route derives identity, organization, role and permissions from the session.
import express from 'express'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError, forbidden } from './errors.js'
import { assignableUserIds, loadContext, isAdmin, isManager } from './access.js'
import { COOKIE, cookieHeader, createSession, destroySession, readCookie, sessionUser } from './auth/sessions.js'
import { finishGoogleLogin, googleTransport, startGoogleLogin, upsertGoogleUser } from './auth/google.js'
import * as orgs from './services/orgs.js'
import * as perms from './services/permissions.js'
import * as tasks from './services/tasks.js'
import * as requests from './services/requests.js'
import * as impact from './services/impact.js'
import * as evidence from './services/evidence.js'
import * as reflections from './services/reflections.js'
import * as reports from './services/reports.js'
import { dashboard } from './services/dashboard.js'
import { listNotifications, markRead } from './services/notify.js'
import { listAudit } from './services/audit.js'
import * as alerts from './services/alerts.js'
import { onEvent } from './services/events.js'
import * as conns from './integrations/connections.js'
import { sendThrough, slackChannels } from './integrations/actions.js'
import * as auto from './automations/engine.js'
import * as v from './validate.js'
import { now } from './db.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const VIASOCKET_BROWSER = fileURLToPath(import.meta.resolve('viasocket-apps/browser'))

/** Fixed-window rate limiter, per key. In memory: enough for one instance (Embarko runs one). */
export function rateLimiter({ windowMs, max }) {
  const hits = new Map()
  return (key) => {
    const t = Date.now()
    const h = hits.get(key)
    if (!h || t - h.start > windowMs) { hits.set(key, { start: t, n: 1 }); if (hits.size > 10000) hits.clear(); return }
    if (++h.n > max) throw new AppError(429, 'rate_limited', 'Too many requests. Wait a moment and try again.')
  }
}

export function createApp({ db, cfg, vs = { configured: false }, m91, google = googleTransport(), listen = true }) {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  auto.seedUseCases(db)

  // Event listeners: alerts/notifications, and the New Task Notification automation.
  const unsubscribe = listen ? [
    onEvent((e) => alerts.handleEvent(db, e)),
    onEvent((e) => (e.type === 'task.assigned' ? auto.runNewTaskNotification(db, vs, { ...e, appUrl: cfg.appUrl }) : null)),
    onEvent(() => alerts.processDeliveries(db, m91)),
    onEvent((e) => alerts.closeResolvedAlerts(db, m91, e))
  ] : []
  app.locals.stopListening = () => unsubscribe.forEach((fn) => fn())

  const limitAuth = rateLimiter({ windowMs: 60000, max: 30 })
  const limitApi = rateLimiter({ windowMs: 60000, max: 600 })
  const limitInbound = rateLimiter({ windowMs: 60000, max: 60 })
  const ip = (req) => req.ip || 'unknown'

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if (cfg.production) res.setHeader('Strict-Transport-Security', 'max-age=15552000')
    next()
  })

  // Raw bodies for the two routes that need them (uploads; callbacks are hashed for idempotency).
  app.post('/api/evidence/:ownerType/:ownerId/files', express.raw({ type: () => true, limit: cfg.uploadMaxBytes + 1024 }))
  app.post('/api/webhooks/m91', express.raw({ type: () => true, limit: '64kb' }))
  app.use(express.json({ limit: '200kb' }))

  // CSRF: state-changing /api calls must carry a custom header (a cross-site form cannot set it) and the session
  // cookie is SameSite=Lax. Token-authenticated machine endpoints are exempt.
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    const machine = req.path.startsWith('/inbound/') || req.path.startsWith('/webhooks/')
    if (!machine && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'TeamPulse') {
      return next(new AppError(403, 'csrf', 'Missing request header.'))
    }
    try { (machine ? limitInbound : limitApi)(ip(req)) } catch (e) { return next(e) }
    next()
  })

  // Session → user → organization context (from the database, never from the request).
  app.use((req, res, next) => {
    const user = sessionUser(db, readCookie(req))
    req.user = user
    req.ctx = user ? loadContext(db, user) : null
    next()
  })

  const signedIn = (req) => {
    if (!req.user) throw new AppError(401, 'unauthenticated', 'Please sign in.')
    return req.user
  }
  const member = (req) => {
    signedIn(req)
    if (!req.ctx?.membership) throw new AppError(403, req.ctx?.deactivated ? 'deactivated' : 'no_organization', req.ctx?.deactivated ? 'Your account has been deactivated in this organization.' : 'Join or create an organization first.')
    return req.ctx
  }
  // Route helper: async handlers, errors to the error middleware.
  const h = (fn) => async (req, res, next) => {
    try {
      const out = await fn(req, res)
      if (out !== undefined && !res.headersSent) res.json(out)
    } catch (error) { next(error) }
  }
  const setSession = (res, userId, req) => {
    const s = createSession(db, userId, { days: cfg.sessionDays, userAgent: req.get('user-agent') })
    res.setHeader('Set-Cookie', cookieHeader(COOKIE, s.token, { maxAgeSeconds: cfg.sessionDays * 86400, secure: cfg.production }))
  }

  // ---------- health ----------
  app.get('/api/health', h(() => {
    db.prepare('SELECT 1').get()
    return { ok: true, database: 'ok', google: cfg.google.configured ? 'configured' : 'not_configured', viasocket: vs.configured ? 'configured' : 'not_configured', m91: m91.status().state, time: now() }
  }))

  // ---------- authentication ----------
  app.get('/auth/google', h((req, res) => {
    limitAuth(ip(req))
    res.redirect(302, startGoogleLogin(db, cfg.google, { returnTo: req.query.returnTo }))
  }))
  app.get('/auth/google/callback', async (req, res) => {
    try {
      limitAuth(ip(req))
      if (req.query.error) throw new AppError(400, 'google_denied', 'Google sign-in was cancelled.')
      const { user, returnTo } = await finishGoogleLogin(db, cfg.google, google, { code: req.query.code, state: req.query.state })
      setSession(res, user.id, req)
      res.redirect(302, `/${returnTo || '#/dashboard'}`)
    } catch (error) {
      console.log(`[auth] Google sign-in failed: ${error.code || 'error'} ${error.message}`)
      res.redirect(302, `/#/login?error=${encodeURIComponent(error instanceof AppError ? error.message : 'Sign-in failed. Try again.')}`)
    }
  })
  // Local development only (DEV_LOGIN=1, never in production): sign in as any email without Google.
  app.post('/auth/dev-login', h((req, res) => {
    if (!cfg.devLogin) throw new AppError(404, 'not_found', 'Not found.')
    if (req.get('x-requested-with') !== 'TeamPulse') throw new AppError(403, 'csrf', 'Missing request header.')
    const email = v.email(req.body?.email)
    const existing = db.prepare('SELECT name FROM users WHERE google_sub = ?').get(`dev:${email}`)
    const user = upsertGoogleUser(db, { sub: `dev:${email}`, email, emailVerified: true, name: v.text(req.body?.name, 'Name', { max: 80 }) || existing?.name || email.split('@')[0] })
    setSession(res, user.id, req)
    return { ok: true }
  }))
  app.post('/api/session/logout', h((req, res) => {
    destroySession(db, readCookie(req))
    res.setHeader('Set-Cookie', cookieHeader(COOKIE, '', { maxAgeSeconds: 0, secure: cfg.production }))
    return { ok: true }
  }))
  app.get('/api/session', h((req) => {
    const base = { googleConfigured: cfg.google.configured, devLogin: cfg.devLogin }
    if (!req.user) return { ...base, user: null }
    const c = req.ctx
    return {
      ...base,
      user: { id: req.user.id, name: req.user.name, email: req.user.email, emailVerified: Boolean(req.user.email_verified), pictureUrl: req.user.picture_url, phone: req.user.phone },
      membership: c?.membership ? { orgId: c.orgId, orgName: c.orgName, role: c.role, teamId: c.teamId, managedTeamIds: c.managedTeamIds, permissions: c.permissions, creationMode: perms.creationMode(c) } : null,
      deactivated: Boolean(c?.deactivated)
    }
  }))

  // ---------- onboarding ----------
  app.get('/api/onboarding', h((req) => {
    const user = signedIn(req)
    return { invitations: orgs.invitationsFor(db, user, req.query.inviteToken), joinRequest: orgs.myJoinRequest(db, user), allowOrgCreation: cfg.allowOrgCreation }
  }))
  app.post('/api/organizations', h((req) => orgs.createOrganization(db, signedIn(req), req.body, { allowed: cfg.allowOrgCreation })))
  app.post('/api/invitations/:id/accept', h((req) => orgs.acceptInvitation(db, signedIn(req), req.params.id)))
  app.post('/api/join-requests', h((req) => orgs.requestToJoin(db, signedIn(req), req.body)))
  app.delete('/api/join-requests/mine', h((req) => orgs.withdrawJoinRequest(db, signedIn(req))))

  // ---------- organization ----------
  app.get('/api/organization', h((req) => orgs.getOrganization(db, member(req))))
  app.patch('/api/organization', h((req) => orgs.updateOrganization(db, member(req), req.body)))
  app.post('/api/organization/join-code', h((req) => orgs.rotateJoinCode(db, member(req))))
  app.get('/api/teams', h((req) => orgs.listTeams(db, member(req))))
  app.post('/api/teams', h((req) => orgs.createTeam(db, member(req), req.body)))
  app.patch('/api/teams/:id', h((req) => orgs.updateTeam(db, member(req), req.params.id, req.body)))
  app.delete('/api/teams/:id', h((req) => orgs.deleteTeam(db, member(req), req.params.id)))
  app.get('/api/members', h((req) => orgs.listMembers(db, member(req), { includeInactive: req.query.all === 'true' && isAdmin(req.ctx) })))
  app.patch('/api/members/:userId', h((req) => orgs.updateMember(db, member(req), req.params.userId, req.body)))
  app.get('/api/invitations', h((req) => orgs.listInvitations(db, member(req))))
  app.post('/api/invitations', h((req) => orgs.createInvitation(db, member(req), req.body, { appUrl: cfg.appUrl || `${req.protocol}://${req.get('host')}` })))
  app.delete('/api/invitations/:id', h((req) => orgs.revokeInvitation(db, member(req), req.params.id)))
  app.get('/api/join-requests', h((req) => orgs.listJoinRequests(db, member(req))))
  app.post('/api/join-requests/:id/decision', h((req) => orgs.decideJoinRequest(db, member(req), req.params.id, req.body)))
  app.get('/api/permissions', h((req) => perms.listPermissions(db, member(req))))
  app.patch('/api/permissions/:userId', h((req) => perms.updatePermissions(db, member(req), req.params.userId, req.body)))
  app.get('/api/audit', h((req) => {
    const ctx = member(req)
    if (isAdmin(ctx)) return listAudit(db, ctx.orgId, { entityType: req.query.entityType || undefined })
    if (isManager(ctx)) return listAudit(db, ctx.orgId, { entityType: 'employee_permissions' })
    throw forbidden()
  }))
  // Saving a phone invites it to M91 (when configured): the person accepts in the M91 app before alerts reach them.
  app.patch('/api/profile', h(async (req) => {
    const out = orgs.updateProfile(db, signedIn(req), req.body)
    if (!out.phone || !m91.ready) return { ...out, m91: m91.ready ? null : 'not_configured' }
    try {
      const inv = await m91.invite(out.phone, `TeamPulse — ${req.user.name}`.slice(0, 80))
      return { ...out, m91: inv.reachable ? 'reachable' : 'invited' }
    } catch (error) {
      return { ...out, m91: 'invite_failed', m91Error: String(error.message).slice(0, 200) }
    }
  }))

  // ---------- dashboard ----------
  app.get('/api/dashboard', h((req) => dashboard(db, member(req))))
  app.get('/api/reflections/today', h((req) => reflections.getReflection(db, member(req), req.query.day)))
  app.put('/api/reflections', h((req) => reflections.saveReflection(db, member(req), req.body)))
  app.get('/api/reflections', h((req) => reflections.recentReflections(db, member(req))))

  // ---------- tasks ----------
  app.get('/api/tasks', h((req) => tasks.listTasks(db, member(req), req.query)))
  app.post('/api/tasks', h((req, res) => { const out = tasks.createTask(db, member(req), req.body); res.status(201); return out }))
  app.get('/api/tasks/:id', h((req) => tasks.getTaskDetail(db, member(req), req.params.id)))
  app.patch('/api/tasks/:id', h((req) => tasks.updateTask(db, member(req), req.params.id, req.body)))
  app.delete('/api/tasks/:id', h((req) => tasks.deleteTask(db, member(req), req.params.id)))
  app.post('/api/tasks/:id/assign', h((req) => tasks.assignTask(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/status', h((req) => tasks.changeStatus(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/progress', h((req) => tasks.updateProgress(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/comments', h((req) => tasks.addComment(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/blockers', h((req) => tasks.reportBlocker(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/submit', h((req) => tasks.submitForReview(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/review', h((req) => tasks.reviewSubmission(db, member(req), req.params.id, req.body)))
  app.get('/api/blockers', h((req) => tasks.listBlockers(db, member(req), { status: req.query.status })))
  app.post('/api/blockers/:id/resolve', h((req) => tasks.resolveBlocker(db, member(req), req.params.id, req.body)))
  app.post('/api/blockers/:id/escalate', h((req) => tasks.escalateBlocker(db, member(req), req.params.id)))
  // The people this user may assign a task to (server-side permission rules).
  app.get('/api/assignable', h((req) => {
    const ctx = member(req)
    const ids = new Set(assignableUserIds(db, ctx))
    return orgs.listMembers(db, ctx).filter((m) => ids.has(m.userId)).map((m) => ({ userId: m.userId, name: m.name, teamId: m.teamId, teamName: m.teamName }))
  }))

  // Contextual Slack experience: share a task to a channel through the user's own Slack connection.
  app.post('/api/tasks/:id/share', h(async (req) => {
    const ctx = member(req)
    const detail = tasks.getTaskDetail(db, ctx, req.params.id)
    const t = detail.task
    const channelId = v.text(req.body?.slackChannelId, 'Slack channel', { required: true, max: 40 })
    const text = [`${t.title} — ${t.status.replace(/_/g, ' ').toLowerCase()}${t.assigneeName ? `, owner ${t.assigneeName}` : ''}`, t.expectedOutcome ? `Expected outcome: ${t.expectedOutcome}` : null,
      t.dueAt ? `Due ${t.dueAt.slice(0, 16).replace('T', ' ')} UTC` : null, cfg.appUrl ? `${cfg.appUrl}/#/tasks/${t.id}` : null, v.text(req.body?.note, 'Note', { max: 500 })].filter(Boolean).join('\n')
    const out = await sendThrough(db, vs, ctx, { channel: 'slack', connectionId: req.body?.connectionId, slackChannelId: channelId }, { subject: 'TeamPulse task', text })
    if (out.status === 'SUCCEEDED') tasks.recordEvent(db, db.prepare('SELECT * FROM tasks WHERE id = ?').get(t.id), ctx.user.id, 'shared', { to: 'Slack' })
    return out
  }))

  // ---------- evidence ----------
  const OWNER_TYPES = ['task', 'submission', 'impact']
  const ownerType = (t) => { if (!OWNER_TYPES.includes(t)) throw new AppError(400, 'validation_failed', 'Unknown evidence owner.'); return t }
  app.post('/api/evidence/:ownerType/:ownerId/links', h((req) => evidence.addLink(db, member(req), ownerType(req.params.ownerType), req.params.ownerId, req.body)))
  app.post('/api/evidence/:ownerType/:ownerId/files', h((req) => {
    const ctx = member(req)
    if (req.get('x-requested-with') !== 'TeamPulse') throw new AppError(403, 'csrf', 'Missing request header.')
    return evidence.addFile(db, ctx, ownerType(req.params.ownerType), req.params.ownerId, {
      buffer: Buffer.isBuffer(req.body) ? req.body : null, fileName: decodeURIComponent(req.get('x-file-name') || ''), mimeType: req.get('content-type'), dataDir: cfg.dataDir, maxBytes: cfg.uploadMaxBytes
    })
  }))
  app.get('/api/evidence/:id/download', h((req, res) => {
    const f = evidence.evidenceFile(db, member(req), req.params.id, cfg.dataDir)
    res.setHeader('Content-Type', f.mimeType)
    // Always a download, never rendered inline in our origin.
    res.setHeader('Content-Disposition', `attachment; filename="${f.fileName.replace(/"/g, '')}"`)
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox")
    createReadStream(f.path).pipe(res)
  }))
  app.delete('/api/evidence/:id', h((req) => evidence.deleteEvidence(db, member(req), req.params.id, cfg.dataDir)))

  // ---------- requests ----------
  app.get('/api/requests', h((req) => requests.listRequests(db, member(req), req.query)))
  app.post('/api/requests', h((req, res) => { const out = requests.createRequestRecord(db, member(req), req.body); res.status(201); return out }))
  app.get('/api/requests/:id', h((req) => requests.getRequest(db, member(req), req.params.id)))
  app.patch('/api/requests/:id', h((req) => requests.updateRequest(db, member(req), req.params.id, req.body)))
  app.post('/api/requests/:id/decision', h((req) => requests.decideRequest(db, member(req), req.params.id, req.body)))
  app.post('/api/requests/:id/withdraw', h((req) => requests.withdrawRequest(db, member(req), req.params.id)))

  // ---------- impact ----------
  app.get('/api/impact', h((req) => impact.listImpact(db, member(req), req.query)))
  app.post('/api/impact', h((req, res) => { const out = impact.createImpact(db, member(req), req.body); res.status(201); return out }))
  app.get('/api/impact-summary', h((req) => impact.contributionSummary(db, member(req), req.query)))
  app.get('/api/impact/:id', h((req) => impact.getImpact(db, member(req), req.params.id)))
  app.patch('/api/impact/:id', h((req) => impact.updateImpact(db, member(req), req.params.id, req.body)))
  app.post('/api/impact/:id/verification', h((req) => impact.verifyImpact(db, member(req), req.params.id, req.body)))

  // ---------- reports ----------
  app.get('/api/reports/:type', h((req, res) => {
    const ctx = member(req)
    const csv = req.params.type.endsWith('.csv')
    const type = req.params.type.replace(/\.csv$/, '')
    const report = reports.buildReport(db, ctx, type, req.query)
    if (!csv) return report
    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="teampulse-${type}-${now().slice(0, 10)}.csv"`)
    res.send(reports.toCsv(report))
  }))

  // ---------- notifications and alerts ----------
  app.get('/api/notifications', h((req) => listNotifications(db, member(req), { unreadOnly: req.query.unread === 'true' })))
  app.post('/api/notifications/read', h((req) => ({ marked: markRead(db, member(req), req.body?.ids === 'all' ? 'all' : (Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 200).map(String) : [])) })))
  app.get('/api/alerts/settings', h((req) => alerts.getAlertSettings(db, member(req), m91)))
  app.patch('/api/alerts/settings', h((req) => alerts.updateAlertSettings(db, member(req), req.body, m91)))
  app.get('/api/alerts/history', h((req) => alerts.alertHistory(db, member(req))))
  app.post('/api/alerts/deliveries/:id/retry', h(async (req) => { const out = alerts.retryDelivery(db, member(req), req.params.id); await alerts.processDeliveries(db, m91); return out }))
  app.post('/api/webhooks/m91', h(async (req, res) => {
    const out = await alerts.handleCallback(db, m91, { token: req.query.token || req.get('x-callback-token'), expectedToken: cfg.m91.callbackToken, rawBody: req.body, idempotencyHeader: req.get('idempotency-key') })
    res.status(out.status)
    return out.body
  }))

  // ---------- automation center ----------
  app.get('/api/automations', h((req) => auto.listAutomations(db, member(req), vs)))
  app.get('/api/automations/runs', h((req) => auto.executionHistory(db, member(req))))
  app.post('/api/automations/runs/:id/retry', h(async (req) => {
    const ctx = member(req)
    if (!isManager(ctx)) throw forbidden()
    return auto.retryFailedRuns(db, vs, { appUrl: cfg.appUrl, orgId: ctx.orgId, logId: v.id(req.params.id, 'Run', { required: true }) })
  }))
  app.post('/api/automations/external_request_intake/token', h((req) => auto.issueIntakeToken(db, member(req))))
  app.put('/api/automations/:key', h((req) => auto.configureAutomation(db, member(req), vs, req.params.key, req.body)))
  app.post('/api/automations/:key/status', h((req) => auto.setAutomationStatus(db, member(req), vs, req.params.key, req.body)))
  app.post('/api/automations/weekly_team_report/preview', h((req) => {
    const ctx = member(req)
    const s = reports.weeklySummary(db, ctx, req.body || {})
    return { text: reports.weeklyText(s, ctx.orgName) }
  }))
  app.post('/api/inbound/task-requests', h((req, res) => {
    const auth = req.get('authorization') || ''
    const out = auto.receiveExternalRequest(db, auth.startsWith('Bearer ') ? auth.slice(7).trim() : null, req.body)
    res.status(out.duplicate ? 200 : 201)
    return { id: out.id, status: out.status, duplicate: out.duplicate }
  }))

  // ---------- viaSocket ----------
  app.get('/api/viasocket/token', h(async (req) => {
    const ctx = member(req)
    const slugs = String(req.query.apps || '').split(',').filter(Boolean).slice(0, 10)
    return conns.embedToken(vs, ctx.user.id, slugs)
  }))
  app.get('/api/viasocket/connections', h((req) => conns.listConnections(db, vs, member(req))))
  app.post('/api/viasocket/connections', h((req) => conns.saveConnection(db, vs, member(req), req.body)))
  app.get('/api/viasocket/connections/:id/reconnect', h((req) => conns.reconnectDetails(db, vs, member(req), req.params.id)))
  app.get('/api/viasocket/connections/:id/slack-channels', h((req) => slackChannels(db, vs, member(req), req.params.id)))
  app.delete('/api/viasocket/connections/:id', h((req) => conns.disconnect(db, vs, member(req), req.params.id)))
  app.get('/api/viasocket/embed-flows', h((req) => conns.listEmbedFlows(db, member(req))))
  app.post('/api/viasocket/embed-flows/:flowId/sync', h((req) => conns.syncEmbedFlow(db, vs, member(req), req.params.flowId)))
  app.get('/vendor/viasocket-apps-browser.js', (req, res) => res.type('text/javascript').sendFile(VIASOCKET_BROWSER))

  // ---------- scheduled jobs (Embarko schedules call these with CRON_SECRET) ----------
  const cronOk = (req) => {
    const expected = cfg.cronSecret
    if (!expected || req.get('authorization') !== `Bearer ${expected}`) throw new AppError(401, 'unauthorized', 'Unauthorized')
  }
  app.get('/tasks/alerts', h(async (req, res) => {
    cronOk(req)
    const out = await runAlertJob({ db, vs, m91, cfg })
    res.type('text/plain').send(out.text)
  }))
  app.get('/tasks/weekly-report', h(async (req, res) => {
    cronOk(req)
    const out = await auto.runWeeklyReports(db, vs, { appUrl: cfg.appUrl })
    res.type('text/plain').send(`Weekly reports for week starting ${out.weekStart}: ${out.results.length} organization(s); delivered ${out.results.filter((r) => r.delivered).length}`)
  }))

  app.use('/api', (req, res, next) => next(new AppError(404, 'not_found', 'No such API route.')))
  app.use(express.static(join(ROOT, 'public'), { index: 'index.html', maxAge: cfg.production ? '1h' : 0 }))

  // Errors: a stable JSON shape; internal errors are logged without user data and never leak details.
  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error?.type === 'entity.too.large') error = new AppError(413, 'too_large', 'That upload is too large.')
    if (error?.type === 'entity.parse.failed') error = new AppError(400, 'invalid_json', 'The request body is not valid JSON.')
    const known = error instanceof AppError
    if (!known) console.error(`[error] ${req.method} ${req.path}:`, error?.stack || error)
    res.status(known ? error.status : 500).json({ error: { code: known ? error.code : 'internal', message: known ? error.message : 'Something went wrong on our side. Try again.', ...(known && error.details ? { details: error.details } : {}) } })
  })
  return app
}

/**
 * One scheduler tick: scan time-based alert rules, send queued M91 alerts, retry failed automation runs.
 * A lease in app_state stops overlapping runs (e.g. a manual run during a scheduled one) from double-processing;
 * every step is also idempotent through dedupe keys, so a redeploy or duplicate call never repeats an alert.
 */
export async function runAlertJob({ db, vs, m91, cfg }) {
  const lease = db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('alert_job_lease', ?, ?)
                            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE app_state.value < ?`)
    .run(new Date(Date.now() + 4 * 60000).toISOString(), now(), now()).changes
  if (!lease) return { text: 'Skipped: another run is in progress.' }
  try {
    const raised = alerts.scanAlerts(db)
    const sent = await alerts.processDeliveries(db, m91)
    const retried = await auto.retryFailedRuns(db, vs, { appUrl: cfg.appUrl })
    db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('alert_job_last', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(now(), now())
    return { raised, sent, retried, text: `Alerts raised ${raised}; M91 sent ${sent.sent}, retrying ${sent.retrying}, failed ${sent.failed}, not configured ${sent.notConfigured}; automation retries ${retried.retried}` }
  } finally {
    db.prepare(`UPDATE app_state SET value = ?, updated_at = ? WHERE key = 'alert_job_lease'`).run(new Date(0).toISOString(), now())
  }
}
