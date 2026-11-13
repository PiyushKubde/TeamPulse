// Browser checks for the Overview workboard (Playwright, Chromium): board layout and data, metric / search / filter interactions, adding a task,
// drag-and-drop and the move menu (allowed, refused, rolled back), Done paging, the employee view, responsive layouts, error and empty states.
// Runs on a disposable DATA_DIR with demo data (never ./data). Usage: npm run test:e2e:workboard   (SCREENSHOTS=<dir> keeps screenshots)
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-wb-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 4100 + Math.floor(Math.random() * 90)
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
const shot = async (page, name) => { if (shots) { await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('main')?.scrollTo?.(0, 0) }); await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false }) } }
async function session(email, { theme = 'light', viewport = { width: 1440, height: 900 }, mobile = false } = {}) {
  const ctx = await browser.newContext({ viewport, ...(mobile ? { isMobile: true, hasTouch: true } : {}) })
  await ctx.addInitScript((t) => { try { localStorage.setItem('tp-theme', t) } catch { /* private mode */ } }, theme)
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${email}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|ERR_TUNNEL|ERR_NAME|net::|status of 4\d\d|status of 5\d\d|fonts\./.test(m.text())) problems.push(`[${email}] ${step}: console ${m.text()}`) })
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  await page.waitForSelector('.wb-col')
  return { page, ctx }
}
const cards = (page, col) => page.locator(`.wb-col[data-col="${col}"] .wb-card`)
const titlesIn = (page, col) => page.locator(`.wb-col[data-col="${col}"] .wb-title`).allTextContents()
const count = async (page, col) => Number(await page.locator(`.wb-col[data-col="${col}"] .wb-count`).textContent())
const settle = (page) => page.waitForLoadState('networkidle').then(() => page.waitForTimeout(150))
const api = async (ctx, path, method = 'GET', body) => { const r = await ctx.request.fetch(base + path, { method, headers: { 'X-Requested-With': 'TeamPulse', ...(body ? { 'Content-Type': 'application/json' } : {}) }, data: body ? JSON.stringify(body) : undefined }); return { status: r.status(), body: await r.json().catch(() => null) } }
const toastText = (page) => page.locator('.toast').last().textContent()
const toastHas = (page, text) => page.waitForFunction((t) => [...document.querySelectorAll('.toast')].some((x) => x.textContent.includes(t)), text, { timeout: 5000 }).then(() => true, () => false)

