// Browser checks for the Work Intelligence Team tab (Playwright, Chromium): the questions it answers, in order; the four metrics and their filter;
// who-is-doing-what with links to the contribution profile; the assessment table (only what was assessed); Person and Task tabs; the employee's limited view;
// desktop and phone layouts. Runs on a disposable DATA_DIR with demo data and the simulated analyser (never ./data).
// Usage: npm run test:e2e:intelligence   (SCREENSHOTS=<dir> keeps screenshots)
/* global document, window */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-wi-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 4200 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', CRON_SECRET: 'e2e-secret', AI_PROVIDER: 'mock' }
delete env.GOOGLE_CLIENT_ID
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
const base = `http://127.0.0.1:${port}`

const browser = await chromium.launch()
const problems = []
let step = ''
const ok = (cond, msg) => { if (!cond) throw new Error(`Check failed: ${msg}`) }
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
const shot = async (page, name, full = true) => { if (shots) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(shots, `${name}.png`), fullPage: full }) } }
async function session(email, { viewport = { width: 1440, height: 900 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${email}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|ERR_TUNNEL|ERR_NAME|net::|status of 4\d\d|status of 5\d\d|fonts\./.test(m.text())) problems.push(`[${email}] ${step}: console ${m.text()}`) })
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  return { page, ctx }
}
const api = async (ctx, path, method = 'GET', body) => { const r = await ctx.request.fetch(base + path, { method, headers: { 'X-Requested-With': 'TeamPulse', ...(body ? { 'Content-Type': 'application/json' } : {}) }, data: body ? JSON.stringify(body) : undefined }); return { status: r.status(), body: await r.json().catch(() => null) } }
const settle = (page) => page.waitForLoadState('networkidle').then(() => page.waitForTimeout(200))

