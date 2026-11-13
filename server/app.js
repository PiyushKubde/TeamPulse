// The HTTP app. Every protected route derives identity, organization, role and permissions from the session.
import express from 'express'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AppError, forbidden } from './errors.js'
import { assignableUserIds, loadContext, isAdmin, isManager, requireVisibleTask, canManageTask } from './access.js'
import * as params from './services/task-parameters.js'
import * as prio from './services/priority-model.js'
import * as analytics from './services/analytics.js'
import { COOKIE, cookieHeader, createSession, destroySession, readCookie, sessionUser } from './auth/sessions.js'
import { finishGoogleLogin, googleTransport, startGoogleLogin, upsertGoogleUser } from './auth/google.js'
import * as accounts from './auth/accounts.js'
import { sha256 } from './auth/sessions.js'
import { createMailer } from './auth/mailer.js'
import * as orgs from './services/orgs.js'
import * as perms from './services/permissions.js'
import * as tasks from './services/tasks.js'
import * as assignments from './services/assignments.js'
import * as deadlines from './services/deadline-explanations.js'
import * as slackIdentities from './services/slack-identities.js'
import { intakeOverview } from './services/intake-overview.js'
import { purgeIgnoredText } from './automations/slack-tasks.js'
import * as requests from './services/requests.js'
import * as impact from './services/impact.js'
import * as evidence from './services/evidence.js'
import * as reflections from './services/reflections.js'
import * as reports from './services/reports.js'
import { dashboard } from './services/dashboard.js'
import { listNotifications, markRead } from './services/notify.js'
import { listAudit } from './services/audit.js'
import * as alerts from './services/alerts.js'
import { onEvent, recoverOutbox, useOutbox } from './services/events.js'
import { transaction as txn, uuid } from './db.js'
import { backupIfDue, lastBackup } from './services/backups.js'
import * as conns from './integrations/connections.js'
import { sendThrough, slackChannels, slackUsers } from './integrations/actions.js'
import * as auto from './automations/engine.js'
import * as intake from './automations/intake.js'
import * as contextFlows from './automations/context-flows.js'
import { createAiProvider } from './ai/provider.js'
import { seedRubrics } from './measurement/rubric.js'
import { onWorkEvent, recoverRuns } from './measurement/engine.js'
import * as measure from './measurement/assessments.js'
import * as evidenceSources from './evidence/sources.js'
import * as evidenceSvc from './evidence/service.js'
import { receiveEvidenceEvent, retryInbox } from './evidence/ingest.js'
import * as journeys from './intelligence/journeys.js'
import * as signals from './intelligence/signals.js'
import * as assistant from './intelligence/assistant.js'
import { notifyInApp } from './services/notify.js'
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

