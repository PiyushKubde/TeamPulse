// Browser journeys for the three roles and the task-driven contribution lifecycle (Playwright, Chromium), on disposable data (never ./data):
//  A. with the development simulator as the AI (labelled as such): an employee submits tasks, KONVO assesses them, a manager reviews, the admin console shows status;
//  B. with NO AI: the task workflow still works, and every screen says plainly that assessment is not switched on (nothing is pretended).
// Usage: npm run test:e2e:roles   (SCREENSHOTS=<dir> keeps screenshots)
/* global document, window */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'
const { chromium } = createRequire(import.meta.url)('playwright')

const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const stops = []
let nextPort = 4600 + Math.floor(Math.random() * 60)
async function boot(extra = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-roles-'))
  const port = nextPort++
  const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', CRON_SECRET: 'e2e-secret', AI_PROVIDER: '', ...extra }
  for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER']) delete env[k]
  execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
  const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
  stops.push(() => server.kill())
  return { base: `http://127.0.0.1:${port}`, stop: () => server.kill() }
}

const browser = await chromium.launch()
const problems = []
let step = ''
let base = ''
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
  await page.waitForSelector('main h1')
  return { page, ctx }
}
const api = async (ctx, path, method = 'GET', body) => { const r = await ctx.request.fetch(base + path, { method, headers: { 'X-Requested-With': 'TeamPulse', ...(body ? { 'Content-Type': 'application/json' } : {}) }, data: body ? JSON.stringify(body) : undefined }); return { status: r.status(), body: await r.json().catch(() => null) } }
const go = async (page, hash) => { await page.goto(`${base}/${hash}`); await page.waitForSelector('main h1'); await page.waitForTimeout(250) }
const topNames = (page) => page.locator('#nav > .nav-group:not(.nav-section ~ .nav-group) > .nav-top').allTextContents().then((a) => a.map((t) => t.replace(/\s*\d+\s*$/, '').trim()))

async function submit(ctxM, ctxE, assigneeId, { title, description, summary, outcome, links = [] }) {
  const t = (await api(ctxM, '/api/tasks', 'POST', { title, description, assigneeId })).body.task
  await api(ctxE, `/api/tasks/${t.id}/status`, 'POST', { status: 'IN_PROGRESS' })
  assert((await api(ctxE, `/api/tasks/${t.id}/submit`, 'POST', { summary, outcome, evidenceLinks: links.map((url) => ({ url, label: url.split('/').pop() })) })).status === 200, 'the submission works')
  return t.id
}
const HARD = {
  title: 'Fix intermittent checkout failures', description: 'Checkout fails for some users with no clear error. Needs investigation across multiple services (cart, payments, inventory).',
  summary: 'Investigated logs across cart, payments and inventory and found the root cause: a race condition between reservation and payment capture. Added an idempotent reservation token and a regression test.',
  outcome: 'Checkout failures stopped in staging.', links: ['https://github.com/acme/shop/pull/481']
}
const THIN = { title: 'Fix it', description: null, summary: 'Done.', outcome: 'Done.' }

