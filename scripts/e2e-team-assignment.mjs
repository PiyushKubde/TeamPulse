// Team assignment journey (Playwright, Chromium), on disposable demo data (never ./data): an admin invites an employee without a team, assigns and changes the team in the browser,
// the manager then sees the person and their work, and permissions and team isolation hold. This covers plain task review, NOT the AI contribution assessment (see e2e-roles).
// Usage: npm run test:e2e:team-assignment
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


const FREE = 'newhire@demo.teampulse'
const devLogin = (c, email, name) => c.request.fetch(base + '/auth/dev-login', { method: 'POST', headers: { 'X-Requested-With': 'TeamPulse', 'Content-Type': 'application/json' }, data: JSON.stringify({ email, name }) })
try {
  const { base: b } = await boot(); base = b
  step = 'admin invites an employee without a team; the employee accepts'
  const { page: a, ctx: actx } = await session('admin@demo.teampulse')
  const inv = await api(actx, '/api/invitations', 'POST', { email: FREE, role: 'employee' })
  ok(inv.status === 200 || inv.status === 201, `invitation created (${inv.status})`)
  const nctx = await browser.newContext()
  ok((await devLogin(nctx, FREE, 'Nia Newhire')).ok(), 'new hire signs in')
  ok((await api(nctx, `/api/invitations/${inv.body.id}/accept`, 'POST')).status === 200, 'invitation accepted')
  ok((await api(actx, '/api/members')).body.find((p) => p.name === 'Nia Newhire').teamId === null, 'the new hire has no team')

  step = 'admin UI: a team dropdown for every active employee, including the one without a team'
  await go(a, '#/settings/members'); await a.waitForSelector('[data-testid=member-counts]')
  const rows = await a.locator('tbody tr').count()
  const withSelect = await a.locator('select[data-teamof]').count()
  ok(rows === withSelect, `every active member row has a Team dropdown (${withSelect}/${rows})`)
  ok((await a.locator('[data-testid=member-counts]').textContent()).includes('without a team'), 'the page says who has no team')
  const niaSel = () => a.locator('tr', { hasText: 'Nia Newhire' }).locator('select[data-teamof]')
  ok((await niaSel().inputValue()) === '', 'Nia shows (none)')

  step = 'assign in the browser'
  const teams = (await api(actx, '/api/teams')).body
  const platform = teams.find((t) => t.name === 'Platform'); const leadership = teams.find((t) => t.name === 'Leadership')
  await niaSel().selectOption(platform.id); await a.getByText('Team updated.').waitFor()
  await a.reload(); await a.waitForSelector('[data-testid=member-counts]')
  ok((await niaSel().inputValue()) === platform.id, 'the team persists after reload')

  step = 'change team: no duplicate membership'
  await niaSel().selectOption(leadership.id); await a.getByText('Team updated.').waitFor()
  await a.reload(); await a.waitForSelector('[data-testid=member-counts]')
  ok((await niaSel().inputValue()) === leadership.id, 'the changed team persists')
  const niaId = (await api(actx, '/api/members')).body.find((p) => p.name === 'Nia Newhire').userId
  ok((await api(actx, '/api/members')).body.filter((p) => p.name === 'Nia Newhire').length === 1, 'one membership for Nia')
  ok((await api(actx, `/api/members/${niaId}`, 'PATCH', { teamId: platform.id })).status === 200, 'moved back to Platform')

  step = 'invalid and unauthorized attempts'
  ok((await api(actx, `/api/members/${niaId}`, 'PATCH', { teamId: '00000000-0000-4000-8000-000000000000' })).status === 404, 'unknown/other-organization team refused')
  ok((await api(nctx, `/api/members/${niaId}`, 'PATCH', { teamId: leadership.id })).status === 403, 'an employee cannot assign teams')
  ok((await api(nctx, `/api/members/${niaId}`, 'PATCH', { role: 'admin' })).status === 403, 'an employee cannot change roles')
  const { page: m, ctx: mctx } = await session('manager@demo.teampulse')
  ok((await api(mctx, `/api/members/${niaId}`, 'PATCH', { role: 'manager' })).status === 403, 'a manager cannot change roles')
  ok((await api(mctx, `/api/members/${niaId}`, 'PATCH', { teamId: leadership.id })).status === 403, 'a manager cannot move people to a team they do not manage')

  step = 'manager sees the new employee in People; task flow'
  await go(m, '#/contribution'); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  ok((await m.locator('[data-testid=people-list]').textContent()).includes('Nia Newhire'), 'People lists Nia')
  const task = (await api(mctx, '/api/tasks', 'POST', { title: 'Nia onboarding task', assigneeId: niaId })).body.task
  ok((await api(nctx, '/api/tasks?view=mine')).body.some((t) => t.id === task.id), 'the employee sees the assigned task')
  await api(nctx, `/api/tasks/${task.id}/accept`, 'POST'); await api(nctx, `/api/tasks/${task.id}/status`, 'POST', { status: 'IN_PROGRESS' })
  await api(nctx, `/api/tasks/${task.id}/progress`, 'POST', { progress: 60, note: 'Halfway' })
  ok((await api(nctx, `/api/tasks/${task.id}/submit`, 'POST', { summary: 'Finished the onboarding checklist.', outcome: 'Done.' })).status === 200, 'employee submits completion')
  await m.reload(); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  { const row = await m.locator('[data-person-row]', { hasText: 'Nia Newhire' }).textContent(); ok(/1 active|submitted|review/i.test(row) && !/No open work/.test(row), `People shows Nia has work awaiting review (${row.replace(/s+/g, ' ').slice(0, 220)})`) }
  await go(m, '#/analytics'); await m.waitForSelector('[data-testid=wi-people-link]')
  ok(/\d+ tasks? in this period/.test(await m.locator('main').textContent()), 'Work Intelligence shows the team summary')
  await go(m, '#/dashboard'); ok((await m.locator('main').textContent()).includes('Nia'), 'Team Overview mentions Nia’s work')
  ok((await api(mctx, `/api/tasks/${task.id}`)).status === 200, 'manager opens the task')
  const rv = await api(mctx, `/api/tasks/${task.id}/review`, 'POST', { decision: 'APPROVED' })
  ok(rv.status === 200, `manager approves the submission (${rv.status} ${JSON.stringify(rv.body).slice(0, 120)})`)
  ok((await api(nctx, '/api/tasks?view=mine&status=COMPLETED')).body.some((t) => t.id === task.id), 'completed task stays in the employee’s history')

  step = 'isolation and admin authority'
  ok((await api(actx, `/api/tasks/${task.id}`)).status === 404, 'admin does not see team work without managing the team')
  ok((await api(actx, '/api/contribution/team')).status === 403, 'admin gets no manager data')
  ok((await api(actx, `/api/tasks/${task.id}/assessment/review`, 'POST', { decision: 'APPROVED' })).status >= 400, 'admin cannot approve contributions')
  const sctx = await browser.newContext()
  await devLogin(sctx, 'other-manager@demo.teampulse', 'Olga Other')
  const oid = (await api(actx, '/api/invitations', 'POST', { email: 'other-manager@demo.teampulse', role: 'manager', teamId: leadership.id })).body.id
  ok((await api(sctx, `/api/invitations/${oid}/accept`, 'POST')).status === 200, 'second manager joins')
  const olgaId = (await api(actx, '/api/members')).body.find((p) => p.name === 'Olga Other').userId
  ok((await api(actx, `/api/teams/${leadership.id}`, 'PATCH', { managerId: olgaId })).status === 200, 'second manager assigned to Leadership')
  ok((await api(sctx, `/api/tasks/${task.id}`)).status === 404, 'another team’s manager cannot open the task')
  ok(!JSON.stringify((await api(sctx, '/api/contribution/team')).body).includes('Nia'), 'another team’s manager does not see Nia')
  ok(!JSON.stringify((await api(sctx, '/api/tasks')).body).includes('Nia onboarding'), 'nor her tasks in their lists')
  ok(!problems.length, `no console/page errors: ${problems.join(' | ')}`)
  console.log('E2E team assignment passed (invite without team, admin assigns and changes team in the browser, manager visibility, isolation, permissions).')
} catch (error) {
  console.error(`FAILED at step "${step}": ${error.message}`); if (problems.length) console.error(problems.join('\n')); process.exitCode = 1
} finally { await browser.close(); for (const s of stops) s() }