export function createApp({ db, cfg, vs = { configured: false }, m91, google = googleTransport(), listen = true, mailer = null, ai = null }) {
  mailer ||= createMailer(cfg.mail || {}, { db, vs })
  ai ||= createAiProvider(cfg, { vs })
  const aiModeNow = measure.aiMode(cfg, ai)
  seedRubrics(db)
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 1)
  auto.seedUseCases(db)

  // Event listeners: alerts/notifications, and the New Task Notification automation.
  if (listen) useOutbox(db)
  const unsubscribe = listen ? [
    onEvent((e) => alerts.handleEvent(db, e)),
    onEvent((e) => (e.type === 'task.assigned' ? auto.runNewTaskNotification(db, vs, { ...e, appUrl: cfg.appUrl }) : null)),
    onEvent((e) => contextFlows.onTaskEvent(db, vs, e, cfg.appUrl)),
    onEvent(() => alerts.processDeliveries(db, m91)),
    onEvent((e) => alerts.closeResolvedAlerts(db, m91, e)),
    onEvent((e) => onWorkEvent(db, ai, e, aiModeNow)),
    onEvent((e) => (e.type === 'assessment.ready' ? notifyInApp(db, { orgId: e.orgId, userId: e.subjectId, kind: 'assessment_ready', title: 'Your work analysis is ready to review', link: `#/tasks/${e.taskId}`, taskId: e.taskId, dedupeKey: `assessment-ready:${e.assessmentId}` }) : null))
  ] : []
  app.locals.stopListening = () => unsubscribe.forEach((fn) => fn())
  app.locals.events = { recoverOutbox }
  app.locals.ai = ai
  app.locals.aiMode = aiModeNow

  const limitAuth = rateLimiter({ windowMs: 60000, max: 30 })
  const limitLogin = rateLimiter({ windowMs: 60000, max: 10 })
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
    const machine = req.path.startsWith('/inbound/') || req.path.startsWith('/webhooks/') || req.path.startsWith('/viasocket/events/') || req.path.startsWith('/work-evidence/events/')
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
    return { ok: true, database: 'ok', google: cfg.google.configured ? 'configured' : 'not_configured', email: mailer.configured ? 'configured' : 'not_configured', viasocket: vs.configured ? 'configured' : 'not_configured', ai: ai.configured ? (ai.simulated ? 'simulated' : 'configured') : 'not_configured', aiMode: aiModeNow.mode, m91: m91.status().state, time: now() }
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
  // ---------- email and password ----------
  const authPost = (path, fn) => app.post(path, h(async (req, res) => {
    limitAuth(ip(req))
    if (req.get('x-requested-with') !== 'TeamPulse') throw new AppError(403, 'csrf', 'Missing request header.')
    return fn(req, res)
  }))
  authPost('/auth/register', (req) => accounts.register(db, mailer, cfg, req.body))
  authPost('/auth/register-direct', async (req, res) => { const user = await accounts.registerDirect(db, req.body); setSession(res, user.id, req); return { ok: true } })
  authPost('/auth/email/resend', (req) => accounts.resendVerification(db, mailer, cfg, req.body))
  authPost('/auth/email/verify', async (req, res) => { const user = await accounts.verifyEmail(db, req.body); setSession(res, user.id, req); return { ok: true } })
  authPost('/auth/login', async (req, res) => {
    limitLogin(ip(req))
    const user = await accounts.login(db, mailer, cfg, req.body)
    setSession(res, user.id, req)
    return { ok: true }
  })
  authPost('/auth/password/forgot', (req) => accounts.forgotPassword(db, mailer, cfg, req.body))
  authPost('/auth/password/check', (req) => accounts.describeToken(db, req.body))
  authPost('/auth/password/reset', async (req, res) => { const user = await accounts.resetPassword(db, req.body); setSession(res, user.id, req); return { ok: true } })
  // Public invitation lookup (by token — no auth required, returns only non-sensitive invitation info)
  app.get('/api/invite/:token', h((req) => {
    const token = String(req.params.token || '')
    if (!token || token.length < 10 || token.length > 200) return { valid: false, reason: 'invalid' }
    const inv = db.prepare(`SELECT i.*, o.name AS org_name, u.name AS invited_by_name FROM invitations i JOIN organizations o ON o.id = i.org_id JOIN users u ON u.id = i.invited_by WHERE i.token_hash = ? AND i.status = 'pending'`).get(sha256(token))
    if (!inv) return { valid: false, reason: 'invalid' }
    if (inv.expires_at < now()) return { valid: false, reason: 'expired' }
    // Check if an account with this email already exists
    // Only reveal hasAccount to an already-authenticated caller whose session email matches the invitation email.
    // Unauthenticated callers must not learn whether an email address is registered.
    const callerEmail = req.user?.email?.toLowerCase()
    const invEmail = inv.email.toLowerCase()
    const hasAccount = (callerEmail && callerEmail === invEmail)
      ? Boolean(db.prepare('SELECT 1 FROM users WHERE lower(email) = ? AND email_verified = 1').get(invEmail))
      : undefined
    const resp = { valid: true, id: inv.id, email: inv.email, role: inv.role, orgName: inv.org_name, invitedBy: inv.invited_by_name, expiresAt: inv.expires_at }
    if (hasAccount !== undefined) resp.hasAccount = hasAccount
    return resp
  }))
  // Register a new account using an invitation token (no email verification step needed)
  authPost('/auth/register-and-accept', async (req, res) => {
    const token = String(req.body?.inviteToken || '')
    if (!token) throw new AppError(400, 'validation_failed', 'Invitation token is required.')
    const inv = db.prepare(`SELECT * FROM invitations WHERE token_hash = ? AND status = 'pending'`).get(sha256(token))
    if (!inv || inv.expires_at < now()) throw new AppError(400, 'invitation_invalid', 'This invitation link is not valid or has expired.')
    const user = await accounts.registerForInvitation(db, req.body, inv.email)
    const tsNow = now()
    txn(db, () => {
      if (!db.prepare('SELECT 1 FROM memberships WHERE user_id = ?').get(user.id)) {
        db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`)
          .run(uuid(), inv.org_id, user.id, inv.role, inv.team_id, tsNow, tsNow)
        db.prepare(`UPDATE invitations SET status = 'accepted', accepted_by = ?, updated_at = ? WHERE id = ?`).run(user.id, tsNow, inv.id)
        db.prepare(`UPDATE join_requests SET status = 'withdrawn', updated_at = ? WHERE user_id = ? AND status = 'pending'`).run(tsNow, user.id)
      }
    })
    setSession(res, user.id, req)
    return { ok: true }
  })
  app.post('/api/account/password', h((req) => accounts.changePassword(db, signedIn(req), req.body, readCookie(req))))
  app.post('/api/account/password-link', h((req) => { limitAuth(ip(req)); return accounts.requestPasswordLink(db, mailer, cfg, signedIn(req)) }))

  app.post('/api/session/logout', h((req, res) => {
    destroySession(db, readCookie(req))
    res.setHeader('Set-Cookie', cookieHeader(COOKIE, '', { maxAgeSeconds: 0, secure: cfg.production }))
    return { ok: true }
  }))
  app.get('/api/session', h((req) => {
    const base = { googleConfigured: cfg.google.configured, devLogin: cfg.devLogin, emailAuth: { available: true }, legal: cfg.legal || {}, integrations: { viasocket: vs.configured, ai: ai.configured ? (ai.simulated ? 'simulated' : 'configured') : 'not_configured' }, ...(cfg.google.configured ? {} : { googleCallbackUrl: cfg.google.redirectUri || null }) }
    if (!req.user) return { ...base, user: null }
    const c = req.ctx
    return {
      ...base,
      user: { id: req.user.id, name: req.user.name, email: req.user.email, emailVerified: Boolean(req.user.email_verified), pictureUrl: req.user.picture_url, phone: req.user.phone, signIn: accounts.signInMethods(req.user) },
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
      const inv = await m91.invite(out.phone, `KONVO — ${req.user.name}`.slice(0, 80))
      return { ...out, m91: inv.state === 'channel' ? 'channel' : inv.reachable ? 'reachable' : 'invited' }
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
  // ---------- acceptance workflow: accept / decline / transfer, missed-deadline explanations, Slack identities ----------
  app.get('/api/assignments/inbox', h((req) => assignments.myInbox(db, member(req))))
  // ---------- manager-led expectations: confirmed values, suggestions, recommendations, change requests ----------
  app.get('/api/tasks/:id/parameters', h((req) => {
    const ctx = member(req)
    const task = requireVisibleTask(db, ctx, req.params.id)
    const manage = canManageTask(db, ctx, task)
    return params.parametersView(db, ctx, task.id, manage ? { recommendations: prio.listRecommendations(db, task.id), targets: prio.suggestTargets(db, task, params.getExpectations(db, task.id)) } : {})
  }))
  app.post('/api/tasks/:id/parameters/:field/accept', h((req) => params.acceptSuggestion(db, member(req), req.params.id, req.params.field, req.body)))
  app.post('/api/tasks/:id/parameters/:field/reject', h((req) => params.rejectSuggestion(db, member(req), req.params.id, req.params.field, req.body)))
  app.post('/api/tasks/:id/priority-recommendation', h((req, res) => { const out = prio.recommendPriority(db, member(req), req.params.id); res.status(201); return out }))
  app.post('/api/tasks/:id/priority-recommendation/:rid/decision', h((req) => prio.decideRecommendation(db, member(req), req.params.id, req.params.rid, req.body)))
  // ---------- manager analytics (computed from authorised records only; no scores, no rankings) ----------
  app.get('/api/analytics/team', h((req) => analytics.teamAnalytics(db, member(req), req.query)))
  app.get('/api/analytics/person/:userId', h((req) => analytics.personAnalytics(db, member(req), req.params.userId, req.query)))
  app.get('/api/analytics/task/:taskId', h((req) => analytics.taskAnalytics(db, member(req), req.params.taskId)))
  app.get('/api/parameter-review', h((req) => params.reviewQueue(db, member(req))))
  app.get('/api/change-requests', h((req) => params.listChangeRequests(db, member(req), req.query)))
  app.post('/api/tasks/:id/change-requests', h((req, res) => { const out = params.createChangeRequest(db, member(req), req.params.id, req.body); res.status(201); return out }))
  app.post('/api/change-requests/:id/decision', h((req) => params.decideChangeRequest(db, member(req), req.params.id, req.body)))
  app.post('/api/change-requests/:id/withdraw', h((req) => params.withdrawChangeRequest(db, member(req), req.params.id)))
  app.get('/api/tasks/:id/workflow', h((req) => {
    const ctx = member(req)
    const task = requireVisibleTask(db, ctx, req.params.id)
    return { ...assignments.taskWorkflow(db, ctx, task.id), deadline: deadlines.deadlineView(db, ctx, task) }
  }))
  app.post('/api/tasks/:id/accept', h((req) => assignments.acceptAssignment(db, member(req), req.params.id)))
  app.post('/api/tasks/:id/decline', h((req) => assignments.declineAssignment(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/transfer', h((req, res) => { const out = assignments.proposeTransfer(db, member(req), req.params.id, req.body); res.status(201); return out }))
  app.post('/api/transfers/:id/decision', h((req) => assignments.decideTransfer(db, member(req), req.params.id, req.body)))
  app.post('/api/transfers/:id/cancel', h((req) => assignments.cancelTransfer(db, member(req), req.params.id, req.body)))
  app.post('/api/tasks/:id/deadline-explanation', h((req, res) => { const out = deadlines.submitExplanation(db, member(req), req.params.id, req.body); res.status(201); return out }))
  app.get('/api/deadline-explanations', h((req) => deadlines.listExplanations(db, member(req), { status: req.query.status })))
  app.post('/api/deadline-explanations/:id/context', h((req) => deadlines.addContext(db, member(req), req.params.id, req.body)))
  app.post('/api/deadline-explanations/:id/review', h((req) => deadlines.reviewExplanation(db, member(req), req.params.id, req.body)))
  app.get('/api/slack-intake/overview', h((req) => intakeOverview(db, member(req), req.query)))
  app.get('/api/slack-identities', h((req) => slackIdentities.listSlackIdentities(db, member(req))))
  app.post('/api/slack-identities', h((req, res) => { const out = slackIdentities.mapSlackIdentity(db, member(req), req.body); res.status(201); return out }))
  app.delete('/api/slack-identities/:id', h((req) => slackIdentities.removeSlackIdentity(db, member(req), req.params.id)))
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
    const out = await sendThrough(db, vs, ctx, { channel: 'slack', connectionId: req.body?.connectionId, slackChannelId: channelId }, { subject: 'KONVO task', text })
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
    res.setHeader('Content-Disposition', `attachment; filename="konvo-${type}-${now().slice(0, 10)}.csv"`)
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
  app.get('/api/viasocket/connections/:id/slack-channels', h((req) => slackChannels(db, vs, member(req), req.params.id, { search: typeof req.query.search === 'string' ? req.query.search.slice(0, 80) : undefined })))
  app.get('/api/viasocket/connections/:id/slack-users', h((req) => slackUsers(db, vs, member(req), req.params.id, { search: typeof req.query.search === 'string' ? req.query.search.slice(0, 80) : undefined })))

  // A1: my own notifications, on my own connection.
  app.get('/api/notifications/prefs', h((req) => auto.getNotificationPrefs(db, member(req))))
  app.put('/api/notifications/prefs', h((req) => auto.saveNotificationPrefs(db, member(req), vs, req.body)))
  // A real message, only to the person pressing the button (their own DM / own email / a channel they chose).
  app.post('/api/automations/test-send', h((req) => auto.sendTestToSelf(db, member(req), vs, req.body)))

  // C: Gmail / Slack intake.
  app.get('/api/intakes', h((req) => intake.listIntakes(db, member(req))))
  app.get('/api/intakes/targets', h((req) => intake.intakeTargets(db, vs, member(req), String(req.query.app || ''), String(req.query.connectionId || ''), { search: typeof req.query.search === 'string' ? req.query.search.slice(0, 80) : undefined })))
  app.post('/api/intakes/sample', h((req) => intake.sampleIntake(db, vs, member(req), req.body)))
  app.post('/api/intakes', h((req, res) => { res.status(201); return intake.createIntake(db, vs, member(req), req.body, { appUrl: cfg.appUrl }) }))
  app.post('/api/intakes/:id/status', h((req) => intake.setIntakeStatus(db, vs, member(req), req.params.id, req.body)))
  app.post('/api/intakes/:id/mode', h((req) => intake.setIntakeMode(db, member(req), req.params.id, req.body)))
  // Called by the subscription's handler on viaSocket, with that subscription's own bearer token.
  app.post('/api/viasocket/events/:id', h((req) => {
    const auth = req.get('authorization') || ''
    return intake.receiveIntakeEvent(db, req.params.id, auth.startsWith('Bearer ') ? auth.slice(7).trim() : null, req.body)
  }))

  // D: the restricted builder for one KONVO context.
  app.get('/api/viasocket/contexts', h((req) => contextFlows.listContexts(member(req), typeof req.query.app === 'string' ? req.query.app : undefined)))
  app.get('/api/viasocket/context/:key', h((req) => contextFlows.contextEmbed(vs, member(req), req.params.key, { app: typeof req.query.app === 'string' ? req.query.app : undefined })))
  app.delete('/api/viasocket/connections/:id', h((req) => conns.disconnect(db, vs, member(req), req.params.id)))
  app.get('/api/viasocket/embed-flows', h((req) => conns.listEmbedFlows(db, member(req))))
  app.get('/api/viasocket/embed-flows/:flowId/runs', h((req) => conns.embedFlowRuns(db, vs, member(req), req.params.flowId)))
  app.post('/api/viasocket/embed-flows/:flowId/sync', h((req) => {
    const ctx = member(req)
    const context = req.body?.context ? (contextFlows.requireContext(ctx, String(req.body.context)), String(req.body.context)) : null
    const appSlug = typeof req.body?.app === 'string' && /^[a-z0-9-]{2,40}$/.test(req.body.app) ? req.body.app : null
    return conns.syncEmbedFlow(db, vs, ctx, req.params.flowId, { context, app: appSlug })
  }))
  app.get('/vendor/viasocket-apps-browser.js', (req, res) => res.type('text/javascript').sendFile(VIASOCKET_BROWSER))

  // ---------- AI work measurement ----------
  const limitAnalyse = rateLimiter({ windowMs: 3600000, max: 30 })
  app.get('/api/tasks/:id/assessment', h((req) => measure.getTaskAssessment(db, member(req), ai, req.params.id, aiModeNow)))
  app.get('/api/tasks/:id/assessment/preview', h((req) => measure.previewAnalysis(db, member(req), ai, req.params.id, aiModeNow)))
  app.post('/api/tasks/:id/assessment/analyse', h((req) => {
    const ctx = member(req)
    limitAnalyse(`analyse:${ctx.user.id}`)
    const out = measure.analyseTask(db, ctx, ai, req.params.id, { mode: aiModeNow })
    return { ...out, view: measure.getTaskAssessment(db, ctx, ai, req.params.id, aiModeNow) }
  }))
  app.post('/api/tasks/:id/assessment/respond', h((req) => { const ctx = member(req); measure.employeeRespond(db, ctx, req.params.id, req.body); return measure.getTaskAssessment(db, ctx, ai, req.params.id, aiModeNow) }))
  app.post('/api/tasks/:id/assessment/review', h((req) => { const ctx = member(req); measure.managerReview(db, ctx, req.params.id, req.body); return measure.getTaskAssessment(db, ctx, ai, req.params.id, aiModeNow) }))
  app.get('/api/assessments/:id', h((req) => measure.getAssessmentById(db, member(req), req.params.id)))
  app.get('/api/contribution/team', h((req) => measure.teamOverview(db, member(req), req.query)))
  const limitWork = rateLimiter({ windowMs: 3600000, max: 6 })
  app.post('/api/contribution/analyse', h((req) => { const ctx = member(req); limitWork(`work:${ctx.user.id}`); return measure.analyseWork(db, ctx, ai, aiModeNow, { userId: req.body?.userId }) }))
  app.get('/api/contribution/intelligence', h((req) => measure.teamIntelligence(db, member(req), req.query)))

  // ---------- final sprint: assistant, copilot, contribution journeys, signals ----------
  const limitAssistant = rateLimiter({ windowMs: 60000, max: 30 })
  app.get('/api/assistant/day', h((req) => assistant.dayDigest(db, member(req), { day: req.query.day, tz: req.query.tz, userId: req.query.userId })))
  app.get('/api/assistant/suggestions', h((req) => { const ctx = member(req); return { mine: assistant.suggestions(false), team: isManager(ctx) ? assistant.suggestions(true) : [], ai: measure.aiMode(cfg, ai).mode === 'on' && ai.configured } }))
  app.post('/api/assistant/ask', h((req) => { const ctx = member(req); limitAssistant(`ask:${ctx.user.id}`); return assistant.ask(db, ctx, req.body || {}) }))
  app.post('/api/assistant/day/ai', h(async (req) => { const ctx = member(req); limitAnalyse(`analyse:${ctx.user.id}`); return assistant.aiWriteUp(db, ctx, ai, aiModeNow, req.body || {}) }))
  app.get('/api/journeys', h((req) => journeys.listJourneys(db, member(req), req.query)))
  app.get('/api/journeys/:taskId', h((req) => journeys.taskJourney(db, member(req), req.params.taskId)))
  app.get('/api/signals', h((req) => signals.listSignals(db, member(req), req.query)))
  app.post('/api/signals/:id', h((req) => signals.actOnSignal(db, member(req), req.params.id, req.body)))

  // ---------- sprint 2: external evidence ----------
  const limitEvidenceIn = rateLimiter({ windowMs: 60000, max: 120 })
  app.post('/api/work-evidence/events/:id', h((req) => {
    limitEvidenceIn(`evidence:${req.params.id}`)
    const auth = req.get('authorization') || ''
    return receiveEvidenceEvent(db, req.params.id, auth.startsWith('Bearer ') ? auth.slice(7).trim() : null, req.body)
  }))
  app.get('/api/work-evidence/catalog', h((req) => { member(req); return { configured: vs.configured, apps: evidenceSources.catalog() } }))
  app.get('/api/work-evidence/sources', h((req) => evidenceSources.listSources(db, member(req), { userId: req.query.userId })))
  app.get('/api/work-evidence/scope-options', h((req) => evidenceSources.scopeOptions(db, vs, member(req), { app: req.query.app, connectionId: req.query.connectionId, parent: req.query.parent, search: req.query.search })))
  app.post('/api/work-evidence/sources', h((req) => evidenceSources.createSource(db, vs, member(req), req.body, { appUrl: cfg.appUrl })))
  app.post('/api/work-evidence/sources/:id/status', h((req) => evidenceSources.setSourceStatus(db, vs, member(req), req.params.id, req.body)))
  app.get('/api/work-evidence/identities', h((req) => evidenceSources.listIdentities(db, member(req), req.query.userId || undefined)))
  app.post('/api/work-evidence/identities', h((req) => evidenceSources.addIdentity(db, member(req), req.body)))
  app.delete('/api/work-evidence/identities/:id', h((req) => evidenceSources.removeIdentity(db, member(req), req.params.id)))
  app.get('/api/work-evidence', h((req) => evidenceSvc.listEvidence(db, member(req), req.query)))
  app.get('/api/work-evidence/:id', h((req) => evidenceSvc.getEvidence(db, member(req), req.params.id)))
  app.delete('/api/work-evidence/:id', h((req) => evidenceSvc.removeEvidence(db, member(req), req.params.id)))
  app.post('/api/work-evidence/:id/links', h((req) => evidenceSvc.linkToTask(db, member(req), req.params.id, req.body)))
  app.post('/api/work-evidence/:id/dispute', h((req) => evidenceSvc.disputeAttribution(db, member(req), req.params.id, req.body)))
  app.post('/api/work-evidence/:id/attribution', h((req) => evidenceSvc.resolveAttribution(db, member(req), req.params.id, req.body)))
  app.post('/api/work-evidence-links/:id', h((req) => evidenceSvc.decideLink(db, member(req), req.params.id, req.body)))
  app.post('/api/work-evidence-links/:id/share', h((req) => evidenceSvc.setShare(db, member(req), req.params.id, req.body)))
  app.get('/api/tasks/:id/external-evidence', h((req) => evidenceSvc.taskEvidence(db, member(req), req.params.id)))

  app.get('/api/contribution/people/:userId', h((req) => measure.personProfile(db, member(req), req.params.userId, req.query)))

  // ---------- scheduled jobs (Embarko schedules call these with CRON_SECRET) ----------
  const cronOk = (req) => {
    const expected = cfg.cronSecret
    if (!expected || req.get('authorization') !== `Bearer ${expected}`) throw new AppError(401, 'unauthorized', 'Unauthorized')
  }
  app.get('/tasks/alerts', h(async (req, res) => {
    cronOk(req)
    const out = await runAlertJob({ db, vs, m91, cfg, ai })
    res.type('text/plain').send(out.text)
  }))
  app.get('/tasks/weekly-report', h(async (req, res) => {
    cronOk(req)
    const out = await auto.runWeeklyReports(db, vs, { appUrl: cfg.appUrl })
    res.type('text/plain').send(`Weekly reports for the week of ${out.weekStart}: ${out.results.length} manager/admin report(s); delivered by Slack/Gmail ${out.results.filter((r) => r.delivered).length}`)
  }))

  app.use('/api', (req, res, next) => next(new AppError(404, 'not_found', 'No such API route.')))
  /* Path-based entry points for the landing → SPA hash routes */
  app.get('/login', (_req, res) => res.redirect(302, '/#/login'))
  app.get('/signup', (_req, res) => res.redirect(302, '/#/signup'))
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
export async function runAlertJob({ db, vs, m91, cfg, ai = null }) {
  const lease = db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('alert_job_lease', ?, ?)
                            ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at WHERE app_state.value < ?`)
    .run(new Date(Date.now() + 4 * 60000).toISOString(), now(), now()).changes
  if (!lease) return { text: 'Skipped: another run is in progress.' }
  try {
    const replayed = recoverOutbox()
    const raised = alerts.scanAlerts(db)
    const sent = await alerts.processDeliveries(db, m91)
    const retried = await auto.retryFailedRuns(db, vs, { appUrl: cfg.appUrl })
    const analyses = ai ? recoverRuns(db, ai) : 0
    const evidence = retryInbox(db)
    purgeIgnoredText(db)
    const sig = signals.detectAll(db)
    const health = await evidenceSources.checkSourceHealth(db, vs).catch((e) => ({ checked: 0, error: e.message }))
    db.prepare(`INSERT INTO app_state (key, value, updated_at) VALUES ('alert_job_last', ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).run(now(), now())
    let backup = null
    try { backup = await backupIfDue(db, cfg.dataDir) } catch (error) { console.error('[backup] failed:', error.message); backup = { error: error.message } }
    const last = lastBackup(db)
    // Row counts (no data) let the operator confirm the database persisted across restarts from the schedule history.
    const count = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n
    const stats = `db: ${count('organizations')} org(s), ${count('users')} user(s), ${count('tasks')} task(s), ${count('task_requests')} request(s), ${count('impact_records')} impact record(s)`
    const backupText = backup?.error ? `backup FAILED (${backup.error})`
      : backup ? `backup made (off-host ${backup.offsite}${backup.offsiteError ? `: ${backup.offsiteError}` : ''}; ${backup.restoreVerified ? 'restore verified' : `restore NOT verified: ${backup.restoreDetail}`})`
        : last ? `last backup ${last.at} (off-host ${last.offsite}; ${last.restoreVerifiedAt ? 'restore verified' : 'restore not verified'})` : 'no backup yet'
    return { raised, sent, retried, replayed, analyses, text: `Alerts raised ${raised}; M91 sent ${sent.sent}, retrying ${sent.retrying}, failed ${sent.failed}, not configured ${sent.notConfigured}; automation retries ${retried.retried}; AI analyses resumed ${analyses}; evidence events retried ${evidence.retried}; evidence sources checked ${health.checked}; signals opened ${sig.opened}, resolved ${sig.resolved}; outbox replayed ${replayed}; ${backupText}; ${stats}` }
  } finally {
    db.prepare(`UPDATE app_state SET value = ?, updated_at = ? WHERE key = 'alert_job_lease'`).run(new Date(0).toISOString(), now())
  }
}
