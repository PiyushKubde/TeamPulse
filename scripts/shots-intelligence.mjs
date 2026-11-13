// Work Intelligence dashboard in a real browser: screenshots (desktop and phone, light and dark; team, person, task, empty and error
// states) plus the checks that matter: no console or page errors, no horizontal overflow, chart totals that reconcile with the KPIs,
// clicks on KPI cards and chart segments that filter the task table, a click on a person that opens their profile, and an employee who
// never sees the team view. Starts the app on a temporary DATA_DIR with DEV_LOGIN=1 and the demo seed; ./data is never touched.
// Usage: node --disable-warning=ExperimentalWarning scripts/shots-intelligence.mjs        (SHOTS_DIR=<dir> to choose where the PNGs go)
/* global document, location, window */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'konvo-e2e-wi-'))
if (dataDir.replace(/\\/g, '/') === join(process.cwd(), 'data').replace(/\\/g, '/')) throw new Error('refusing to use the real data directory')
const shotsDir = process.env.SHOTS_DIR || join(tmpdir(), 'konvo-shots')
mkdirSync(shotsDir, { recursive: true })
const port = 4900 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER', 'M91_SEND_LINK', 'M91_API_KEY', 'VIASOCKET_EMBED_SECRET', 'LOCAL_SCHEDULER']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
const base = `http://127.0.0.1:${port}`
const H = 3600000
const D = 24 * H
const iso = (ms) => new Date(ms).toISOString()
const browser = await chromium.launch()
const problems = []
const taken = []
let step = ''
const check = (ok, msg) => { if (!ok) problems.push(`${step}: ${msg}`) }
const num = (t) => Number(String(t).replace(/[^0-9]/g, ''))

