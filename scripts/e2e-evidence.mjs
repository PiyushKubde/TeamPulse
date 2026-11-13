// Browser journeys for Sprint 2 (work evidence + team intelligence). The demo database gets two evidence sources for
// Priya (GitHub repository, Slack channel) inserted directly — as if switched on through viaSocket — and events are
// then delivered through the real webhook with the real bearer tokens. viaSocket itself is not called, and the AI is
// the SIMULATED development analyser. Proves the screens and flows; claims nothing about live integrations.
// Usage: npm run test:e2e:evidence   (SCREENSHOTS=<dir> to keep screenshots)
/* global document */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-ev-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 4300 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', AI_PROVIDER: 'mock' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER', 'M91_SEND_LINK', 'M91_API_KEY', 'VIASOCKET_EMBED_SECRET']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })

// ---- seed two sources for Priya ----
const db = new DatabaseSync(join(dataDir, 'teampulse.db'))
const now = new Date().toISOString()
const priya = db.prepare(`SELECT id FROM users WHERE email = 'priya@demo.teampulse'`).get().id
const org = db.prepare('SELECT org_id FROM memberships WHERE user_id = ?').get(priya).org_id
const task = db.prepare(`SELECT id FROM tasks WHERE title LIKE 'Cut checkout API p95%'`).get().id
const ref = `TP-${task.slice(0, 8).toUpperCase()}`
const tokens = {}
for (const [app, scope, label, kind, key] of [['github', { repo: 'demo/checkout' }, 'demo/checkout', 'pull_requests', 'Pull_Request_Opens_or_Closes'], ['github', { repo: 'demo/checkout', branch: 'main' }, 'demo/checkout (commits)', 'commits', 'New_Commit_Pushed'], ['slack', { channel: 'C0PERF' }, '#perf', 'messages', 'New_Message_in_Channels']]) {
  const conn = randomUUID(); const src = randomUUID(); const sub = randomUUID(); const token = `tpv_${randomUUID().replace(/-/g, '')}`
  db.prepare(`INSERT INTO app_connections (id, org_id, user_id, app_slug, service_id, auth_id, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(conn, org, priya, app, `svc-${app}`, `auth_${sub.slice(0, 8)}`, null, now, now)
  db.prepare(`INSERT INTO evidence_sources (id, org_id, owner_id, app, connection_id, scope_json, scope_label, kinds_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`).run(src, org, priya, app, conn, JSON.stringify(scope), label, JSON.stringify([kind]), now, now)
  db.prepare(`INSERT INTO evidence_subscriptions (id, org_id, source_id, kind, trigger_key, version, script_id, input_data, token_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'v1', 'script-e2e', '{}', ?, 'ACTIVE', ?, ?)`).run(sub, org, src, kind, key, createHash('sha256').update(token).digest('hex'), now, now)
  tokens[kind] = { sub, token }
}
for (const [app, identity] of [['github', 'priya-gh'], ['slack', 'U0PRIYA01']]) db.prepare(`INSERT INTO external_identities (id, org_id, user_id, app, identity, source, created_at) VALUES (?, ?, ?, ?, ?, 'declared', ?)`).run(randomUUID(), org, priya, app, identity, now)
// A blocker reported 30 hours ago: a real "unresolved blocker" condition for the signals.
db.prepare(`UPDATE blockers SET reported_at = ?`).run(new Date(Date.now() - 30 * 3600000).toISOString())
db.close()

const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
async function deliver(kind, event) {
  const { sub, token } = tokens[kind]
  const res = await fetch(`${base}/api/work-evidence/events/${sub}`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ event }) })
  if (!res.ok) throw new Error(`delivery failed ${res.status} ${await res.text()}`)
  return res.json()
}

const browser = await chromium.launch()
const problems = []
let step = ''
let current = null
const ok = (cond, msg) => { if (!cond) throw new Error(`Check failed: ${msg}`) }
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }) }
async function session(email, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${email}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|net::|status of 4\d\d|status of 503/.test(m.text())) problems.push(`[${email}] ${step}: console ${m.text()}`) })
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  current = page
  return page
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

try {
  step = 'events arrive through the webhook'
  const at = new Date().toISOString()
  await deliver('pull_requests', { action: 'closed', number: 77, sender: { login: 'priya-gh' }, repository: { full_name: 'demo/checkout' }, pull_request: { number: 77, user: { login: 'priya-gh' }, state: 'closed', merged: true, merged_at: at, title: `${ref} Cache catalog lookups`, body: 'Adds a 60s cache in front of catalog lookups.', html_url: 'https://github.com/demo/checkout/pull/77', additions: 140, deletions: 12, changed_files: 5, created_at: at } })
  await deliver('commits', { commits: [{ sha: 'd1', commit: { message: `${ref} tune pool size`, author: { date: at } }, author: { login: 'dev-gh' }, html_url: 'https://github.com/demo/checkout/commit/d1' }] })
  await deliver('messages', { ts: `${Math.floor(Date.now() / 1000)}.000100`, text: 'Checkout p95 latency is down to 180ms on the dashboard after the cache.', type: 'message', user: 'U0PRIYA01', channel: 'C0PERF' })
  await deliver('messages', { ts: `${Math.floor(Date.now() / 1000) + 1}.000100`, text: 'Lunch at 1?', type: 'message', user: 'U0PRIYA01', channel: 'C0PERF' })

  step = 'employee: evidence workspace'
  const e = await session('priya@demo.teampulse')
  await e.click('nav >> text=My Work Evidence')
  await e.waitForSelector('h1:has-text("My work evidence")')
  ok(await e.isVisible('text=Collecting'), 'source status shown')
  ok(await e.isVisible(`text=${ref} Cache catalog lookups`), 'PR suggested for confirmation')
  ok(await e.isVisible('text=Possible match — confirm?') || await e.isVisible('text=Suggested link'), 'link states shown')
  await shot(e, 'ev1-employee-review')
  await e.click('.ev-item:has-text("Cache catalog lookups") >> button:has-text("Yes, it belongs here")')
  await e.waitForSelector('text=Linked.')
  await e.click('a:has-text("Not linked")')
  await e.waitForSelector('.ev-item:has-text("Lunch at 1?")')
  ok(!(await e.isVisible('text=Ticket count')), 'no activity counts')

  step = 'employee: analyse my work'
  await e.click('#analyse-mine')
  await e.waitForSelector('text=Analysis started')
  await shot(e, 'ev2-analyse')
  await e.goto(`${base}/#/tasks/${task}`)
  await e.waitForSelector('#ext-evidence >> text=From connected apps')
  await e.waitForSelector('#ai-card table.dims', { timeout: 20000 })
  ok(await e.isVisible('#ai-card a.chip:has-text("GitHub")'), 'linked GitHub evidence cited on the card')
  await shot(e, 'ev3-task')

  step = 'manager: team intelligence and evidence review'
  const m = await session('manager@demo.teampulse')
  await m.click('nav >> text=Team Intelligence')
  await m.waitForSelector('h1:has-text("Team intelligence")')
  ok(await m.isVisible('h2:has-text("Open blockers")'), 'blockers section'); ok(await m.isVisible('text=outside their control'), 'external blocker marked')
  await shot(m, 'ev4-intelligence')
  await m.click('a:has-text("Evidence to review")')
  await m.waitForSelector('text=author not known to KONVO')
  const sel = await m.$('select[data-resolve-select]')
  const dev = await sel.$$eval('option', (os) => os.find((o) => o.textContent === 'Dev Patel').value)
  await sel.selectOption(dev)
  await m.click('button[data-resolve]')
  await m.waitForSelector('text=Saved.')
  await shot(m, 'ev5-review')

  step = 'employee: AI Work Assistant'
  await e.click('nav >> text=Analyse My Day')
  await e.waitForSelector('h1:has-text("AI Work Assistant")')
  await e.click('#analyse-day')
  await e.waitForSelector('h2:has-text("Your day")')
  ok(await e.isVisible('.digest-summary'), 'day summary')
  ok(await e.isVisible('h3:has-text("Next priorities")'), 'next priorities')
  await e.click('#ask-box button.chip:has-text("What should I focus on next?")')
  await e.waitForSelector('.answer h3:has-text("Focus next")')
  await e.fill('#q-mine', 'Find evidence for checkout latency')
  await e.click('#ask-box button[type=submit]')
  await e.waitForSelector('.answer h3:has-text("Evidence for")')
  ok(await e.isVisible('.answer >> text=Cache catalog lookups'), 'found the linked PR')
  await e.fill('#q-mine', 'Compose a haiku')
  await e.click('#ask-box button[type=submit]')
  await e.waitForSelector('.answer h3:has-text("I can answer these")')
  await shot(e, 'ev7-assistant')

  step = 'employee: contribution journey'
  await e.click('nav >> text=Contribution Journeys')
  await e.waitForSelector('h1:has-text("My contributions")')
  await e.click('a.journey-card:has-text("Cut checkout API p95")')
  await e.waitForSelector('.stage-strip')
  ok(await e.isVisible('ol.journey >> text=GitHub: PR #77'), 'GitHub step in the timeline')
  ok(await e.isVisible('text=Not part of this work'), 'correction available')
  ok(await e.isVisible('h2:has-text("What is missing")'), 'missing links shown')
  await shot(e, 'ev8-journey')

  step = 'manager: copilot, reviews, signals'
  await m.click('nav >> text=Team Intelligence')
  await m.waitForSelector('#copilot button.chip')
  await m.click('#copilot button.chip:has-text("Who is blocked and why?")')
  await m.waitForSelector('.answer >> text=Dev Patel: Migrate billing DB')
  ok(await m.isVisible('.answer >> text=outside their control'), 'external blocker explained')
  await shot(m, 'ev9-copilot')
  await m.click('nav >> text=Contribution Reviews')
  await m.waitForSelector('h1:has-text("Contribution reviews")')
  await m.waitForSelector('#team-signals >> text=Unresolved blocker')
  await m.click('#team-signals li:has-text("Unresolved blocker") >> button:has-text("Dismiss")')
  await m.fill('#cf-reason', 'Vendor ticket escalated by me this morning.')
  await m.click('#cf-ok')
  await m.waitForSelector('text=Dismissed.')
  await shot(m, 'ev10-reviews')
  await m.click('nav >> text=Overview')
  await m.waitForSelector('h2:has-text("Where to intervene")')

  step = 'phone width'
  const p = await session('priya@demo.teampulse', { width: 390, height: 844 })
  await p.goto(`${base}/#/evidence?state=all`); await p.waitForSelector('h1:has-text("My work evidence")')
  ok(await overflow(p) <= 1, `evidence page fits a phone (${await overflow(p)}px)`)
  await shot(p, 'ev6-phone')
  const pm = await session('manager@demo.teampulse', { width: 390, height: 844 })
  await pm.goto(`${base}/#/contribution`); await pm.waitForSelector('h1:has-text("Team intelligence")')
  ok(await overflow(pm) <= 1, `team intelligence fits a phone (${await overflow(pm)}px)`)
  for (const [page, url, sel] of [[p, '#/assistant?run=1', 'h2:has-text("Your day")'], [p, `#/journey/${task}`, '.stage-strip'], [p, '#/contributions', 'h1:has-text("My contributions")'], [p, '#/my-tasks', 'h1:has-text("My tasks")'], [p, '#/evidence', 'h1:has-text("My work evidence")'], [p, `#/tasks/${task}`, '.task-head'], [pm, '#/reviews', 'h1:has-text("Contribution reviews")'], [pm, '#/dashboard', 'h2:has-text("Where to intervene")']]) {
    await page.goto(`${base}/${url}`); await page.waitForSelector(sel)
    ok(await overflow(page) <= 1, `${url} fits a phone (${await overflow(page)}px)`)
  }
  await shot(p, 'ev11-phone-journey')
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
  if (current) problems.push(`page (${current.url()}): ${(await current.innerText('body').catch(() => '')).slice(0, 600)}`)
} finally {
  await browser.close(); server.kill()
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log('E2E evidence journeys passed (webhook deliveries with real tokens; viaSocket not called; simulated analyser).')
