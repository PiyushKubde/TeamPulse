// Browser journey for the Slack intake → accept / decline / transfer → missed-deadline explanation workflow.
// A temporary DATA_DIR and the demo organization; the Slack intake subscription is inserted directly (as if switched on through
// viaSocket) and Slack messages are delivered to the real webhook route with its real bearer token. viaSocket, Slack, M91 and AI
// are never called. Proves the screens and flows; claims nothing about live integrations.
// Usage: npm run test:e2e:slack   (SCREENSHOTS=<dir> to keep screenshots)
/* global document, window */
import { spawn, execFileSync } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-slack-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 4400 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', AI_PROVIDER: 'mock' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER', 'M91_SEND_LINK', 'M91_API_KEY', 'VIASOCKET_EMBED_SECRET', 'VIASOCKET_ORG_ID', 'VIASOCKET_PROJECT_ID']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })

const withDb = (fn) => { const db = new DatabaseSync(join(dataDir, 'teampulse.db')); try { return fn(db) } finally { db.close() } }
const sub = { id: randomUUID(), token: `tpe_${randomUUID()}` }
withDb((db) => {
  const mgr = db.prepare(`SELECT id FROM users WHERE email = 'manager@demo.teampulse'`).get().id
  const m = db.prepare('SELECT org_id, team_id FROM memberships WHERE user_id = ?').get(mgr)
  const ts = new Date().toISOString()
  db.prepare(`INSERT INTO intake_subscriptions (id, org_id, owner_id, team_id, app, trigger_key, version, input_data, target_label, token_hash, status, assign_from_mentions, created_at, updated_at)
              VALUES (?, ?, ?, ?, 'slack', 'New_Message_Posted_in_Channel_Instant', 'v2', '{}', '#teampulse-task-testing', ?, 'ACTIVE', 1, ?, ?)`).run(sub.id, m.org_id, mgr, m.team_id, createHash('sha256').update(sub.token).digest('hex'), ts, ts)
})

const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })

let n = 0
const slack = (text, user = 'U0DANA0004') => fetch(`${base}/api/viasocket/events/${sub.id}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${sub.token}` },
  body: JSON.stringify({ event: { text, user, user_name: 'Dana Director', ts: `${Math.floor(Date.now() / 1000)}.${100000 + ++n}`, channel: 'C0TEST0001', team: 'T0ACME0001' } })
}).then((r) => r.json())

const browser = await chromium.launch()
const problems = []
let step = ''
const ok = (cond, msg) => { if (!cond) throw new Error(`Check failed: ${msg}`) }
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const shot = (page, name) => (shots ? page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }) : null)
async function session(email, { theme = 'light', viewport = { width: 1366, height: 900 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  await ctx.addInitScript((t) => { try { localStorage.setItem('tp-theme', t) } catch { /* private mode */ } }, theme)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${email}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|net::|status of 4\d\d|status of 503|fonts\./.test(m.text())) problems.push(`[${email}] ${step}: console ${m.text()}`) })
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  return page
}
const toast = (page, text) => page.waitForSelector(`#toast:has-text("${text}")`)
const taskId = (title) => withDb((db) => db.prepare('SELECT id FROM tasks WHERE title LIKE ?').get(`${title}%`)?.id)