try {
  const { page: m, ctx: mctx } = await session('manager@demo.teampulse')
  const { page: e, ctx: ectx } = await session('priya@demo.teampulse')
  const priyaId = (await api(mctx, '/api/assignable')).body.find((p) => p.name === 'Priya Sharma').userId

  step = 'team tab without analysed work'
  await m.goto(`${base}/#/analytics`); await m.waitForSelector('[data-testid=analytics-summary]'); await m.waitForSelector('[data-testid=performance-empty]')
  ok((await m.locator('h1').textContent()) === 'Work Intelligence', 'title')
  ok((await m.locator('.page-head p').textContent()).includes('what your team is doing, what they contribute and what outcomes they create'), 'description')
  const heads = await m.locator('.wi-card h2').allTextContents()
  ok(heads.join('|') === 'What needs my attention?|Who is doing what?|How is the work being performed?|What outcomes have been achieved?|Work trend', `sections in order: ${heads.join('|')}`)
  const labels = await m.locator('.wi-kpi .label').allTextContents()
  ok(labels.join('|') === 'Active work|Completed work|Blocked work|Work requiring review', `four metrics: ${labels.join('|')}`)
  ok(!(await m.locator('[data-testid=health-chart], [data-testid=people-chart]').count()), 'the duplicate health donut and stacked bars are gone')
  ok(await m.locator('[data-testid=analytics-notes]').evaluate((d) => d.tagName === 'DETAILS' && !d.open), 'fairness notes are available but collapsed')
  ok((await m.locator('[data-testid=analytics-notes]').textContent()).includes('never a performance score'), 'fairness note text present')
  // who is doing what: alphabetical, current work, links, no ranking
  const names = await m.locator('[data-testid=contribution-table] tbody tr td:first-child a').allTextContents()
  ok(names.length >= 3 && JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), `people are alphabetical: ${names}`)
  ok((await m.locator('[data-testid=contribution-table] tbody').textContent()).includes('Cut checkout API p95 latency below 200ms'), 'current work is named')
  ok(!(await m.locator('main').textContent()).match(/leaderboard|top performer|score:|rank/i), 'no ranking or score language')
  ok((await m.locator('[data-testid=performance-empty]').textContent()).includes('nothing is estimated in advance'), 'honest empty state for assessments')
  await shot(m, 'wi-desktop-team-empty')

  step = 'metric filter and employee link'
  const active = Number(await m.locator('[data-testid=stat-open] .value').textContent())
  await m.click('[data-testid=kpi-blocked]'); await settle(m)
  ok((await m.locator('[data-testid=filter-chip]').textContent()).includes('Blocked'), 'the metric filters the task table')
  ok(Number(await m.locator('[data-testid=stat-open] .value').textContent()) === active, 'metrics keep describing the whole team')
  await m.click('[data-clear]')
  await m.click('[data-testid=kpi-review]'); await settle(m)
  ok((await m.locator('[data-testid=analytics-tasks] tbody tr').count()) >= 1, 'work requiring review lists the submitted tasks')
  await m.click('[data-clear]')
  await m.locator('[data-testid=contribution-table] a[data-person]', { hasText: 'Priya Sharma' }).click()
  await m.waitForSelector('[data-testid=person-measure]')
  ok(await m.locator('[data-testid=tab-person][aria-selected=true]').count() === 1, 'a name opens the Person view')
  await m.locator('[data-testid=tab-task]').click(); await m.waitForSelector('#af-task'); await m.goBack()

  step = 'analysed work appears in the assessment table'
  const rich = (await api(mctx, '/api/tasks', 'POST', { title: 'Fix the checkout reservation race', description: 'Checkout fails for some users with no clear error. Needs investigation across multiple services (cart, payments, inventory).', assigneeId: priyaId, priority: 'HIGH' })).body.task
  await api(ectx, `/api/tasks/${rich.id}/status`, 'POST', { status: 'IN_PROGRESS' })
  await api(ectx, `/api/evidence/task/${rich.id}/links`, 'POST', { url: 'https://github.com/acme/shop/pull/481', label: 'PR 481: idempotent reservation token' })
  await api(ectx, `/api/tasks/${rich.id}/submit`, 'POST', { summary: 'Investigated logs across cart, payments and inventory and found the root cause: a race condition between reservation and payment capture. Added an idempotent reservation token and a regression test.', outcome: 'Checkout failures stopped in staging.' })
  for (let i = 0; i < 40; i++) { if ((await api(mctx, '/api/contribution/team')).body.people.some((p) => p.analysed > 0)) break; await m.waitForTimeout(500) }
  await m.goto(`${base}/#/analytics`); await m.waitForSelector('[data-testid=performance-table]')
  const row = m.locator('[data-testid=performance-table] tbody tr', { hasText: 'Priya Sharma' })
  const rowText = await row.textContent()
  ok(rowText.includes('L4') && rowText.includes('Includes simulated'), 'complexity shown, simulated analysis labelled')
  ok(rowText.includes('Not enough evidence'), 'dimensions without evidence say so instead of showing a value')
  ok(!(await row.textContent()).match(/\bscore\b/i), 'no score')
  ok(Number(await m.locator('[data-testid=stat-review] .value').textContent()) >= 1, 'the submitted task counts as work requiring review')
  await shot(m, 'wi-desktop-team')
  await row.locator('a', { hasText: 'Why these levels' }).click(); await m.waitForSelector('[data-testid=person-measure]')

  step = 'person and task views still work'
  await m.goto(`${base}/#/analytics?tab=task&taskId=${rich.id}`); await m.waitForSelector('[data-testid=task-original]')
  await m.goto(`${base}/#/analytics?tab=person&userId=${priyaId}`); await m.waitForSelector('[data-testid=person-measure]')
  ok(await m.locator('[data-testid=analytics-tasks]').count() === 1, 'the person view keeps its task table')
  await m.locator('a[href^="#/contribution/"]').first().waitFor({ state: 'attached' }).catch(() => {})

  step = 'employee view'
  await e.goto(`${base}/#/analytics`); await e.waitForSelector('[data-testid=analytics-summary]')
  ok(await e.locator('[data-testid=tab-team]').count() === 0, 'employees have no team tab')
  ok((await api(ectx, '/api/analytics/team')).status === 403 && (await api(ectx, '/api/contribution/team')).status === 403, 'team data is refused for employees by the server')
  ok((await e.locator('.wi-card h2').allTextContents()).every((t) => !/Who is doing what/.test(t)), 'no team table for employees')

  step = 'phone layout'
  const { page: p } = await session('manager@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await p.goto(`${base}/#/analytics`); await p.waitForSelector('[data-testid=performance-table]'); await settle(p)
  ok(await overflow(p) <= 1, `phone: no page overflow (${await overflow(p)}px)`)
  ok(await p.locator('.wi-kpis.four .wi-kpi').count() === 4, 'phone: four metrics')
  await shot(p, 'wi-mobile-team')
  await p.goto(`${base}/#/analytics?tab=person&userId=${priyaId}`); await p.waitForSelector('[data-testid=person-measure]'); await settle(p)
  ok(await overflow(p) <= 1, 'phone: person view fits')

  if (problems.length) throw new Error(`Browser problems:\n${problems.join('\n')}`)
  console.log('E2E work intelligence passed (team tab order, metrics, filters, who-is-doing-what, assessments, person/task tabs, employee limits, phone).')
} catch (err) {
  console.error(`E2E work intelligence FAILED at step "${step}":`, err.message)
  if (problems.length) console.error(problems.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