try {
  // ================= A. the development simulator is the AI =================
  const A = await boot({ AI_PROVIDER: 'mock' })
  base = A.base
  step = 'A: employee submits; KONVO assesses'
  const { page: e, ctx: ectx } = await session('priya@demo.teampulse')
  const { page: m, ctx: mctx } = await session('manager@demo.teampulse')
  const priyaId = (await api(mctx, '/api/assignable')).body.find((p) => p.name === 'Priya Sharma').userId
  const hard = await submit(mctx, ectx, priyaId, HARD)
  const thin = await submit(mctx, ectx, priyaId, THIN)
  for (let i = 0; i < 40; i++) { const w = (await api(mctx, `/api/contribution/people/${priyaId}`)).body.work; if (w.some((x) => x.taskId === hard) && w.some((x) => x.taskId === thin)) break; await e.waitForTimeout(500) }
  const life = Object.fromEntries((await api(mctx, `/api/contribution/people/${priyaId}`)).body.work.map((w) => [w.taskId, w.lifecycle]))
  ok(life[hard] === 'SUBMITTED_FOR_REVIEW', `the difficult task is queued for the manager (${life[hard]})`)
  ok(life[thin] === 'NOT_ENOUGH_EVIDENCE', `"Done." is not enough evidence and is not queued (${life[thin]})`)

  step = 'A: employee experience'
  ok((await topNames(e)).join('|') === 'My Workspace|My Tasks|My Contributions|My Profile', 'employee navigation')
  await go(e, '#/my-contributions')
  ok((await e.locator('main h1').textContent()) === 'My Contributions', 'title')
  ok((await e.locator('main').textContent()).includes('You do not need to write anything up'), 'the page says nothing needs writing up')
  ok((await e.locator('[data-group="SUBMITTED_FOR_REVIEW"]').textContent()).includes('Fix intermittent checkout failures'), 'a meaningful task awaits the manager’s review')
  ok((await e.locator('[data-group="SUBMITTED_FOR_REVIEW"]').textContent()).includes('simulated assessment'), 'the simulator is labelled as simulated, never as real AI')
  ok((await e.locator('[data-group="NOT_ENOUGH_EVIDENCE"]').textContent()).includes('Fix it'), 'too little evidence says so')
  ok((await e.locator('.notice.warn').first().textContent()).includes('not from real AI'), 'a notice says this is a simulator')
  ok((await e.locator('#mc-record').textContent()).includes('exceptional'), 'manual recording is the exceptional path')
  ok((await e.locator('main').textContent()).includes('Finished tasks are assessed for you'), 'and it says finished tasks are assessed automatically')
  ok(await overflow(e) <= 1, 'fits')
  await shot(e, 'roles-employee-contributions')
  await e.locator('[data-group="SUBMITTED_FOR_REVIEW"] a.ov-ttl').first().click(); await e.waitForSelector('#ai-card table.dims')
  ok(await e.locator('#ai-card button[data-mgr]').count() === 0, 'an employee has no approve, adjust or dispute buttons for their own assessment')
  ok((await api(ectx, `/api/tasks/${hard}/assessment/review`, 'POST', { action: 'APPROVE' })).status === 403, 'the server refuses an employee approving their own assessment')

  step = 'A: manager experience'
  ok((await topNames(m)).join('|') === 'Team Overview|Workboard|People|Reviews|Work Intelligence', 'manager navigation')
  await go(m, '#/contribution'); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  await m.waitForFunction(() => [...document.querySelectorAll('[data-assess]')].every((x) => !x.textContent.startsWith('Reading')))
  const row = await m.locator(`[data-assess="${priyaId}"]`).textContent()
  ok(row.includes('1 awaiting your review') && row.includes('L4'), `People shows the assessment waiting for review (${row.slice(0, 160)})`)
  ok(row.includes('without enough evidence'), 'and the work that could not be judged, quietly')
  ok((await m.locator('[data-person-row]', { hasText: 'Priya Sharma' }).textContent()).includes('Cut checkout API p95 latency'), 'in the same row as what they are working on')
  await shot(m, 'roles-manager-people')
  await go(m, '#/reviews'); await m.waitForSelector('h1:has-text("Assessments to confirm")')
  ok((await m.locator('main').textContent()).includes('routine work and work without enough evidence are recorded without waiting for you'), 'the review page says what lands here')
  await go(m, '#/reviews?tab=analyses'); await m.waitForSelector('.review-item:has-text("Fix intermittent checkout failures")')
  ok(!(await m.locator('.review-item:has-text("Fix it")').count()), 'work without enough evidence is not in the review queue')
  await m.waitForTimeout(600)
  if (!(await m.isVisible('.assessment-slot table.dims'))) await m.click('.review-item:has-text("Fix intermittent checkout failures") >> button[data-open-assessment]')
  await m.waitForSelector('.assessment-slot table.dims'); ok(await m.isVisible('.assessment-slot button[data-mgr="APPROVE"]'), 'the manager can approve inside the workspace')
  await go(m, `#/tasks/${hard}`); await m.waitForSelector('#ai-card button[data-mgr="APPROVE"]')
  await m.click('#ai-card button[data-mgr="APPROVE"]'); await m.waitForSelector('#f button[type=submit]'); await m.click('#f button[type=submit]'); await m.waitForSelector('#ai-card >> text=Approved by a manager')
  await go(m, '#/contribution'); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  await m.waitForFunction(() => [...document.querySelectorAll('[data-assess]')].every((x) => !x.textContent.startsWith('Reading')))
  const after = await m.locator(`[data-assess="${priyaId}"]`).textContent()
  ok(after.includes('1 approved') && !after.includes('awaiting your review'), 'after approval it is history, not queue: ' + after)
  await shot(m, 'roles-manager-people-approved')
  await go(e, '#/my-contributions')
  ok((await e.locator('[data-group="APPROVED"]').textContent()).includes('Fix intermittent checkout failures'), 'the employee sees it in their approved history')
  ok(await e.locator('[data-group="SUBMITTED_FOR_REVIEW"]').count() === 0, 'and no longer awaiting review')
  ok((await api(mctx, '/api/admin/system')).status === 403, 'a manager does not get the admin system view')
  await m.click('#profile-btn'); ok(!(await m.locator('#profile-menu [data-mode]').count()), 'no admin switch for managers'); await m.keyboard.press('Escape')
  await go(m, '#/admin'); ok((await m.locator('main h1').textContent()).includes('for administrators'), 'the admin page is closed to managers')

  step = 'A: admin experience'
  const { page: a, ctx: actx } = await session('admin@demo.teampulse')
  ok(a.url().endsWith('#/admin'), `an admin lands on the admin overview (${a.url()})`)
  ok((await topNames(a)).join('|') === 'Admin overview|Organization|Users and teams|Roles and permissions|Connected apps|Alert settings|Audit history|My profile', `admin navigation: ${await topNames(a)}`)
  ok(!(await a.locator('#nav').textContent()).match(/Workboard|People|Reviews|Team Overview/), 'the manager’s daily workflow is not mixed into the admin console')
  ok((await a.locator('[data-testid=ad-members]').textContent()).includes('5 active people'), 'people and roles at a glance')
  ok((await a.locator('[data-testid=ai-status]').textContent()).includes('Development simulator'), 'AI status is honest: a simulator, not real AI')
  await shot(a, 'roles-admin-overview-simulator')
  for (const h of ['#/settings/organization', '#/settings/members', '#/settings/permissions', '#/settings/alerts', '#/settings/audit', '#/automations']) { await go(a, h); ok(!(await a.locator('main .notice.err').count()), `${h} opens for the admin`) }
  await go(a, '#/settings/members'); ok((await a.locator('#nav a[aria-current="page"]').allTextContents()).join('').includes('Users and teams'), 'the admin navigation marks the settings page')
  await a.click('#profile-btn'); await a.click('#profile-menu [data-mode="manager"]'); await a.waitForSelector('h1:has-text("Team Overview")')
  ok((await topNames(a)).join('|') === 'Team Overview|Workboard|People|Reviews|Work Intelligence', 'the admin can switch to the team workspace')
  await a.click('#profile-btn'); await a.click('#profile-menu [data-mode="admin"]'); await a.waitForSelector('h1:has-text("Admin overview")')
  ok(true, 'and back')
  const sys = await api(actx, '/api/admin/system')
  ok(sys.status === 200 && !JSON.stringify(sys.body).match(/secret|apikey|token/i), 'the system view holds no secret')
  A.stop()

  // ================= B. no AI at all =================
  base = ''
  const B = await boot()
  base = B.base
  step = 'B: no AI'
  const { page: e2, ctx: ectx2 } = await session('priya@demo.teampulse')
  const { page: m2, ctx: mctx2 } = await session('manager@demo.teampulse')
  const hard2 = await submit(mctx2, ectx2, (await api(mctx2, '/api/assignable')).body.find((p) => p.name === 'Priya Sharma').userId, HARD)
  await e2.waitForTimeout(1500)
  ok((await api(ectx2, `/api/tasks/${hard2}`)).body.task.status === 'SUBMITTED_FOR_REVIEW', 'the task workflow completes without AI')
  ok((await api(mctx2, `/api/tasks/${hard2}/review`, 'POST', { decision: 'APPROVED' })).status === 200, 'and the manager’s approval of the task works')
  await go(e2, '#/my-contributions')
  ok((await e2.locator('[data-testid=ai-unavailable]').textContent()).includes('AI assessment is not switched on yet'), 'the employee is told plainly')
  ok((await e2.locator('[data-group="PENDING"]').textContent()).includes('Assessment unavailable'), 'the submitted task is shown as unavailable, not as assessed')
  ok(await e2.locator('[data-group="SUBMITTED_FOR_REVIEW"], [data-group="APPROVED"], [data-group="ROUTINE"]').count() === 0, 'nothing is pretended')
  await shot(e2, 'roles-employee-no-ai')
  await go(m2, '#/contribution'); await m2.waitForSelector('[data-testid=people-list] [data-person-row]')
  await m2.waitForFunction(() => [...document.querySelectorAll('[data-assess]')].every((x) => !x.textContent.startsWith('Reading')))
  ok((await m2.locator('[data-person-row]', { hasText: 'Priya Sharma' }).textContent()).includes('AI assessment is not switched on yet'), 'People says so instead of "not enough evidence"')
  const { page: a2 } = await session('admin@demo.teampulse')
  ok((await a2.locator('[data-testid=ai-status]').textContent()).includes('AI assessment is off'), 'the admin sees that AI is off')
  const steps = await a2.locator('[data-testid=ai-steps] li').allTextContents()
  ok(steps.some((x) => x.includes('AI_PROVIDER=')) && steps.some((x) => x.includes('AI_MODE=on')) && steps.some((x) => /restart/i.test(x)), `the exact configuration to activate it is listed (${steps.length} steps)`)
  ok((await a2.locator('main').textContent()).includes('never sent anywhere without this approval'), 'privacy statement')
  await shot(a2, 'roles-admin-overview-no-ai')
  ok(await overflow(a2) <= 1, 'admin overview fits')
  B.stop()

  step = 'phone'
  base = ''
  const C = await boot({ AI_PROVIDER: 'mock' })
  base = C.base
  const { page: pe } = await session('priya@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await go(pe, '#/my-contributions'); ok(await overflow(pe) <= 1, 'phone: My Contributions fits'); await shot(pe, 'roles-employee-contributions-phone', false)
  const { page: pa } = await session('admin@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  ok(await overflow(pa) <= 1, 'phone: admin overview fits')
  ok((await pa.locator('.tabbar a span').allTextContents()).join('|') === 'Overview|Users|Roles|Apps', 'phone: admin tab bar')
  await shot(pa, 'roles-admin-overview-phone', false)
  C.stop()

  if (problems.length) throw new Error(`Browser problems:\n${problems.join('\n')}`)
  console.log('E2E roles passed (employee, manager and admin experiences; task-driven lifecycle with a simulated AI and with none; honest unavailable states; phone).')
} catch (err) {
  console.error(`E2E roles FAILED at step "${step}":`, err.message)
  if (problems.length) console.error(problems.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  stops.forEach((stop) => stop())
  process.exit(process.exitCode || 0)
}