try {
  // ---------------- manager, desktop ----------------
  step = 'manager board (desktop, light)'
  const { page: m, ctx: mctx } = await session('manager@demo.teampulse')
  const priyaId = (await api(mctx, '/api/assignable')).body.find((p) => p.name === 'Priya Sharma').userId
  await api(mctx, '/api/tasks', 'POST', { title: 'Prepare onboarding checklist', assigneeId: priyaId, priority: 'MEDIUM', dueAt: new Date(Date.now() + 5 * 86400000).toISOString() })
  await m.click('#wb-refresh'); await settle(m)
  ok((await m.locator('.wb-col').count()) === 5, 'five columns')
  ok((await m.locator('.wb-col h2').allTextContents()).join('|') === 'To do|In progress|Blocked|In review|Done', 'column titles in order')
  ok(await m.locator('h1').textContent() === 'Team Workboard', 'title')
  ok((await m.locator('.wb-head p').textContent()).includes('See what your team is working on'), 'subtitle')
  ok((await m.locator('.wb-metric').count()) === 4, 'four metrics')
  ok(!(await m.locator('.stat, .decisions, .intervene, .hero').count()), 'the old overview panels are gone')
  ok(await overflow(m) <= 1, `no page-wide horizontal overflow (${await overflow(m)}px)`)
  const api0 = (await api(mctx, '/api/workboard')).body
  for (const k of ['todo', 'in_progress', 'blocked', 'in_review']) ok(await count(m, k) === api0.columns[k].count && (await cards(m, k).count()) === api0.columns[k].tasks.length, `${k}: count and cards match the API`)
  const metric = async (k) => Number(await m.locator(`.wb-metric[data-kpi="${k}"] .n`).textContent())
  ok(await metric('ACTIVE') === api0.metrics.active && await metric('BLOCKED') === api0.metrics.blocked && await metric('OVERDUE') === api0.metrics.overdue && await metric('COMPLETED') === api0.metrics.completed, 'metrics come from the API')
  ok(await m.locator('.wb-attn').textContent().then((t) => /need attention|All work on track/.test(t)), 'attention line')
  const board = await m.locator('#wb-board').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth }))
  ok(board.sw > board.cw || board.sw >= 5 * 280, 'columns scroll inside the board')
  await shot(m, 'desktop-manager-light')

  step = 'contributions that matter'
  await m.waitForSelector('.wb-contrib')
  ok(await m.locator('.wb-contrib h2').textContent().then((t) => t.includes('Contributions that matter')), 'contribution strip')
  ok((await m.locator('.wb-contrib-note').textContent()).includes('Not task counts'), 'states that it is not a count or ranking')
  const intel = (await api(mctx, '/api/contribution/intelligence')).body
  ok((await m.locator('.wb-contrib-list li').count()) === Math.min(3, intel.significant.length), 'shows the significant contributions the API returns')
  if (intel.significant.length) {
    const li = m.locator('.wb-contrib-list li').first()
    ok(await li.locator('.badge.brand, .prov').count() > 0, 'a contribution shows its complexity or evidence')
    await li.locator('a').click(); await m.waitForSelector('.task-head h1')
    await m.goBack(); await m.waitForSelector('.wb-col')
  } else ok(await m.locator('.wb-contrib-empty').count() === 1, 'honest empty line when nothing is significant yet')
  ok(await m.locator('.wb-contrib a[href="#/analytics"]').count() === 1, 'links to Work Analytics')
  await shot(m, 'desktop-manager-contrib')

  step = 'owner opens that person contribution profile'
  await m.locator('.wb-col[data-col="in_progress"] a.wb-who').first().click()
  await m.waitForFunction(() => location.hash.startsWith('#/contribution/'))
  await m.waitForSelector('main h1')
  await m.goBack(); await m.waitForSelector('.wb-col')

  step = 'metric filters'
  await m.click('.wb-metric[data-kpi="OVERDUE"]')
  await settle(m)
  ok(await m.locator('.wb-metric[data-kpi="OVERDUE"]').getAttribute('aria-pressed') === 'true', 'overdue pressed')
  const overdueCards = await m.locator('.wb-col:not([data-col="done"]) .wb-card').count()
  ok(overdueCards === api0.metrics.overdue, `overdue filter shows ${api0.metrics.overdue} (got ${overdueCards})`)
  ok((await m.locator('.wb-col:not([data-col="done"]) .wb-card:not(.is-overdue)').count()) === 0, 'only overdue cards')
  ok(await m.locator('#wb-active').textContent().then((t) => t.includes('Overdue')), 'active-filter indicator')
  ok(await metric('ACTIVE') === api0.metrics.active, 'metrics keep describing the whole scope')
  await m.click('.wb-metric[data-kpi="OVERDUE"]'); await settle(m)
  ok((await m.locator('.wb-col:not([data-col="done"]) .wb-card').count()) === api0.metrics.active, 'second click clears it')
  await m.click('.wb-metric[data-kpi="BLOCKED"]'); await settle(m)
  ok((await titlesIn(m, 'blocked')).length === api0.metrics.blocked && (await cards(m, 'todo').count()) === 0, 'blocked filter')
  await m.click('.wb-metric[data-kpi="COMPLETED"]'); await settle(m)
  ok((await m.locator('.wb-col:not([data-col="done"]) .wb-card').count()) === 0 && (await count(m, 'done')) === api0.metrics.completed, 'completed filter shows only Done')
  await m.click('.wb-metric[data-kpi="ACTIVE"]'); await settle(m)
  ok((await m.locator('.wb-col[data-col="done"] .wb-empty').textContent()).includes('Not part of this filter'), 'Done is left out of an open-work metric')
  await m.click('#wb-clear'); await settle(m)

  step = 'search and filters'
  await m.fill('#wb-q', 'runbook')
  await m.waitForFunction(() => document.querySelectorAll('.wb-col:not([data-col="done"]) .wb-card').length === 1)
  ok((await titlesIn(m, 'todo')).concat(await titlesIn(m, 'in_progress'), await titlesIn(m, 'blocked'), await titlesIn(m, 'in_review')).join().includes('runbook'), 'search finds the runbook task')
  await m.fill('#wb-q', 'zzz-nothing')
  await m.waitForFunction(() => document.querySelectorAll('.wb-card').length === 0)
  ok((await m.locator('.wb-card').count()) === 0 && await m.locator('.wb-empty').first().textContent().then((t) => t.includes('No matching')), 'no match → compact empty state')
  await m.click('#wb-clear'); await settle(m)
  await m.selectOption('#wb-priority', 'CRITICAL'); await settle(m)
  ok((await m.locator('.wb-card .prio-CRITICAL').count()) === (await m.locator('.wb-col:not([data-col="done"]) .wb-card').count()) && (await m.locator('.wb-card').count()) > 0, 'priority filter')
  await m.selectOption('#wb-priority', ''); await settle(m)
  await m.selectOption('#wb-assignee', { label: 'Priya Sharma' }); await settle(m)
  ok((await m.locator('.wb-card .wb-who[title*="Priya"]').count()) === (await m.locator('.wb-card').count()) && (await m.locator('.wb-card').count()) > 0, 'assignee filter')
  await m.click('.wb-metric[data-kpi="OVERDUE"]'); await settle(m)
  ok((await m.locator('.wb-card').count()) === (await m.locator('.wb-card.is-overdue').count()), 'a metric combines with the assignee filter')
  await m.click('#wb-clear'); await settle(m)
  await m.selectOption('#wb-deadline', 'NONE'); await settle(m)
  const noDue = (await api(mctx, '/api/workboard?deadline=NONE')).body
  ok((await m.locator('.wb-card .wb-due').count()) === 0 && (await m.locator('.wb-card').count()) === Object.values(noDue.columns).reduce((n, c) => n + c.tasks.length, 0), 'no-deadline filter shows exactly the cards without a due date')
  await m.selectOption('#wb-deadline', 'OVERDUE'); await settle(m)
  ok((await m.locator('.wb-card').count()) === (await m.locator('.wb-card.is-overdue').count()), 'overdue deadline filter')
  await m.selectOption('#wb-deadline', 'WEEK'); await settle(m)
  ok((await m.locator('.wb-card.is-overdue').count()) === 0, 'due this week excludes overdue and undated cards')
  await m.selectOption('#wb-deadline', ''); await settle(m)

  step = 'card opens the task'
  const firstTitle = (await titlesIn(m, 'todo'))[0]
  await m.locator('.wb-col[data-col="todo"] .wb-card').first().locator('.wb-meta').click()
  await m.waitForSelector('.task-head h1')
  ok(await m.locator('.task-head h1').textContent() === firstTitle, 'the existing task page opened the right task')
  await m.goBack(); await m.waitForSelector('.wb-col')

  step = 'add a task'
  await m.click('#wb-add')
  await m.waitForSelector('#task-form')
  await m.fill('#t-title', 'Board check: draft vendor review')
  await m.click('#task-form button[type=submit]')
  await m.waitForSelector('.wb-title:has-text("Board check: draft vendor review")')
  ok(m.url().endsWith('#/dashboard'), 'stays on the board after creating')
  const created = (await api(mctx, '/api/tasks?view=team')).body.find((t) => t.title === 'Board check: draft vendor review')
  ok(created && created.status === 'ASSIGNED' && !created.assigneeId, 'created through the existing API, unassigned')
  ok(await m.locator('.wb-card:has-text("Board check") .wb-flag.warn:has-text("Unassigned")').count() === 1, 'an unassigned task is shown as unassigned')
  ok(await m.locator('.wb-card:has-text("Board check") .wb-due').count() === 0, 'no invented deadline')

  step = 'drag refused for a manager (not the owner) and for blocked columns'
  const priyaTodo = m.locator('.wb-col[data-col="todo"] .wb-card:has(.wb-who[title*="Priya"])').first()
  const priyaTitle = await priyaTodo.locator('.wb-title').textContent()
  const calls = []
  m.on('request', (r) => { if (/\/api\/tasks\/[^/]+\/status/.test(r.url())) calls.push(r.url()) })
  await priyaTodo.dragTo(m.locator('.wb-col[data-col="in_progress"] .wb-list'))
  ok(await toastHas(m, 'Only the owner'), `manager sees why: ${await toastText(m)}`)
  await priyaTodo.dragTo(m.locator('.wb-col[data-col="done"] .wb-list'))
  ok(await toastHas(m, 'manager approves'), `drop on Done explains approval: ${await toastText(m)}`)
  ok(calls.length === 0, 'refused moves never call the server')
  ok((await titlesIn(m, 'todo')).includes(priyaTitle), 'the card stayed in To do')

  // ---------------- employee ----------------
  step = 'employee board'
  const { page: e, ctx: ectx } = await session('priya@demo.teampulse', { viewport: { width: 1440, height: 900 } })
  ok(await e.locator('h1').textContent() === 'My workboard', 'employee title')
  ok(!(await e.locator('a[href="#/copilot"]').count()), 'no manager copilot for employees')
  ok(!(await e.locator('.wb-contrib').count()) && (await api(ectx, '/api/contribution/intelligence')).status === 403, 'employees get no team contribution strip, and the API refuses them')
  const mine = (await api(ectx, '/api/workboard')).body
  const all = Object.values(mine.columns).flatMap((c) => c.tasks)
  ok(all.length > 0 && all.every((t) => t.assigneeName === 'Priya Sharma' || t.isMine || t.canManage === false), 'only her own tasks')
  ok(!all.some((t) => ['Dev Patel', 'Neha Rao'].includes(t.assigneeName)), 'no colleague tasks')
  ok(!(await e.locator('.wb-card:has-text("Evaluate feature-flag vendors")').count()), 'unrelated unassigned task is not exposed')
  ok((await e.locator('a.wb-who').count()) === 0, 'employees get no links to other people’s profiles')
  await shot(e, 'desktop-employee-light')

  step = 'employee drags To do → In progress (allowed), and back'
  const eTodo = e.locator('.wb-col[data-col="todo"] .wb-card').first()
  const eTitle = await eTodo.locator('.wb-title').textContent()
  const eId = await eTodo.getAttribute('data-id')
  const inProgressBefore = await count(e, 'in_progress')
  await eTodo.dragTo(e.locator('.wb-col[data-col="in_progress"] .wb-list'))
  await e.waitForFunction((t) => [...document.querySelectorAll('.wb-col[data-col="in_progress"] .wb-title')].some((x) => x.textContent === t), eTitle)
  await settle(e)
  ok(await count(e, 'in_progress') === inProgressBefore + 1, 'in-progress count updated from the server')
  ok((await api(ectx, `/api/tasks/${eId}`)).body.task.status === 'IN_PROGRESS', 'the existing status API moved it')
  const hist = (await api(ectx, `/api/tasks/${eId}`)).body.events
  ok(hist.some((x) => x.type === 'status_changed' && x.data.to === 'IN_PROGRESS'), 'recorded in the task history')
  // The same move through the card menu.
  await e.locator(`.wb-card[data-id="${eId}"]`).hover()
  await e.locator(`.wb-card[data-id="${eId}"] .wb-menu summary`).click()
  await e.locator(`.wb-card[data-id="${eId}"] [data-move="todo"]`).click()
  await e.waitForFunction((t) => [...document.querySelectorAll('.wb-col[data-col="todo"] .wb-title')].some((x) => x.textContent === t), eTitle)
  await settle(e)
  ok((await api(ectx, `/api/tasks/${eId}`)).body.task.status === 'ASSIGNED', 'the menu moved it back')

  step = 'a server refusal rolls the card back'
  await e.route('**/api/tasks/*/status', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'invalid_transition', message: 'A task cannot move from ASSIGNED to IN_PROGRESS.' } }) }))
  const todoBefore = await titlesIn(e, 'todo')
  await e.locator(`.wb-card[data-id="${eId}"]`).dragTo(e.locator('.wb-col[data-col="in_progress"] .wb-list'))
  ok(await toastHas(e, 'cannot move'), 'the server’s refusal is shown')
  await settle(e)
  ok(JSON.stringify(await titlesIn(e, 'todo')) === JSON.stringify(todoBefore), 'rolled back to its place')
  ok(await e.locator('.wb-card.is-busy').count() === 0, 'no card is left busy')
  await e.unroute('**/api/tasks/*/status')

  step = 'duplicate drops are ignored while a move is in flight'
  let hits = 0
  await e.route('**/api/tasks/*/status', async (r) => { hits++; await new Promise((x) => setTimeout(x, 700)); await r.continue() })
  await e.locator(`.wb-card[data-id="${eId}"]`).dragTo(e.locator('.wb-col[data-col="in_progress"] .wb-list'))
  await e.waitForTimeout(100)
  ok((await e.locator(`.wb-card[data-id="${eId}"]`).getAttribute('aria-busy')) === 'true', 'the moving card shows it is busy')
  await e.locator(`.wb-card[data-id="${eId}"]`).dragTo(e.locator('.wb-col[data-col="todo"] .wb-list'), { force: true }).catch(() => {})
  await e.waitForTimeout(1200); await settle(e)
  ok(hits === 1, `one request for one move (${hits})`)
  await e.unroute('**/api/tasks/*/status')
  await api(ectx, `/api/tasks/${eId}/status`, 'POST', { status: 'ASSIGNED' })

  // ---------------- Done paging (real tasks through the real lifecycle) ----------------
  step = 'Done paging'
  const mgrTasks = []
  for (let i = 0; i < 17; i++) {
    const t = (await api(mctx, '/api/tasks', 'POST', { title: `Shipped ${String(i).padStart(2, '0')}`, assigneeId: priyaId })).body.task
    await api(ectx, `/api/tasks/${t.id}/status`, 'POST', { status: 'IN_PROGRESS' })
    await api(ectx, `/api/tasks/${t.id}/submit`, 'POST', { summary: 'Done', outcome: 'Shipped' })
    await api(mctx, `/api/tasks/${t.id}/review`, 'POST', { decision: 'APPROVED' })
    mgrTasks.push(t.id)
  }
  await m.click('#wb-refresh'); await settle(m)
  const doneTotal = await count(m, 'done')
  ok(doneTotal >= 17, `Done count is the real total (${doneTotal})`)
  ok((await cards(m, 'done').count()) === 15, 'Done loads one page, not the whole history')
  ok((await titlesIn(m, 'done'))[0] === 'Shipped 16', 'most recently completed first')
  await m.click('#wb-more'); await settle(m)
  ok((await cards(m, 'done').count()) === Math.min(30, doneTotal), 'Show more adds the next page')
  ok(await m.locator('#wb-more').count() === (doneTotal > 30 ? 1 : 0), 'the button goes away when everything is shown')
  ok(await m.locator('.wb-col[data-col="done"] .wb-card [data-move]').count() === (await cards(m, 'done').count()), 'a manager may reopen done work from the menu')

  // ---------------- responsive + theme ----------------
  step = 'dark theme'
  const { page: d } = await session('manager@demo.teampulse', { theme: 'dark' })
  ok(await d.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'dark theme active')
  ok(await overflow(d) <= 1, 'dark: no page overflow')
  const colors = await d.evaluate(() => { const c = document.querySelector('.wb-col'); const k = document.querySelector('.wb-card'); return [getComputedStyle(document.body).backgroundColor, getComputedStyle(c).backgroundColor, getComputedStyle(k).backgroundColor] })
  ok(new Set(colors).size === 3, `dark layers are distinct: ${colors}`)
  await shot(d, 'desktop-manager-dark')

  step = 'tablet'
  const { page: tab } = await session('manager@demo.teampulse', { viewport: { width: 820, height: 1100 } })
  ok(await overflow(tab) <= 1, `tablet: no page overflow (${await overflow(tab)}px)`)
  const visibleCols = (page) => page.evaluate(() => { const b = document.getElementById('wb-board').getBoundingClientRect(); return [...document.querySelectorAll('.wb-col')].filter((c) => { const r = c.getBoundingClientRect(); return r.left >= b.left - 1 && r.right <= b.right + 1 }).length })
  const tabCols = await visibleCols(tab)
  ok(tabCols >= 2 && tabCols <= 3, `tablet shows two or three columns (${tabCols})`)
  await shot(tab, 'tablet-manager-light')

  step = 'mobile'
  const { page: mob } = await session('manager@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  ok(await overflow(mob) <= 1, `mobile: no page overflow (${await overflow(mob)}px)`)
  const mobCols = await visibleCols(mob)
  ok(mobCols >= 1 && mobCols <= 2, `mobile shows one or two columns (${mobCols})`)
  ok(await mob.locator('.wb-card').first().locator('.wb-menu summary').evaluate((s) => getComputedStyle(s).opacity) === '1', 'touch devices always see the card menu')
  ok(await mob.locator('.wb-title').first().evaluate((t) => t.getBoundingClientRect().width) > 150, 'cards stay readable')
  await shot(mob, 'mobile-manager-light')
  await mob.locator('#wb-board').evaluate((b) => { b.scrollLeft = 600 })
  ok(await overflow(mob) <= 1, 'scrolling the board does not scroll the page sideways')
  await shot(mob, 'mobile-manager-scrolled')
  const { page: mobE } = await session('priya@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true, theme: 'dark' })
  ok(await overflow(mobE) <= 1, 'mobile dark employee: no overflow')
  await shot(mobE, 'mobile-employee-dark')

  // ---------------- states ----------------
  step = 'loading and error states'
  const s = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const sp = await s.newPage()
  sp.on('pageerror', (x) => problems.push(`[states] ${x.message}`))
  await sp.goto(`${base}/#/login`); await sp.getByText('Local development sign-in').click(); await sp.fill('#dev-email', 'manager@demo.teampulse'); await sp.click('#dev-login button[type=submit]'); await sp.waitForSelector('.wb-col')
  await sp.goto(`${base}/#/team-tasks`); await sp.waitForSelector('h1:has-text("Team tasks")')
  await sp.route('**/api/workboard*', async (r) => { await new Promise((x) => setTimeout(x, 900)); await r.continue() })
  await sp.evaluate(() => { location.hash = '#/dashboard' })
  await sp.waitForSelector('.wb-loading')
  await shot(sp, 'state-loading')
  await sp.waitForSelector('.wb-col'); await sp.unroute('**/api/workboard*')
  await sp.route('**/api/workboard*', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'The board is unavailable.' } }) }))
  await sp.click('#wb-refresh') // a refresh that fails keeps the board and tells the person
  ok(await toastHas(sp, 'The board is unavailable'), 'a failed refresh is reported')
  ok(await sp.locator('.wb-col').count() === 5, 'a failed refresh keeps the existing board')
  await sp.evaluate(() => { location.hash = '#/team-tasks' }); await sp.waitForSelector('h1:has-text("Team tasks")')
  await sp.evaluate(() => { location.hash = '#/dashboard' }); await sp.waitForSelector('.wb-error')
  ok((await sp.locator('.wb-error').textContent()).includes('The board is unavailable'), 'error message shown')
  await shot(sp, 'state-error')
  await sp.unroute('**/api/workboard*')
  await sp.click('#wb-retry'); await sp.waitForSelector('.wb-col')
  ok(await sp.locator('.wb-col').count() === 5, 'retry recovers')

  step = 'stale responses never overwrite newer ones'
  let slow = true
  await sp.route('**/api/workboard*', async (r) => { if (slow && r.request().url().includes('q=aaa')) { await new Promise((x) => setTimeout(x, 1200)); slow = false } await r.continue() })
  await sp.fill('#wb-q', 'aaa'); await sp.waitForTimeout(400)
  await sp.fill('#wb-q', 'runbook')
  await sp.waitForFunction(() => document.querySelectorAll('.wb-col:not([data-col="done"]) .wb-card').length === 1)
  await sp.waitForTimeout(1500)
  ok(await sp.locator('.wb-col:not([data-col="done"]) .wb-card').count() === 1, 'the slow older search did not overwrite the newer one')
  await sp.unroute('**/api/workboard*')

  step = 'empty board'
  const none = { count: 0, tasks: [] }
  await sp.route('**/api/workboard*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ timezone: 'UTC', truncated: false, filtered: false, people: [], metrics: { active: 0, inProgress: 0, blocked: 0, overdue: 0, attention: 0 }, columns: { todo: none, in_progress: none, blocked: none, in_review: none, done: { ...none, hasMore: false } } }) }))
  await sp.click('#wb-refresh'); await sp.waitForFunction(() => document.querySelectorAll('.wb-card').length === 0 && document.querySelectorAll('.wb-empty').length === 5)
  ok(await sp.locator('.empty-icon, .empty h3').count() === 0, 'no large decorative empty state')
  ok((await sp.locator('.wb-attn').textContent()).includes('All work on track'), 'a quiet "All work on track" line, not a panel')
  ok(await sp.locator('#wb-add').count() === 1, 'the board still offers Add a task')
  await shot(sp, 'state-empty')
  await sp.unroute('**/api/workboard*')

  step = 'contribution strip with analysed work (simulated analyser)'
  const rich = (await api(mctx, '/api/tasks', 'POST', { title: 'Fix the checkout reservation race', description: 'Checkout fails for some users with no clear error. Needs investigation across multiple services (cart, payments, inventory).', assigneeId: priyaId, priority: 'HIGH' })).body.task
  await api(ectx, `/api/tasks/${rich.id}/status`, 'POST', { status: 'IN_PROGRESS' })
  await api(ectx, `/api/evidence/task/${rich.id}/links`, 'POST', { url: 'https://github.com/acme/shop/pull/481', label: 'PR 481: idempotent reservation token' })
  await api(ectx, `/api/tasks/${rich.id}/submit`, 'POST', { summary: 'Investigated logs across cart, payments and inventory and found the root cause: a race condition between reservation and payment capture. Added an idempotent reservation token and a regression test.', outcome: 'Checkout failures stopped in staging.' })
  for (let i = 0; i < 40; i++) { if ((await api(mctx, '/api/contribution/intelligence')).body.significant.some((x) => x.taskId === rich.id)) break; await m.waitForTimeout(500) }
  await m.reload(); await m.waitForSelector('.wb-contrib-list li')
  const item = m.locator('.wb-contrib-list li', { hasText: 'Fix the checkout reservation race' })
  ok(await item.count() === 1, 'the analysed task is listed')
  ok((await item.textContent()).includes('Priya Sharma') && (await item.textContent()).includes('Complexity L'), 'who, and the complexity level with its reason')
  ok((await item.textContent()).includes('Evidence from apps') || (await item.textContent()).includes('Awaiting your assessment') || (await item.textContent()).includes('simulated'), 'evidence / assessment status / simulated label')
  await shot(m, 'desktop-manager-contrib-populated')
  await item.locator('a').click(); await m.waitForSelector('.task-head h1')
  ok(await m.locator('.task-head h1').textContent() === 'Fix the checkout reservation race', 'opens the existing task page')
  await m.waitForSelector('#ai-card table.dims') // the existing assessment, where the manager verifies or adjusts
  await m.goBack(); await m.waitForSelector('.wb-col')
  // The reviewer journey: workboard → owner → contribution profile → task assessment (screenshots of every step).
  step = 'reviewer journey'
  await m.setViewportSize({ width: 1440, height: 1500 })
  await shot(m, 'journey-1-workboard')
  await m.locator('.wb-col[data-col="in_review"] a.wb-who', { hasText: 'Priya' }).first().click()
  await m.waitForSelector('h1:has-text("Priya Sharma")'); await m.waitForSelector('#p-tasks li, #p-tasks .muted'); await m.waitForSelector('#p-evidence ul, #p-evidence .muted, .dim-card')
  await settle(m)
  ok((await m.locator('#p-work tbody tr:visible').count()) === 8 && await m.locator('#p-work-all').count() === 1, 'a long analysed-work history is collapsed to the newest rows')
  ok((await m.locator('.crumbs a').first().textContent()) === 'Overview' && m.url().includes('from=dashboard'), 'from the board, the way back is Overview')
  ok(await m.locator('#nav a[data-key="dashboard"][aria-current="page"]').count() === 1, 'the sidebar keeps Overview highlighted')
  await m.click('.segmented a:has-text("Last 30 days")'); await m.waitForSelector('h1:has-text("Priya Sharma")')
  ok((await m.locator('.crumbs a').first().textContent()) === 'Overview', 'changing the period keeps the way back')
  await m.click('.segmented a:has-text("Last 90 days")'); await m.waitForSelector('#p-work tbody tr'); await settle(m)
  await shot(m, 'journey-2-profile')
  if (shots) await m.screenshot({ path: join(shots, 'journey-2-profile-full.png'), fullPage: true })
  ok(await m.locator('#p-tasks').count() === 1 && await m.locator('#p-evidence').count() === 1 && (await m.locator('.dim-card').count()) >= 1, 'profile: tasks, evidence and rated dimensions on one page')
  ok((await m.locator('main').textContent()).includes('Not enough evidence to rate yet: Impact, Collaboration'), 'unrated dimensions are one line, not empty cards')
  ok((await m.locator('.person-head p').first().textContent()) === 'Employee · Platform', 'role and team under the name')
  ok((await m.locator('.person-head').textContent()).includes('Responsibilities are read from the tasks assigned'), 'honest note: responsibilities come from assigned tasks')
  ok(await m.locator('#p-work .badge:has-text("Simulated")').count() >= 1 && await m.locator('#p-work .badge:has-text("Rules only")').count() >= 1, 'simulated and rules-only are separate badges')
  ok(await m.locator('#p-work .badge:has-text("Waiting for the employee")').count() >= 1 && !(await m.locator('#p-work').textContent()).includes('Waiting for your confirmation'), 'a reviewer is not told it waits for their confirmation')
  await m.click('#p-work-all')
  ok((await m.locator('#p-work tbody tr:visible').count()) > 8 && await m.locator('#p-work-all').count() === 0, 'Show all expands every analysed piece')
  await m.goto(`${base}/#/contribution`); await m.waitForSelector('h1:has-text("Team intelligence")')
  await m.locator('a[href^="#/contribution/"]', { hasText: 'Priya Sharma' }).first().click(); await m.waitForSelector('h1:has-text("Priya Sharma")')
  ok((await m.locator('.crumbs a').first().textContent()) === 'Team intelligence' && await m.locator('#nav a[data-key="intelligence"][aria-current="page"]').count() === 1, 'from Team Intelligence, the way back is Team Intelligence')
  await m.click('.crumbs a'); await m.waitForSelector('h1:has-text("Team intelligence")')
  await m.goto(`${base}/#/contribution/${priyaId}`); await m.waitForSelector('#p-work tbody tr'); await settle(m)
  await m.locator('main table a', { hasText: 'Fix the checkout reservation race' }).first().click()
  await m.waitForSelector('#ai-card table.dims')
  await settle(m)
  if (shots) await m.screenshot({ path: join(shots, 'journey-3-assessment-full.png'), fullPage: true })
  await m.setViewportSize({ width: 1440, height: 900 })

  step = 'reviewer journey on a phone'
  const { page: pj } = await session('manager@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await pj.waitForSelector('.wb-contrib-list li')
  await shot(pj, 'journey-m1-workboard')
  ok(await overflow(pj) <= 1, 'phone: board fits')
  await pj.locator('.wb-col[data-col="in_review"] a.wb-who', { hasText: 'Priya' }).first().scrollIntoViewIfNeeded().catch(() => {})
  await pj.goto(`${base}/#/contribution/${priyaId}`); await pj.waitForSelector('#p-work tbody tr'); await settle(pj)
  ok(await overflow(pj) <= 1, `phone: profile fits (${await overflow(pj)}px)`)
  await shot(pj, 'journey-m2-profile')
  await pj.click('#p-work-all'); ok(await overflow(pj) <= 1, 'phone: profile fits with every row shown')
  await pj.goto(`${base}/#/tasks/${rich.id}`); await pj.waitForSelector('#ai-card table.dims'); await settle(pj)
  ok(await overflow(pj) <= 1, `phone: assessment fits (${await overflow(pj)}px)`)
  await pj.locator('#ai-card').scrollIntoViewIfNeeded()
  await shot(pj, 'journey-m3-assessment')

  const { page: mc } = await session('manager@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await mc.waitForSelector('.wb-contrib-list li')
  ok(await overflow(mc) <= 1, 'strip fits a phone')
  await shot(mc, 'mobile-manager-contrib')

  // ---------------- regression: other pages still open ----------------
  step = 'other pages'
  for (const [hash, sel] of [['#/team-tasks', 'h1:has-text("Team tasks")'], ['#/review', 'main h1'], ['#/analytics', 'main h1'], ['#/reviews', 'main h1'], ['#/automations', 'main h1'], ['#/my-tasks', 'h1:has-text("My tasks")'], ['#/contribution', 'main h1']]) {
    await m.evaluate((h) => { location.hash = h }, hash)
    await m.waitForSelector(sel)
    ok(!(await m.locator('.notice.err').count()), `${hash} opened without an error`)
  }
  await m.evaluate(() => { location.hash = '#/dashboard' }); await m.waitForSelector('.wb-col')
  await m.click('nav >> text="Review Queue"'); await m.waitForSelector('main h1')

  if (problems.length) throw new Error(`Browser problems:\n${problems.join('\n')}`)
  console.log('E2E workboard passed (layout, data, metrics, filters, add task, drag-and-drop + menu, rollback, paging, employee view, responsive, dark, states).')
} catch (err) {
  console.error(`E2E workboard FAILED at step "${step}":`, err.message)
  if (problems.length) console.error(problems.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