async function session(email, { theme = 'light', viewport = { width: 1440, height: 900 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  await ctx.addInitScript((t) => { try { localStorage.setItem('tp-theme', t) } catch { /* private mode */ } }, theme)
  const page = await ctx.newPage()
  const tag = `${email.split('@')[0]} ${theme} ${viewport.width}`
  page.on('pageerror', (e) => problems.push(`[${tag}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|net::|status of 4\d\d|status of 503|fonts\./.test(m.text())) problems.push(`[${tag}] ${step}: console ${m.text()}`) })
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  page.__ctx = ctx
  return page
}
const call = (page, method, path, body) => page.evaluate(async ([m, p, b]) => {
  const r = await fetch(p, { method: m, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'TeamPulse' }, body: b === undefined ? undefined : JSON.stringify(b) })
  const t = await r.text()
  return { status: r.status, body: t ? JSON.parse(t) : null }
}, [method, path, body])
const go = (page, hash) => page.evaluate((h) => { location.hash = h }, hash)
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)
async function shot(page, name) {
  const file = join(shotsDir, `${name}.png`)
  await page.screenshot({ path: file, fullPage: true })
  taken.push(file)
}
// Opens a page from a neutral one first, so the router really renders it (a same-hash navigation would not).
async function open(page, hash, waitFor) {
  await go(page, '#/dashboard'); await page.waitForSelector('main')
  await go(page, hash)
  await page.waitForSelector(waitFor)
  await page.waitForFunction(() => document.querySelector('#an-body')?.getAttribute('aria-busy') !== 'true')
}

try {
  // ---------- data: the states a dashboard has to show ----------
  step = 'seeding'
  const manager = await session('manager@demo.teampulse')
  const members = (await call(manager, 'GET', '/api/members')).body
  const id = (name) => members.find((m) => m.name === name).userId
  const [priya, dev, neha] = [id('Priya Sharma'), id('Dev Patel'), id('Neha Rao')]
  const mk = async (title, assigneeId, extra = {}) => (await call(manager, 'POST', '/api/tasks', { title, assigneeId, priority: 'MEDIUM', ...extra })).body.task.id
  const t = {
    overdue: await mk('Fix the invoice export', priya, { priority: 'HIGH', dueAt: iso(Date.now() - 3 * D), complexityExpectation: 'L3', workType: 'Bug' }),
    blocked: await mk('Migrate the reporting database', priya, { dueAt: iso(Date.now() + 8 * D), complexityExpectation: 'L4' }),
    inProgress: await mk('Write the onboarding guide', priya, { priority: 'LOW', dueAt: iso(Date.now() + 12 * D) }),
    done: await mk('Ship the billing webhook', dev, { priority: 'HIGH', dueAt: iso(Date.now() + 3 * D), complexityExpectation: 'L2' }),
    atRisk: await mk('Prepare the quarterly audit pack', dev, { dueAt: iso(Date.now() + 6 * H) }),
    onTrack: await mk('Refactor the notification queue', dev, { dueAt: iso(Date.now() + 14 * D) }),
    review: await mk('Document the retry policy', dev, { dueAt: iso(Date.now() + 7 * D) }),
    noDeadline: await mk('Look into slow search', neha, { priority: undefined }),
    done2: await mk('Update the onboarding checklist', neha, { dueAt: iso(Date.now() + 5 * D) }),
    claimed: await mk('Reduce page load time', neha, { dueAt: iso(Date.now() + 9 * D) }),
    unassigned: await mk('Pick up the vendor questionnaire', null, { dueAt: iso(Date.now() + 20 * D) })
  }
  // A change request and an expectation change, so the task view has a history.
  await call(manager, 'PATCH', `/api/tasks/${t.overdue}`, { priority: 'CRITICAL', reason: 'The customer escalated' })
  const priyaPage = await session('priya@demo.teampulse')
  await call(priyaPage, 'POST', `/api/tasks/${t.overdue}/change-requests`, { kind: 'DEADLINE', proposed: { dueAt: iso(Date.now() + 3 * D) }, reason: 'Waiting for the finance team’s test data' })
  const db = new DatabaseSync(join(dataDir, 'teampulse.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  const org = db.prepare('SELECT org_id FROM tasks WHERE id = ?').get(t.done).org_id
  const set = (task, sql, ...a) => db.prepare(`UPDATE tasks SET ${sql} WHERE id = ?`).run(...a, task)
  set(t.blocked, "status = 'BLOCKED'"); set(t.inProgress, "status = 'IN_PROGRESS', progress = 35"); set(t.review, "status = 'SUBMITTED_FOR_REVIEW', submitted_at = ?", iso(Date.now()))
  set(t.done, "status = 'COMPLETED', completed_at = ?, progress = 100", iso(Date.now() - 1 * D)); set(t.done2, "status = 'COMPLETED', completed_at = ?, progress = 100", iso(Date.now() - 2 * D))
  set(t.inProgress, 'last_meaningful_at = ?', iso(Date.now() - 5 * H)); set(t.done, 'last_meaningful_at = ?', iso(Date.now() - 1 * D)); set(t.overdue, 'last_meaningful_at = ?', iso(Date.now() - 6 * D))
  db.prepare(`INSERT INTO blockers (id, org_id, task_id, reported_by, description, reported_at) VALUES (?, ?, ?, ?, 'Waiting for DBA access', ?)`).run(randomUUID(), org, t.blocked, priya, iso(Date.now() - 2 * D))
  const impact = (task, user, title, key, status) => db.prepare(`INSERT INTO impact_records (id, org_id, user_id, task_id, title, category, previous_state, work_performed, result, value_type, measurable_value, measurement_unit, shared_outcome_key, verification_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'TIME_SAVED', 'manual', 'automated', 'faster', 'MEASURED', 5, 'hours', ?, ?, ?, ?)`).run(randomUUID(), org, user, task, title, key, status, iso(Date.now()), iso(Date.now()))
  impact(t.done, dev, 'Billing webhook removes manual reconciliation', 'billing-2026', 'VERIFIED'); impact(t.done2, neha, 'Billing webhook removes manual reconciliation', 'billing-2026', 'VERIFIED')
  impact(t.claimed, neha, 'Search is noticeably faster', null, 'PENDING')
  db.close()

  // ---------- the team view: all the checks, desktop and light first ----------
  step = 'team view (desktop, light)'
  await open(manager, '#/analytics', '[data-testid=analytics-summary]')
  for (const tid of ['kpi-tasks', 'people-chart', 'contribution-table', 'trend-chart', 'health-chart', 'attention-list', 'outcomes-section', 'task-table', 'analytics-tasks']) check(await manager.isVisible(`[data-testid=${tid}]`), `${tid} is not shown`)
  check((await manager.textContent('[data-testid=analytics-notes]')).includes('never a performance score'), 'the fairness notes are missing')
  const text = await manager.textContent('[data-testid=analytics-body]')
  check(!/leaderboard|top performer|ranking:|score:/i.test(text), 'a ranking or score is shown')
  check(/Task volume is not a performance score/.test(text), 'the volume caveat is missing')
  const total = num(await manager.textContent('[data-testid=stat-tasks] .value'))
  const activeCount = num(await manager.textContent('[data-testid=stat-open] .value'))
  const sums = await manager.evaluate(() => ({
    people: [...document.querySelectorAll('[data-testid=people-chart] .wi-person .wi-total')].reduce((a, e) => a + Number(e.textContent.replace(/[^0-9]/g, '')), 0),
    health: [...document.querySelectorAll('.wi-hbtn b')].reduce((a, e) => a + Number(e.textContent.replace(/[^0-9]/g, '')), 0),
    names: [...document.querySelectorAll('[data-testid=people-chart] .wi-name')].map((e) => e.textContent.trim())
  }))
  check(sums.people === total, `people chart totals (${sums.people}) do not match the KPI total (${total})`)
  check(sums.health === activeCount, `health buckets (${sums.health}) do not match the active KPI (${activeCount})`)
  check(JSON.stringify(sums.names.filter((n) => n !== 'Unassigned')) === JSON.stringify([...sums.names.filter((n) => n !== 'Unassigned')].sort((a, b) => a.localeCompare(b))), 'people are not alphabetical')
  check(sums.names.includes('Unassigned'), 'unassigned work is not shown')
  check(await manager.locator('[data-testid=outcomes-section] li').count() === 2, 'shared outcome is not counted once (expected 1 verified + 1 claimed)')
  check(num(await manager.textContent('[data-testid=outcomes-section] .wi-counts div:first-child .value')) === 1, 'verified outcomes should be 1 (shared, counted once)')
  check(await manager.locator('[data-testid=attention-list] li').count() >= 3, 'needs-attention list is too short')
  check(await overflow(manager) <= 1, `team view overflows (${await overflow(manager)}px)`)
  await shot(manager, 'team-desktop-light')

  step = 'KPI and chart clicks filter the task table'
  await manager.click('[data-testid=kpi-blocked]')
  await manager.waitForSelector('[data-testid=filter-chip]')
  check((await manager.textContent('[data-testid=filter-chip]')).includes('Blocked'), 'the filter chip does not name the filter')
  check(await manager.locator('[data-testid=analytics-tasks] tbody tr').count() === num(await manager.textContent('[data-testid=stat-blocked] .value')), 'the blocked KPI and the filtered table disagree')
  await manager.click('[data-testid=filter-chip] [data-clear]')
  await manager.waitForFunction(() => !document.querySelector('[data-testid=filter-chip]'))
  await manager.click('[data-testid=kpi-overdue]')
  await manager.waitForSelector('[data-testid=filter-chip]')
  check(await manager.locator('[data-testid=analytics-tasks] tbody tr').count() === num(await manager.textContent('[data-testid=stat-overdue] .value')), 'the overdue KPI and the filtered table disagree')
  await manager.click('[data-testid=filter-chip] [data-clear]')
  const seg = manager.locator('.wi-bar [data-group=completed]').first()
  const segN = num(await seg.textContent())
  await seg.click()
  await manager.waitForSelector('[data-testid=filter-chip]')
  check(await manager.locator('[data-testid=analytics-tasks] tbody tr').count() === segN, 'a chart segment and the filtered table disagree')
  await manager.click('[data-testid=filter-chip] [data-clear]')
  await manager.click('[data-health=AT_RISK]')
  await manager.waitForSelector('[data-testid=filter-chip]')
  check(await manager.locator('[data-testid=analytics-tasks] tbody tr').count() >= 1, 'the at-risk health filter shows no tasks')
  await manager.click('[data-testid=filter-chip] [data-clear]')

  step = 'sorting, paging and the filter panel'
  await manager.click('[data-sort=title]')
  const first = (await manager.locator('[data-testid=analytics-tasks] tbody tr td:first-child a').first().textContent()).trim()
  check(first.localeCompare((await manager.locator('[data-testid=analytics-tasks] tbody tr td:first-child a').last().textContent()).trim()) <= 0, 'sorting by task did not order the rows')
  await manager.click('[data-testid=filters-toggle]')
  await manager.selectOption('[data-testid=af-priority]', 'UNRESOLVED')
  await manager.click('[data-testid=af-apply]')
  await manager.waitForFunction(() => location.hash.includes('priority=UNRESOLVED'))
  await manager.waitForSelector('[data-testid=analytics-summary]')
  check(num(await manager.textContent('[data-testid=stat-tasks] .value')) >= 1, 'the not-set priority filter shows nothing')
  await manager.click('[data-testid=filters-reset]')

  step = 'clicking a person opens their profile'
  await open(manager, '#/analytics', '[data-testid=people-chart]')
  await manager.click('[data-testid=people-chart] a[data-person] >> nth=0')
  await manager.waitForSelector('[data-testid=person-measure]')
  check((await manager.evaluate(() => location.hash)).includes('tab=person'), 'the profile did not open as the person tab')

  step = 'team view (empty and error states)'
  await open(manager, '#/analytics?tab=team&priority=LOW&workType=NothingLikeThis', '[data-testid=analytics-empty]')
  check(await overflow(manager) <= 1, 'empty state overflows')
  await shot(manager, 'team-empty-desktop-light')
  await go(manager, '#/dashboard'); await manager.waitForSelector('main')
  await go(manager, `#/analytics?tab=person&userId=${randomUUID()}`)
  await manager.waitForSelector('#wi-retry')
  check(await overflow(manager) <= 1, 'error state overflows')
  await shot(manager, 'team-error-desktop-light')

  step = 'person view (desktop, light)'
  await open(manager, `#/analytics?tab=person&userId=${priya}`, '[data-testid=person-measure]')
  await manager.waitForSelector('[data-testid=analytics-summary]')
  check((await manager.textContent('[data-testid=analytics-body]')).includes('Priya'), 'the person view does not name the person')
  check(await overflow(manager) <= 1, 'person view overflows')
  await shot(manager, 'person-desktop-light')

  step = 'task view (desktop, light)'
  await open(manager, `#/analytics?tab=task&taskId=${t.overdue}`, '[data-testid=task-original]')
  check((await manager.textContent('[data-testid=task-original]')).includes('Medium') || (await manager.textContent('[data-testid=task-original]')).includes('High'), 'the original priority is not shown')
  check((await manager.textContent('[data-testid=task-current]')).includes('Critical'), 'the current priority is not shown')
  check(await manager.isVisible('[data-testid=task-history]'), 'the change history is missing')
  check(await overflow(manager) <= 1, 'task view overflows')
  await shot(manager, 'task-desktop-light')

  // ---------- dark theme, then the phone, for every view ----------
  for (const [theme, viewport, mobile, label] of [['dark', { width: 1440, height: 900 }, false, 'desktop-dark'], ['light', { width: 390, height: 844 }, true, 'mobile-light'], ['dark', { width: 390, height: 844 }, true, 'mobile-dark']]) {
    step = `views (${label})`
    const m = await session('manager@demo.teampulse', { theme, viewport, mobile })
    await open(m, '#/analytics', '[data-testid=analytics-summary]')
    check(await m.evaluate(() => document.documentElement.dataset.theme) === theme, `theme is not ${theme}`)
    check(await overflow(m) <= 1, `team view overflows on ${label} (${await overflow(m)}px)`)
    await shot(m, `team-${label}`)
    await open(m, `#/analytics?tab=person&userId=${priya}`, '[data-testid=person-measure]')
    check(await overflow(m) <= 1, `person view overflows on ${label}`)
    await shot(m, `person-${label}`)
    await open(m, `#/analytics?tab=task&taskId=${t.overdue}`, '[data-testid=task-original]')
    check(await overflow(m) <= 1, `task view overflows on ${label}`)
    await shot(m, `task-${label}`)
    if (mobile && theme === 'light') {
      await open(m, '#/analytics?tab=team&priority=LOW&workType=NothingLikeThis', '[data-testid=analytics-empty]')
      check(await overflow(m) <= 1, 'empty state overflows on a phone')
      await shot(m, 'team-empty-mobile-light')
    }
    await m.__ctx.close()
  }

  // ---------- roles: an employee sees only their own profile ----------
  step = 'employee access'
  await go(priyaPage, '#/analytics')
  await priyaPage.waitForSelector('[data-testid=analytics-summary]')
  check(await priyaPage.locator('[data-testid=tab-team]').count() === 0, 'an employee sees the team tab')
  check((await priyaPage.textContent('[data-testid=analytics-body]')).includes('Priya'), 'an employee does not see their own profile')
  check((await call(priyaPage, 'GET', '/api/analytics/team')).status === 403, 'the server allowed team analytics for an employee')
  check((await call(priyaPage, 'GET', `/api/analytics/person/${dev}`)).status === 404, 'an employee can open a colleague’s analytics')
  check(await overflow(priyaPage) <= 1, 'the employee view overflows')
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
} finally {
  await browser.close(); server.kill()
}
if (problems.length) { console.error(problems.join('\n')); console.error(`Screenshots so far: ${shotsDir}`); process.exit(1) }
console.log(`Work Intelligence checks passed. ${taken.length} screenshots in ${shotsDir}:\n${taken.map((f) => `  ${f}`).join('\n')}`)
