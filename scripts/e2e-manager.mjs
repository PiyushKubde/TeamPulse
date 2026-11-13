// Browser journeys for the manager experience (Phase C): dashboard, Team Intelligence, Reviews, Copilot, signals, person view,
// requests — in light and dark themes, desktop and phone, with console-error and overflow checks. (Based on the evidence suite's
// seed: same stand-ins, no live viaSocket, AI or M91.)
// Sprint 2 (work evidence + team intelligence) header follows. The demo database gets two evidence sources for
// Priya (GitHub repository, Slack channel) inserted directly — as if switched on through viaSocket — and events are
// then delivered through the real webhook with the real bearer tokens. viaSocket itself is not called, and the AI is
// the SIMULATED development analyser. Proves the screens and flows; claims nothing about live integrations.
// Usage: npm run test:e2e:manager   (SCREENSHOTS=<dir> to keep screenshots)
/* global document, location */
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
const priyaId = priya
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
const at = new Date().toISOString()
const tok = tokens.pull_requests
await fetch(`${base}/api/work-evidence/events/${tok.sub}`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${tok.token}` }, body: JSON.stringify({ event: { action: 'closed', number: 77, sender: { login: 'priya-gh' }, repository: { full_name: 'demo/checkout' }, pull_request: { number: 77, user: { login: 'priya-gh' }, state: 'closed', merged: true, merged_at: at, title: `${ref} Cache catalog lookups`, body: 'Adds a cache.', html_url: 'https://github.com/demo/checkout/pull/77', additions: 140, deletions: 12, changed_files: 5, created_at: at } } }) })

const browser = await chromium.launch()
const problems = []
let step = ''
const ok = (cond, msg) => { if (!cond) throw new Error(`Check failed: ${msg}`) }
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
async function session(email, { theme = 'light', viewport = { width: 1366, height: 900 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  await ctx.addInitScript((t) => { try { localStorage.setItem('tp-theme', t) } catch { /* private mode */ } }, theme)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${email} ${theme}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|net::|status of 4\d\d|status of 503|fonts\./.test(m.text())) problems.push(`[${email} ${theme}] ${step}: console ${m.text()}`) })
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  return page
}
const themeOf = (p) => p.evaluate(() => document.documentElement.dataset.theme)

try {
  for (const theme of ['light', 'dark']) {
    step = `manager dashboard (${theme})`
    const m = await session('manager@demo.teampulse', { theme })
    ok(await themeOf(m) === theme, `theme is ${theme}`)
    await m.waitForSelector('.wb-col')
    ok((await m.locator('.wb-col h2').allTextContents()).join('|') === 'To do|In progress|Blocked|In review|Done', 'workboard columns')
    ok((await m.locator('.wb-metric').count()) === 4, 'four summary metrics')
    ok(!(await m.locator('nav[aria-label="Decisions waiting for you"], .intervene').count()), 'the old overview panels are gone')
    ok(await overflow(m) <= 1, `dashboard fits (${await overflow(m)}px)`)

    step = `team intelligence (${theme})`
    await m.click('nav >> text=Team Intelligence')
    await m.waitForSelector('h1:has-text("Team intelligence")')
    for (const h of ['Significant contributions', 'Open blockers', 'Unverified outcomes', 'Shared ownership', 'Your people']) ok(await m.isVisible(`h2:has-text("${h}")`), `intelligence section ${h}`)
    await m.click('#copilot button.chip:has-text("Who is blocked and why?")')
    await m.waitForSelector('.answer h3')

    step = `contribution person view (${theme})`
    await m.click('table >> a:has-text("Priya Sharma")')
    await m.waitForSelector('h2:has-text("In short")')
    await m.waitForSelector('#p-tasks a.ttl')
    ok(await m.isVisible('#p-evidence'), 'person evidence card')

    step = `reviews workspace (${theme})`
    if (theme === 'light') {
      const r = await m.evaluate(async (id) => (await fetch(`/api/tasks/${id}/assessment/analyse`, { method: 'POST', headers: { 'X-Requested-With': 'TeamPulse' } })).status, task)
      ok(r === 200 || r === 202, `analysis started (${r})`)
    }
    await m.click('nav >> text=Contribution Reviews')
    await m.waitForSelector('h1:has-text("Contribution reviews")')
    ok(await m.isVisible('text=The AI suggests; you decide.'), 'AI vs manager principle')
    await m.waitForSelector('#team-signals >> text=Unresolved blocker')
    if (theme === 'light') {
      await m.click('.review-tabs a:has-text("AI assessments")')
      await m.waitForSelector('.review-item:has-text("Cut checkout API")', { timeout: 20000 })
      // A single waiting assessment opens by itself; otherwise Inspect opens it.
      await m.waitForTimeout(600)
      if (!(await m.isVisible('.assessment-slot table.dims'))) await m.click('.review-item:has-text("Cut checkout API") >> button[data-open-assessment]')
      await m.waitForSelector('.assessment-slot table.dims', { timeout: 20000 })
      ok(await m.isVisible('.assessment-slot .decision-box.manager >> text=The AI only suggests'), 'AI suggestion vs manager decision')
      ok(await m.isVisible('.assessment-slot >> text=AI suggestion') || await m.isVisible('.assessment-slot >> text=Simulated'), 'dimension provenance labelled')
      ok(await m.isVisible('.assessment-slot button[data-mgr="APPROVE"]'), 'manager can approve inside the workspace')
    }
    await m.click('.review-tabs a:has-text("Submissions")')
    await m.waitForSelector('.review-item >> text=Automate weekly invoice reconciliation')
    await m.click('.review-tabs a:has-text("Signals")')
    await m.waitForSelector('.sig-detail >> text=Why it matters')
    ok(await m.isVisible('.signal >> text=Recommended:'), 'recommended action shown')

    step = `copilot (${theme})`
    await m.click('nav >> text=Manager Copilot')
    await m.waitForSelector('h1:has-text("Ask about your team")')
    for (const qn of ['Who needs my attention today?', 'What work is currently blocked?', 'Which contributions need review?', 'What has moved forward this week?', 'Where can I help the team?']) ok(await m.isVisible(`.q-card:has-text("${qn}")`), `suggested: ${qn}`)
    await m.click('.q-card:has-text("Where can I help the team?")')
    await m.waitForSelector('.ask-bubble')
    await m.waitForSelector('.answer h3')
    ok(await m.isVisible('.answer >> text=From records'), 'answer labelled as from records')

    step = `requests (${theme})`
    await m.click('nav >> text=Task Requests')
    await m.waitForSelector('h1:has-text("Task requests")')
    ok(await m.isVisible('h2:has-text("To decide")'), 'to decide group')
    await m.goto(`${base}/#/team-tasks`); await m.waitForSelector('table.task-table')
    ok(await overflow(m) <= 1, `team tasks fits (${await overflow(m)}px)`)
  }

  step = 'dismiss a signal (state tabs + reason kept)'
  const d = await session('manager@demo.teampulse')
  await d.goto(`${base}/#/reviews?tab=signals`)
  await d.waitForSelector('.signal')
  await d.click('.signal:has-text("Unresolved blocker") >> button:has-text("Dismiss")')
  await d.fill('#cf-reason', 'Escalated to the vendor myself.')
  await d.click('#cf-ok')
  await d.waitForSelector('text=Dismissed.')
  await d.click('.segmented a:has-text("Dismissed")')
  await d.waitForSelector('.signal:has-text("Escalated to the vendor myself.")')

  step = 'phone layouts'
  for (const theme of ['light', 'dark']) {
    const p = await session('manager@demo.teampulse', { theme, viewport: { width: 390, height: 844 }, mobile: true })
    for (const [h, sel] of [['#/dashboard', '.wb-col'], ['#/contribution', 'h1:has-text("Team intelligence")'], ['#/reviews?tab=signals', '.signal'], ['#/copilot', '.q-card'], ['#/requests', 'h1:has-text("Task requests")'], ['#/team-tasks', 'table.task-table'], ['#/contribution/' + priyaId, 'h2:has-text("In short")']]) {
      await p.goto(`${base}/${h}`); await p.waitForSelector(sel)
      ok(await overflow(p) <= 1, `${h} fits a phone in ${theme} (${await overflow(p)}px)`)
    }
  }

  step = 'employee cannot open manager pages'
  const e = await session('priya@demo.teampulse')
  await e.goto(`${base}/#/copilot`); await e.waitForSelector('h1:has-text("Manager Copilot is for managers")')
  await e.goto(`${base}/#/reviews`); await e.waitForFunction(() => location.hash === '#/dashboard'); await e.waitForSelector('main h1')
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
} finally {
  await browser.close(); server.kill()
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log('E2E manager journeys passed (light and dark, desktop and phone; no console errors; simulated analyser, no live viaSocket, AI or M91).')