try {
  // ---- manager: map people (UI), then Slack messages arrive ----
  step = 'manager maps Slack people'
  const m = await session('manager@demo.teampulse')
  await m.goto(`${base}/#/slack-intake`)
  await m.waitForSelector('h1:has-text("Work from Slack")')
  ok(await m.isVisible('text=No tasks from Slack yet'), 'empty state before any message')
  await m.selectOption('#m-u', { label: 'Priya Sharma · Platform' })
  await m.fill('#m-s', 'u0priya001')
  await m.click('#map-form button[type=submit]')
  await toast(m, 'Mapped')
  await m.waitForSelector('#slack-people li:has-text("Priya Sharma"):has-text("Confirmed")')
  const people = await m.evaluate(async () => (await (await fetch('/api/members')).json()))
  const devId = people.find((p) => p.name === 'Dev Patel').userId
  const mapped = await m.evaluate(async (id) => (await fetch('/api/slack-identities', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TeamPulse' }, body: JSON.stringify({ userId: id, slackUserId: 'U0DEV00002' }) })).status, devId)
  ok(mapped === 201, `Dev mapped (${mapped})`)

  step = 'messages arrive'
  const a = await slack('<@U0PRIYA001>, please investigate the payment failure issue and fix it by tomorrow')
  ok(a.status === 'created', `task created (${JSON.stringify(a)})`)
  const chatter = await slack('Anyone up for lunch today?')
  ok(chatter.status === 'ignored', 'chatter ignored')
  const ghost = await slack('<@U0GHOST005> please look into the invoice export')
  ok(ghost.status === 'needs_manager', 'unmapped person goes to a manager')
  const dup = await fetch(`${base}/api/viasocket/events/${sub.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${sub.token}` }, body: JSON.stringify({ event: { text: '<@U0PRIYA001>, please investigate the payment failure issue and fix it by tomorrow', user: 'U0DANA0004', ts: `${Math.floor(Date.now() / 1000)}.100001`, channel: 'C0TEST0001' } }) }).then((r) => r.json())
  ok(dup.status === 'duplicate' || dup.status === 'created', 'second delivery handled')

  step = 'manager dashboard'
  await m.reload()
  await m.waitForSelector('table.task-table')
  const row = m.locator('tr:has-text("Investigate the payment failure issue")')
  ok(await row.isVisible(), 'task row')
  ok(await row.locator('text=Waiting for acceptance').isVisible(), 'row shows waiting for acceptance')
  ok(await row.locator('text=Dana Director').isVisible(), 'requester shown')
  ok(await row.locator('text=tagged Priya Sharma').isVisible(), 'tagged person shown')
  ok(await m.isVisible('#need-manager li:has-text("not mapped to a KONVO person")'), 'needs-a-manager item with the reason')
  ok(await m.isVisible('#slack-people li:has-text("U0GHOST005")'), 'unmapped Slack id listed')
  ok(!(await m.content()).match(/leaderboard|ranking/i), 'no leaderboard or ranking')
  await m.selectOption('#f-acceptance', 'accepted')
  await m.waitForSelector('text=Nothing matches')
  await m.click('a:has-text("Clear filters")')
  await m.waitForSelector('table.task-table')
  ok(await overflow(m) <= 1, `slack intake fits (${await overflow(m)}px)`)
  await shot(m, 'manager-slack-intake')

  // ---- Priya: accept in one click ----
  step = 'priya accepts'
  const p = await session('priya@demo.teampulse')
  await p.waitForSelector('h2:has-text("Waiting for your answer")')
  ok(await p.isVisible('.inbox-item:has-text("Investigate the payment failure issue")'), 'inbox shows the task')
  ok(await p.isVisible('.inbox-item:has-text("Dana Director asked in Slack")'), 'requester shown')
  ok(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/.test(await p.innerText('main')), 'no technical ids shown to the employee')
  await shot(p, 'priya-inbox')
  await p.click('.inbox-item [data-a="accept"]')
  await toast(p, 'Accepted')
  await p.waitForSelector('h2:has-text("Waiting for your answer")', { state: 'detached' })
  const idA = taskId('Investigate')
  await p.goto(`${base}/#/tasks/${idA}`)
  await p.waitForSelector('h2:has-text("Where this came from")')
  ok(await p.isVisible('blockquote:has-text("please investigate the payment failure issue")'), 'Slack source shown')
  ok((await p.innerText('blockquote')).startsWith('@Priya Sharma'), 'the tag is shown as a name, not Slack markup or an id')
  ok(await p.isVisible('h2:has-text("Ownership history")'), 'ownership history')
  ok(await p.isVisible('.badge.status:has-text("Assigned")'), 'status moved to Assigned')

  // ---- Priya transfers to Dev; Dev must accept ----
  step = 'transfer'
  await p.click('button[data-act="transfer"]')
  await p.waitForSelector('#tr-to')
  await p.selectOption('#tr-to', { label: 'Dev Patel' })
  await p.fill('#tr-r', 'Dev knows the payments code best')
  await p.click('#f button[type=submit]')
  await toast(p, 'Offered')
  await p.waitForSelector('.banner:has-text("Transfer pending")')
  ok(await p.isVisible('.banner:has-text("stays the owner")') || await p.isVisible('.banner:has-text("stays Priya")') || await p.isVisible('.banner:has-text("Priya Sharma stays the owner")'), 'owner unchanged until accepted')
  ok(await p.isVisible('.task-actions button[data-act="transfer"]') === false, 'no second transfer while one is pending')
  const d = await session('dev@demo.teampulse')
  await d.waitForSelector('.inbox-item:has-text("offered you this task")')
  await d.click('.inbox-item [data-a="t-accept"]')
  await toast(d, 'Accepted')
  await d.goto(`${base}/#/tasks/${idA}`)
  await d.waitForSelector('h2:has-text("Ownership history")')
  ok(await d.isVisible('.badge:has-text("Handed over")'), 'previous owner recorded as handed over')
  ok(await d.isVisible('li:has-text("Dev Patel"):has-text("Accepted")'), 'new owner accepted')

  // ---- decline path: a message tags Dev; Dev declines with a reason; the manager reassigns ----
  step = 'decline and reassign'
  const b = await slack('<@U0DEV00002> please check &lt;img src=x onerror="window.__xss=1"&gt; on the login page')
  ok(b.status === 'created', 'second task created')
  await d.goto(`${base}/#/dashboard`)
  await d.waitForSelector('.inbox-item:has-text("login page") [data-a="decline"]')
  ok(await d.evaluate(() => window.__xss === undefined), 'message text is escaped, not run')
  ok(await d.isVisible('.inbox-item:has-text("<img src=x")'), 'markup shown as text')
  await d.click('.inbox-item:has-text("login page") [data-a="decline"]')
  await d.waitForSelector('#cf-reason')
  await d.fill('#cf-reason', 'I am on leave this week')
  await d.click('#cf-ok')
  await toast(d, 'Declined')
  await m.reload() // the manager is already on this hash: reload to see the new decline
  await m.waitForSelector('#declined li:has-text("I am on leave this week")')
  await m.selectOption('#declined li select[data-owner]', { label: 'Neha Rao' })
  await m.click('#declined [data-reassign]')
  await toast(m, 'Reassigned')
  const nh = await session('neha@demo.teampulse')
  await nh.waitForSelector('.inbox-item:has-text("login page") [data-a="accept"]')

  // ---- missed deadline: Dev must explain; manager reviews; Dev adds context ----
  step = 'missed deadline'
  withDb((db) => db.prepare('UPDATE tasks SET due_at = ? WHERE id = ?').run(new Date(Date.now() - 2 * 3600000).toISOString(), idA))
  await d.goto(`${base}/#/tasks/${idA}`)
  await d.waitForSelector('.banner:has-text("This task missed its deadline")')
  await d.click('button[data-act="explain"]')
  await d.waitForSelector('#x-c')
  await d.selectOption('#x-c', 'OTHER')
  ok(await d.evaluate(() => document.getElementById('x-t').required), 'Other requires a written explanation')
  await d.fill('#x-t', 'The payments sandbox was down for most of the day.')
  await d.click('#f button[type=submit]')
  await toast(d, 'Thank you')
  await d.waitForSelector('#deadline-card:has-text("The payments sandbox was down")')
  ok(!(await d.isVisible('.banner:has-text("This task missed its deadline")')), 'prompt gone once explained')
  await m.goto(`${base}/#/tasks/${idA}`)
  await m.waitForSelector('#deadline-card [data-act="exp-review"]')
  await m.click('[data-act="exp-review"]')
  await m.waitForSelector('#v-s')
  await m.selectOption('#v-s', 'NEEDS_CLARIFICATION')
  ok(await m.evaluate(() => document.getElementById('v-c').required), 'clarification needs a comment')
  await m.fill('#v-c', 'Was a workaround possible?')
  await m.click('#f button[type=submit]')
  await toast(m, 'Review saved')
  await d.reload()
  await d.waitForSelector('#deadline-card .entry.review:has-text("Needs clarification")')
  await d.click('[data-act="exp-context"]')
  await d.fill('#c-b', 'No: the sandbox is the only environment with the payments stub.')
  await d.click('#f button[type=submit]')
  await toast(d, 'Added')
  await d.waitForSelector('#deadline-card .entry:has-text("only environment")')
  ok(await d.isVisible('#deadline-card:has-text("The payments sandbox was down")'), 'the original explanation is unchanged')
  await shot(d, 'dev-deadline-explanation')
  await m.goto(`${base}/#/slack-intake`)
  await m.waitForSelector('#explanations tr:has-text("Needs clarification")')

  // ---- who may see what ---
  step = 'permissions'
  await p.goto(`${base}/#/slack-intake`)
  await p.waitForSelector('h1:has-text("Work from Slack is for managers")')
  ok(!(await p.isVisible('#nav a[href="#/slack-intake"]')), 'no nav entry for employees')
  ok(await m.isVisible('#nav a[href="#/slack-intake"]'), 'nav entry for managers')

  // ---- phone layout and dark theme ----
  step = 'phone and dark'
  const pm = await session('manager@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await pm.goto(`${base}/#/slack-intake`); await pm.waitForSelector('table.task-table')
  ok(await overflow(pm) <= 1, `phone: slack intake fits (${await overflow(pm)}px)`)
  await pm.goto(`${base}/#/tasks/${idA}`); await pm.waitForSelector('#deadline-card')
  ok(await overflow(pm) <= 1, `phone: task page fits (${await overflow(pm)}px)`)
  const pd = await session('dev@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await pd.goto(`${base}/#/my-tasks`); await pd.waitForSelector('h1:has-text("My tasks")')
  ok(await overflow(pd) <= 1, `phone: my tasks fits (${await overflow(pd)}px)`)
  const dark = await session('manager@demo.teampulse', { theme: 'dark' })
  await dark.goto(`${base}/#/slack-intake`); await dark.waitForSelector('table.task-table')
  await shot(dark, 'manager-slack-intake-dark')

  ok(problems.length === 0, `no console or page errors: ${problems.join(' | ')}`)
  console.log('Slack workflow journeys passed.')
} catch (error) {
  console.error(`FAILED at "${step}": ${error.message}`)
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
