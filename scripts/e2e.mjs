// End-to-end journeys in a real browser (Playwright, Chromium). Starts the app on a temporary DATA_DIR with
// DEV_LOGIN=1 and demo data, then drives manager and employee flows. Fails on any page or console error.
// Usage: npm run test:e2e   (SCREENSHOTS=<dir> to keep screenshots)
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 3900 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', CRON_SECRET: 'e2e-secret' }
delete env.GOOGLE_CLIENT_ID
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'inherit' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch()
const problems = []
let step = ''
async function session(email, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${email}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|ERR_TUNNEL|ERR_NAME|net::/.test(m.text())) problems.push(`[${email}] ${step}: console ${m.text()}`) })
  await page.goto(base)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  return { page, ctx }
}
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }) }
const ok = (cond, msg) => { if (!cond) throw new Error(`Check failed: ${msg}`) }

try {
  // ---- Manager ----
  step = 'manager dashboard'
  const { page: m } = await session('manager@demo.teampulse')
  await m.waitForSelector('text=Attention required')
  ok(await m.isVisible('text=Team workload'), 'workload card')
  ok(await m.isVisible('text=Team impact'), 'impact card')
  ok(await m.locator('.stat').count() >= 10, 'stat cards')
  await shot(m, '01-manager-dashboard')

  step = 'team tasks + filters'
  await m.click('nav >> text=Team Tasks')
  await m.waitForSelector('h1:has-text("Team tasks")')
  await m.waitForSelector('a:has-text("Migrate billing DB")')
  await m.selectOption('#f-condition', 'overdue')
  await m.waitForFunction(() => location.hash.includes('condition=overdue'))
  await m.waitForSelector('text=Write on-call runbook')
  ok((await m.locator('tbody tr').count()) === 1, 'overdue filter shows exactly one')
  await shot(m, '02-team-tasks-overdue')

  step = 'create + assign task'
  await m.click('#new-task')
  await m.fill('#t-title', 'E2E: add rate limiting to login')
  await m.fill('#t-out', 'Brute force attempts blocked')
  await m.selectOption('#t-prio', 'HIGH')
  await m.selectOption('#t-assignee', { label: 'Dev Patel' })
  await m.click('#task-form button[type=submit]')
  await m.waitForSelector('h1:has-text("E2E: add rate limiting")')
  ok(await m.isVisible('text=Dev Patel'), 'assignee shown')
  const newTaskUrl = m.url()

  step = 'review submission'
  await m.click('nav >> text=Team Tasks')
  await m.click('text=Automate weekly invoice reconciliation')
  await m.click('[data-act=review]')
  await m.fill('#r-c', 'Great work — ship it')
  await m.click('button[value=APPROVED]')
  await m.waitForSelector('.badge:has-text("Completed")')
  ok(await m.isVisible('text=Completion is not the same as impact'), 'impact separate from completion')
  await shot(m, '03-task-detail-completed')

  step = 'approve request'
  await m.click('nav >> text=Task Requests')
  await m.waitForSelector('text=Add canary deploys')
  await m.click('[data-approve]')
  await m.selectOption('#a-a', { label: 'Dev Patel' })
  await m.click('#f button[type=submit]')
  await m.waitForSelector('h1:has-text("Add canary deploys")')

  step = 'verify impact'
  await m.click('nav >> text=Performance')
  await m.waitForSelector('text=Contributions by person')
  await m.click('text=Prevented a disk-full outage')
  await m.click('#verify')
  await m.click('#cf-ok')
  await m.waitForSelector('.badge:has-text("Verified")')
  await shot(m, '04-impact-detail')

  step = 'permissions'
  await m.click('nav >> text=Settings')
  await m.click('text=Employee permissions')
  await m.waitForSelector('th:has-text("Can self-assign")')
  await m.check('[data-perm=can_self_assign][aria-label*="Dev Patel"]')
  await m.waitForSelector('text=changed Dev Patel')
  await shot(m, '05-permissions')

  step = 'reports'
  await m.click('nav >> text=Reports')
  await m.waitForSelector('h2:has-text("Weekly team summary")')
  await m.selectOption('select[name=type]', 'workload')
  await m.waitForSelector('th:has-text("Active")')
  const csv = await m.request.get(`${base}/api/reports/workload.csv`)
  ok(csv.status() === 200 && (await csv.text()).startsWith('person,'), 'CSV export')
  await shot(m, '06-reports')

  step = 'automation center'
  await m.click('nav >> text=Automation Center')
  await m.waitForSelector('text=ViaSocket is not configured')
  ok(await m.isVisible('text=Slack') && await m.isVisible('text=GitHub'), 'curated apps listed')
  await m.click('text=Ready-made automations')
  await m.waitForSelector('text=New Task Notification')
  await m.click('[data-intake]')
  await m.waitForSelector('#tok')
  const token = await m.inputValue('#tok')
  ok(token.startsWith('tpi_'), 'intake token issued')
  await m.click('button:has-text("Done")')
  await shot(m, '07-automations')
  const inbound = await fetch(`${base}/api/inbound/task-requests`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'E2E external: export broken', requester: 'customer@example.com', externalRef: 'e2e-1' }) })
  ok(inbound.status === 201, 'external request accepted')
  await m.click('nav >> text=Task Requests')
  await m.waitForSelector('text=E2E external: export broken')

  step = 'alerts settings'
  await m.goto(`${base}/#/alerts`)
  await m.waitForSelector('text=Notifications')
  const cron = await fetch(`${base}/tasks/alerts`, { headers: { Authorization: 'Bearer e2e-secret' } })
  ok(cron.status === 200, 'cron route works')

  // ---- Employee ----
  step = 'employee dashboard'
  const { page: e } = await session('dev@demo.teampulse')
  await e.waitForSelector('text=Daily reflection')
  ok(!(await e.isVisible('nav >> text=Team Tasks')), 'employee has no Team Tasks nav')
  ok(!(await e.isVisible('nav >> text=Reports')), 'employee has no Reports nav')
  await e.fill('#r-contribution', 'Unblocked the billing migration plan')
  await e.click('#reflection button[type=submit]')
  await e.waitForSelector('#refl-saved:has-text("Saved")')
  await shot(e, '08-employee-dashboard')

  step = 'employee works a task'
  await e.goto(newTaskUrl)
  await e.waitForSelector('[data-act=start]')
  await e.click('[data-act=start]')
  await e.waitForSelector('.badge:has-text("In progress")')
  await e.click('[data-act=block] >> nth=0')
  await e.fill('#b-d', 'Need security review slot')
  await e.click('#f button[type=submit]')
  await e.waitForSelector('text=Blocked for')
  await e.click('[data-resolve]')
  await e.fill('#cf-reason', 'Review booked for tomorrow')
  await e.click('#cf-ok')
  await e.waitForSelector('[data-act=submit]')
  await e.click('[data-act=submit]')
  await e.fill('#s-s', 'Added per-IP limiter')
  await e.fill('#s-o', 'Login attempts capped at 30/min/IP')
  await e.click('#f button[type=submit]')
  await e.waitForSelector('text=It is not complete until a manager approves it')

  step = 'employee suggests a task'
  await e.click('nav >> text=Task Requests')
  await e.click('#suggest')
  await e.fill('#r-t', 'E2E suggestion: dashboards for queue depth')
  await e.fill('#r-r', 'We found the disk issue late')
  await e.click('#f button[type=submit]')
  await e.waitForSelector('text=E2E suggestion: dashboards for queue depth')

  step = 'employee records impact'
  await e.click('nav >> text=Performance')
  await e.click('#new-impact')
  await e.fill('#i-t', 'E2E: rate limiter blocked credential stuffing')
  await e.selectOption('#i-c', 'RELIABILITY')
  await e.fill('#i-p', 'No limits on login')
  await e.fill('#i-w', 'Per-IP limiter')
  await e.fill('#i-r', 'Attack traffic dropped to zero')
  await e.check('input[name=valueType][value=ESTIMATED]')
  await e.fill('#i-v', '200')
  await e.fill('#i-u', 'blocked attempts/day')
  await e.click('#imp button[type=submit]')
  await e.waitForSelector('text=Estimate: ≈ 200 blocked attempts/day')

  step = 'employee cannot reach manager pages'
  const forbidden = await e.request.get(`${base}/api/reports/workload`)
  ok(forbidden.status() === 403, 'reports API forbidden for employee')

  // ---- Responsive ----
  step = 'mobile layout'
  const { page: p } = await session('manager@demo.teampulse', { width: 390, height: 844 })
  await p.waitForSelector('text=Attention required')
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(overflow <= 1, `no horizontal page scroll on phone (overflow ${overflow}px)`)
  ok(await p.isVisible('#nav-toggle'), 'menu button on phone')
  await shot(p, '09-mobile-dashboard')
  await p.click('#nav-toggle')
  await p.click('nav >> text=Team Tasks')
  await p.waitForSelector('h1:has-text("Team tasks")')
  const overflow2 = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(overflow2 <= 1, `team tasks fits the phone width (overflow ${overflow2}px)`)
  await shot(p, '10-mobile-tasks')

  step = 'logout'
  await m.click('#logout')
  await m.waitForSelector('text=Local development sign-in')
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
} finally {
  await browser.close()
  server.kill()
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log('E2E journeys passed.')
