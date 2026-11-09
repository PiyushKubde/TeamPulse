// Test harness: a fresh in-memory database and the real HTTP app on a random port.
import { openDatabase, now, uuid } from '../server/db.js'
import { createApp } from '../server/app.js'
import { loadConfig } from '../server/config.js'
import { createSession, COOKIE } from '../server/auth/sessions.js'
import { upsertGoogleUser } from '../server/auth/google.js'
import { createOrganization } from '../server/services/orgs.js'
import { settled } from '../server/services/events.js'
import { createM91Transport } from '../server/integrations/m91.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function makeUser(db, { name = 'User', email } = {}) {
  const e = email || `${name.toLowerCase().replace(/\W+/g, '')}.${Math.random().toString(36).slice(2, 7)}@example.com`
  const user = upsertGoogleUser(db, { sub: `test:${e}`, email: e, emailVerified: true, name })
  const { token } = createSession(db, user.id)
  return { ...user, cookie: `${COOKIE}=${token}` }
}

/** Adds an existing user to an org with a role and team. */
export function addMember(db, orgId, user, role, teamId) {
  db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(uuid(), orgId, user.id, role, teamId, now(), now())
}

export function addTeam(db, orgId, name, managerId) {
  const id = uuid()
  db.prepare('INSERT INTO teams (id, org_id, name, manager_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, orgId, name, managerId, now(), now())
  return id
}

/**
 * An organization with: admin, manager (manages teamA), employee + employee2 in teamA, outsider employee in teamB
 * (managed by manager2). Plus a second, separate organization with its own admin.
 */
export function seedOrg(db) {
  const admin = makeUser(db, { name: 'Ada Admin' })
  const org = createOrganization(db, admin, { name: 'Acme', teamName: 'Leadership' })
  const leadershipTeam = db.prepare('SELECT id FROM teams WHERE org_id = ?').get(org.id).id
  const manager = makeUser(db, { name: 'Mona Manager' })
  const manager2 = makeUser(db, { name: 'Max Manager' })
  const teamA = addTeam(db, org.id, 'Platform', manager.id)
  const teamB = addTeam(db, org.id, 'Sales', manager2.id)
  addMember(db, org.id, manager, 'manager', teamA)
  addMember(db, org.id, manager2, 'manager', teamB)
  const employee = makeUser(db, { name: 'Eve Employee' })
  const employee2 = makeUser(db, { name: 'Ed Employee' })
  const outsider = makeUser(db, { name: 'Olly Sales' })
  addMember(db, org.id, employee, 'employee', teamA)
  addMember(db, org.id, employee2, 'employee', teamA)
  addMember(db, org.id, outsider, 'employee', teamB)
  const otherAdmin = makeUser(db, { name: 'Zed OtherOrg' })
  const otherOrg = createOrganization(db, otherAdmin, { name: 'Globex' })
  return { org, leadershipTeam, admin, manager, manager2, teamA, teamB, employee, employee2, outsider, otherAdmin, otherOrg }
}

export async function startApp({ vs = { configured: false }, m91 = createM91Transport({}), cfgOverrides = {}, google } = {}) {
  const db = openDatabase(':memory:')
  const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'teampulse-test-')), cronSecret: 'test-cron-secret', devLogin: false, appUrl: 'https://teampulse.test', ...cfgOverrides })
  const app = createApp({ db, cfg, vs, m91, ...(google ? { google } : {}) })
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  const base = `http://127.0.0.1:${server.address().port}`
  const call = async (path, { method = 'GET', body, as, headers = {}, raw } = {}) => {
    const res = await fetch(base + path, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined && !raw ? { 'Content-Type': 'application/json' } : {}), ...(method !== 'GET' ? { 'X-Requested-With': 'TeamPulse' } : {}), ...(as ? { cookie: as.cookie } : {}), ...headers },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined
    })
    const text = await res.text()
    let parsed = null
    try { parsed = text ? JSON.parse(text) : null } catch { parsed = text }
    return { status: res.status, body: parsed, text, headers: res.headers }
  }
  const close = () => new Promise((r) => { app.locals.stopListening(); server.close(r) })
  return { db, cfg, app, base, call, close, settled }
}
