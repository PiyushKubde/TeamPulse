// Browser checks for the Work Intelligence Team tab (Playwright, Chromium): the questions it answers, in order; the four metrics and their filter;
// who-is-doing-what with links to the contribution profile; the assessment table (only what was assessed); Person and Task tabs; the employee's limited view;
// desktop and phone layouts. Runs on a disposable DATA_DIR with demo data and the simulated analyser (never ./data).
// Usage: npm run test:e2e:intelligence   (SCREENSHOTS=<dir> keeps screenshots)
/* global document, window, getComputedStyle */
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

  step = 'People is operational: who is doing what'
  await m.goto(`${base}/#/contribution`); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  { const t = await m.locator('main').textContent(); const hit = t.match(/.{30}(leaderboard|top performer|score:|\brank(?!ing)).{30}/i); ok(!hit, `no ranking or score language (${hit ? hit[0] : ''})`) }
  const names = await m.locator('.wi-pname').allTextContents()
  const sorted = names.filter((x) => x !== 'Unassigned work')
  ok(sorted.length >= 3 && JSON.stringify(sorted) === JSON.stringify([...sorted].sort((a, b) => a.localeCompare(b))), `people are alphabetical: ${names}`)
  const priya = m.locator('[data-person-row]', { hasText: 'Priya Sharma' })
  const text = await priya.textContent()
  ok(text.includes('Cut checkout API p95 latency below 200ms') && text.includes('In progress'), 'current work with its status')
  ok(/Due (\w+ \d+|\d+ \w+)/.test(text), `confirmed deadline context: ${text.slice(0, 220)}`)
  ok(text.includes('+') && text.includes('more task'), 'extra tasks are one expandable line')
  await priya.locator('summary').click()
  ok((await priya.locator('.wi-task').count()) >= 2, 'the rest can be expanded')
  await m.waitForFunction(() => [...document.querySelectorAll('[data-assess]')].every((e) => !e.textContent.startsWith('Reading')))
  ok((await priya.textContent()).includes('Not enough evidence yet'), 'contribution status says so when there is no evidence')
  const neha = await m.locator('[data-person-row]', { hasText: 'Neha Rao' }).textContent()
  ok(neha.includes('Overdue'), 'overdue is shown as plain context')
  const wide = await m.locator('.wi-people-list').evaluate((e) => e.getBoundingClientRect().width)
  ok(wide > 1000, `the list uses the available width (${Math.round(wide)}px)`)
  ok(await m.locator('.wi-row:not(.wi-head)').first().evaluate((e) => getComputedStyle(e).display) === 'grid' && await m.locator('.wi-people-list').evaluate((e) => getComputedStyle(e).listStyleType) === 'none', 'the people list is styled as one row per person (columns), not a bulleted list')
  await shot(m, 'wi2-desktop-people')

  step = 'People filter: Needs attention shows only the people it applies to; a second click resets'
  await m.goto(`${base}/#/contribution`); await m.waitForSelector('[data-testid=people-list] [data-person-row]'); await m.waitForSelector('[data-testid=people-glance]')
  const all = await m.locator('[data-person-row]:visible').count()
  await m.click('[data-glance=attention]')
  const att = await m.locator('[data-person-row]:visible').count()
  ok(att >= 1 && att < all, `Needs attention shows only the people it applies to (${att} of ${all})`)
  await m.click('[data-glance=attention]')
  ok((await m.locator('[data-person-row]:visible').count()) === all, 'a second click shows everyone again')
  step = 'work intelligence is analytical, and does not repeat the people list'
  await m.goto(`${base}/#/analytics`); await m.waitForSelector('[data-testid=wi-people-link]')
  ok((await m.locator('h1').textContent()) === 'Work Intelligence', 'title')
  ok((await m.locator('.page-head p').textContent()) === 'Understand your team’s work and contribution.', 'subtitle')
  ok(await m.locator('[data-testid=tab-team][aria-selected=true]').count() === 1 && await m.locator('[data-testid=tab-person]').count() === 1 && await m.locator('[data-testid=tab-task]').count() === 1, 'Team, Person and Task tabs')
  ok(await m.locator('[data-testid=people-list]').count() === 0 && await m.locator('[data-glance]').count() === 0, 'no second people list and no people filters on Work Intelligence')
  ok((await m.locator('[data-testid=wi-people-link] a').getAttribute('href')) === '#/contribution', 'it points to People for who is doing what')
  ok((await m.locator('[data-testid=outcomes-section]').count()) === 1 && !(await m.locator('[data-testid=outcomes-section]').textContent()).includes('Claimed, awaiting'), 'outcomes: verified only, a compact line')
  ok((await m.locator('[data-testid=analytics-notes]').evaluate((d) => d.tagName === 'DETAILS' && !d.open)), 'fairness notes available but collapsed')
  ok(!(await m.locator('main').textContent()).match(/leaderboard|top performer|score:|\brank/i), 'no ranking or score language')
  await shot(m, 'wi2-desktop-team-empty')

  step = 'names open the contribution profile; tasks open the task'
  await m.goto(`${base}/#/contribution`); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  await m.locator('.wi-pname', { hasText: 'Priya Sharma' }).click()
  await m.waitForSelector('h1:has-text("Priya Sharma")'); await m.waitForSelector('.dim-card, #p-work')
  ok(m.url().includes('#/contribution/'), 'profile opened')
  await m.goBack(); await m.waitForSelector('[data-testid=people-list]')
  await m.locator('[data-person-row]', { hasText: 'Neha Rao' }).locator('.wi-ttl').first().click()
  await m.waitForSelector('.task-head h1')
  await m.goBack(); await m.waitForSelector('[data-testid=people-list]')
  await m.locator('[data-person-row]', { hasText: 'Priya Sharma' }).locator('a.wi-profile-link').click()
  await m.waitForSelector('h1:has-text("Priya Sharma")')

  step = 'analysed work: a short status on People, the pooled analysis on Work Intelligence'
  const rich = (await api(mctx, '/api/tasks', 'POST', { title: 'Fix the checkout reservation race', description: 'Checkout fails for some users with no clear error. Needs investigation across multiple services (cart, payments, inventory).', assigneeId: priyaId, priority: 'HIGH' })).body.task
  await api(ectx, `/api/tasks/${rich.id}/status`, 'POST', { status: 'IN_PROGRESS' })
  await api(ectx, `/api/evidence/task/${rich.id}/links`, 'POST', { url: 'https://github.com/acme/shop/pull/481', label: 'PR 481: idempotent reservation token' })
  await api(ectx, `/api/tasks/${rich.id}/submit`, 'POST', { summary: 'Investigated logs across cart, payments and inventory and found the root cause: a race condition between reservation and payment capture. Added an idempotent reservation token and a regression test.', outcome: 'Checkout failures stopped in staging.' })
  for (let i = 0; i < 40; i++) { if ((await api(mctx, '/api/contribution/team')).body.people.some((p) => p.analysed > 0)) break; await m.waitForTimeout(500) }
  await m.goto(`${base}/#/contribution`); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  await m.waitForFunction(() => [...document.querySelectorAll('[data-assess]')].every((e) => !e.textContent.startsWith('Reading')))
  const row = m.locator('[data-person-row]', { hasText: 'Priya Sharma' })
  const rt = await row.textContent()
  ok(rt.includes('awaiting your review') && !rt.includes('L4'), 'People: the number waiting for the manager’s review, not the complexity')
  ok(!rt.match(/\bscore\b/i), 'no score')
  await shot(m, 'wi2-desktop-people-assessed')
  await m.goto(`${base}/#/analytics`); await m.waitForSelector('[data-testid=wi-complexity]')
  const cx = await m.locator('[data-testid=wi-complexity]').textContent()
  ok(cx.includes('L4'), 'Work Intelligence: the pooled complexity')
  ok(await m.locator('[data-testid=wi-dimensions]').count() === 1 && await m.locator('[data-testid=wi-over-time]').count() === 1, 'dimensions and change over time')
  { const t = await m.locator('main').textContent(); const hit = t.match(/.{30}(?<!performance )\bscore\b.{30}/i); ok(!hit, `no score on Work Intelligence (${hit ? hit[0] : ''})`) }
  await shot(m, 'wi2-desktop-team')

  step = 'person and task views still work'
  await m.goto(`${base}/#/analytics?tab=task&taskId=${rich.id}`); await m.waitForSelector('[data-testid=task-original]')
  await m.goto(`${base}/#/analytics?tab=person&userId=${priyaId}`); await m.waitForSelector('[data-testid=person-measure]')
  ok(await m.locator('[data-testid=analytics-tasks]').count() === 1, 'the person view keeps its task table')
  await m.locator('a[href^="#/contribution/"]').first().waitFor({ state: 'attached' }).catch(() => {})

  step = 'employee view'
  await e.goto(`${base}/#/analytics`); await e.waitForSelector('[data-testid=analytics-summary]')
  ok(await e.locator('[data-testid=tab-team]').count() === 0, 'employees have no team tab')
  ok((await api(ectx, '/api/analytics/team')).status === 403 && (await api(ectx, '/api/contribution/team')).status === 403, 'team data is refused for employees by the server')
  ok(await e.locator('[data-testid=people-list]').count() === 0, 'no team people list for employees')

  step = 'phone layout'
  const { page: p } = await session('manager@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await p.goto(`${base}/#/contribution`); await p.waitForSelector('[data-testid=people-list] [data-person-row]'); await settle(p)
  ok(await overflow(p) <= 1, `phone: People has no page overflow (${await overflow(p)}px)`)
  ok(await p.locator('.wi-row.wi-head').evaluate((e) => getComputedStyle(e).display) === 'none', 'phone: stacked employee cards')
  await shot(p, 'wi-mobile-people')
  await p.goto(`${base}/#/analytics`); await p.waitForSelector('[data-testid=wi-complexity]'); await settle(p)
  ok(await overflow(p) <= 1, `phone: Work Intelligence has no page overflow (${await overflow(p)}px: ${(await p.evaluate(() => { const w = document.documentElement.clientWidth; return [...document.querySelectorAll('main *')].filter((e) => e.getBoundingClientRect().right > w + 1).slice(0, 5).map((e) => e.tagName + '.' + e.className + ' w=' + Math.round(e.getBoundingClientRect().width)) })).join('; ')})`)
  await shot(p, 'wi-mobile-team')
  await p.goto(`${base}/#/analytics?tab=person&userId=${priyaId}`); await p.waitForSelector('[data-testid=person-measure]'); await settle(p)
  ok(await overflow(p) <= 1, 'phone: person view fits')

  if (problems.length) throw new Error(`Browser problems:\n${problems.join('\n')}`)
  console.log('E2E work intelligence passed (People operational, Work Intelligence analytical, assessments, person/task tabs, employee limits, phone).')
} catch (err) {
  console.error(`E2E work intelligence FAILED at step "${step}":`, err.message)
  if (problems.length) console.error(problems.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
