// Browser checks for the new navigation (Phase 0 words, Phase 1 structure): four places per role, sub-links, combined Reviews badge, the phone's tab bar,
// the managers' "My workspace" menu, window titles, and that EVERY existing route still opens (nothing was removed). Disposable DATA_DIR with demo data.
// Usage: npm run test:e2e:nav   (SCREENSHOTS=<dir> keeps screenshots)
/* global document, window, location */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-nav-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 4500 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', CRON_SECRET: 'e2e-secret' }
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
const shot = async (page, name) => { if (shots) { await page.evaluate(() => window.scrollTo(0, 0)); await page.screenshot({ path: join(shots, `${name}.png`), fullPage: false }) } }
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
  await page.waitForSelector('main h1, .wb-col')
  return { page, ctx }
}
const go = async (page, hash) => { await page.goto(`${base}/${hash}`); await page.waitForSelector('main h1, main .card h1, .wb-col'); await page.waitForTimeout(150) }
const tops = (page) => page.locator('#nav > .nav-group:not(.nav-section ~ .nav-group) > .nav-top').allTextContents().then((a) => a.map((t) => t.replace(/\s*\d+\s*$/, '').trim()))
const current = (page) => page.locator('#nav a[aria-current="page"]').allTextContents().then((a) => a.map((t) => t.replace(/\s*\d+\s*$/, '').trim()))
const OLD = /Team Intelligence|Review Queue|Contribution Reviews|Contribution Journeys|Analyse My Day|Manager Copilot|Outcomes|Automation Center|Work Analytics|My Overview/

try {
  // ---------------- manager ----------------
  step = 'manager navigation'
  const { page: m } = await session('manager@demo.teampulse')
  ok((await tops(m)).join('|') === 'Team Overview|Workboard|People|Reviews|Work Intelligence', `five places: ${await tops(m)}`)
  ok(await m.evaluate(() => document.documentElement.dataset.theme) === 'dark', 'dark is the default for a new user')
  ok((await m.locator('#nav .nav-section').allTextContents()).join('|') === 'Tools', 'one Tools group')
  ok((await m.locator('#nav .nav-section ~ .nav-group a').allTextContents()).map((t) => t.replace(/\s*\d+\s*$/, '').trim()).join('|') === 'Task requests|Ask about your team|Work from Slack|Connected apps|Reports', 'tools: Task requests is its own destination')
  ok(!OLD.test(await m.locator('#nav').textContent()), 'no old names in the sidebar')
  ok((await current(m)).join('|') === 'Team Overview', 'Team Overview is the manager’s home')
  await go(m, '#/workboard')
  ok((await current(m)).join('|') === 'Workboard', 'Workboard is its own destination')
  ok((await m.locator('#nav .nav-group.open .nav-sub a').allTextContents()).join('|') === 'Team tasks', 'its sub-link is open')
  ok(await m.locator('#nav .nav-group:has(.nav-top:text("Reviews")) .nav-sub').isHidden(), 'Reviews sub-links are folded away until you are in Reviews')
  await shot(m, 'nav-manager-workboard')

  await go(m, '#/review')
  ok((await m.locator('#nav .nav-group.open .nav-sub a').allTextContents()).map((t) => t.replace(/\s*\d+\s*$/, '').trim()).join('|') === 'Priorities and deadlines|Assessments to confirm|Contributions to verify|Evidence to resolve', 'Reviews opens to its four places, including Evidence to resolve; Task requests is not one of them')
  ok((await current(m)).join('|') === 'Priorities and deadlines', 'the page you are on is marked')
  const badge = Number((await m.locator('#nav .nav-top:has-text("Reviews") .count').textContent().catch(() => '0')) || 0)
  const parts = await m.locator('#nav .nav-sub .count').allTextContents()
  ok(badge === parts.reduce((n, t) => n + Number(t), 0) && badge >= 1, `the Reviews badge is the sum of its parts (${badge} = ${parts})`)
  ok((await m.evaluate(() => document.title)) === 'Priorities and deadlines · KONVO', `window title follows the page (${await m.evaluate(() => document.title)})`)
  await shot(m, 'nav-manager-reviews')
  await go(m, '#/requests'); ok((await current(m)).join('|') === 'Task requests', 'Task requests is marked on its own'); ok(await m.locator('#nav .nav-group.open:has(.nav-top:text("Reviews"))').count() === 0, 'and the Reviews group is not opened for it')
  await go(m, '#/impact?view=team&status=PENDING'); ok((await current(m)).join('|') === 'Contributions to verify', 'Contributions to verify is marked')
  await go(m, '#/contribution?tab=review'); ok((await current(m)).join('|') === 'Evidence to resolve', 'Evidence to resolve is marked and sits in Reviews')
  ok((await m.locator('main h1').first().textContent()) === 'Evidence to resolve', 'and the page says so')
  await go(m, '#/contribution'); ok((await current(m)).join('|') === 'People', 'People')
  await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  const peopleText = await m.locator('main').textContent()
  ok((await m.locator('main h1').first().textContent()) === 'People' && !/Team intelligence|Team Intelligence|\bYour people\b/.test(peopleText), `Team Intelligence is merged into People: one people list, no old name (h1 ${JSON.stringify(await m.locator("main h1").first().textContent())}; ${peopleText.slice(Math.max(0, peopleText.search(/Team intelligence|Team Intelligence|\bYour people\b/) - 30), peopleText.search(/Team intelligence|Team Intelligence|\bYour people\b/) + 60)})`)
  ok(await m.locator('.wi-pname').count() >= 3 && await m.locator('a.wi-profile-link').first().getAttribute('href').then((h) => !h.includes('from=')), 'each person opens their profile and the way back is People')
  await go(m, '#/impact?view=team'); ok((await current(m)).join('|') === 'Contributions', 'a person’s contributions list sits under People')
  await go(m, '#/analytics'); ok((await current(m)).join('|') === 'Work Intelligence', 'Work Intelligence')

  step = 'Team Overview and Workboard are separate pages'
  await go(m, '#/dashboard')
  await m.waitForSelector('[data-testid=overview-glance]')
  ok((await m.locator('main h1').first().textContent()) === 'Team Overview', 'Team Overview page')
  ok(!(await m.locator('.wb-col').count()), 'the board is not on the overview')
  ok((await m.locator('.wi-sec h2').allTextContents()).join('|') === 'Needs attention|Waiting for you', 'needs attention and waiting for you')
  ok((await m.locator('.wi-g').allTextContents()).map((t) => t.replace(/^[\d,]+\s*/, '')).join('|') === 'In progress|Completed|Needs attention', 'three inline metrics')
  ok(await m.locator('[data-testid=needs-attention] li').count() >= 1, 'real tasks that need attention, from existing data')
  ok(await m.locator('[data-testid=needs-attention] a[href^="#/tasks/"]').count() >= 1, 'each opens its task')
  ok(await m.locator('[data-testid=waiting-for-you] li').count() >= 1, 'what waits for the manager, from the same counts as the navigation')
  await m.waitForSelector('.wb-contrib')
  ok(await m.locator('.wb-contrib a[href="#/analytics"]').count() === 1, 'the contributions strip is on the overview')
  await shot(m, 'nav-manager-overview')
  await m.click('a:has-text("Open the Workboard")'); await m.waitForSelector('.wb-col')
  ok(!(await m.locator('.wb-contrib').count()), 'the strip is not on the Workboard')
  await go(m, '#/workboard?kpi=ATTENTION'); await m.waitForSelector('.wb-col'); ok((await m.locator('.wb-attn-line[aria-pressed="true"]').count()) === 1, 'the overview’s Needs attention link opens the Workboard with that filter')
  await go(m, '#/workboard?kpi=COMPLETED'); await m.waitForSelector('.wb-col'); ok((await m.locator('.wb-metric[data-kpi="COMPLETED"][aria-pressed="true"]').count()) === 1, 'and Completed does too')
  await go(m, '#/analytics'); ok(await m.locator('[data-testid=people-list]').count() === 1, 'Work Intelligence stays a separate detailed area with its own tabs')
  ok(await m.locator('[data-testid=tab-team]').count() === 1 && await m.locator('[data-testid=tab-person]').count() === 1 && await m.locator('[data-testid=tab-task]').count() === 1, 'Team, Person and Task tabs')

  step = 'manager: My workspace menu'
  await m.click('#profile-btn')
  ok((await m.locator('#profile-menu .menu-label').first().textContent()) === 'My workspace', 'the manager’s own work is in the profile menu')
  ok((await m.locator('#profile-menu a.menu-item').allTextContents()).map((t) => t.trim()).join('|') === 'My tasks|My contributions|My work evidence|Prepare my day|Profile|Settings', 'its links')
  await m.click('#profile-menu a:has-text("My tasks")'); await m.waitForSelector('h1:has-text("My tasks")')

  step = 'manager: every existing route still opens'
  for (const h of ['#/dashboard', '#/workboard', '#/my-tasks', '#/team-tasks', '#/slack-intake', '#/requests', '#/impact', '#/impact?view=mine', '#/contribution', '#/evidence', '#/assistant', '#/contributions', '#/reviews', '#/review', '#/analytics', '#/copilot', '#/automations', '#/alerts', '#/reports', '#/settings/profile', '#/settings/members']) {
    await go(m, h)
    ok(!(await m.locator('main .notice.err').count()), `${h} opens without an error`)
    ok(await overflow(m) <= 1, `${h} fits`)
  }

  // ---------------- employee ----------------
  step = 'employee navigation'
  const { page: e } = await session('priya@demo.teampulse')
  ok((await tops(e)).join('|') === 'My Workspace|My Tasks|My Contributions|My Profile', `four places: ${await tops(e)}`)
  ok(!(await e.locator('#nav .nav-section').count()), 'no extra groups')
  ok(!OLD.test(await e.locator('#nav').textContent()), 'no old names')
  ok((await e.locator('#nav .nav-group.open .nav-sub a').allTextContents()).join('|') === 'Prepare my day', 'My Workspace opens to Prepare my day')
  await shot(e, 'nav-employee-workspace')
  const expect = [['#/my-tasks', 'My Tasks'], ['#/requests', 'Task requests'], ['#/my-contributions', 'My Contributions'], ['#/impact', 'Other contributions'], ['#/contributions', 'Journeys'], ['#/analytics', 'My progress'], ['#/settings/profile', 'My Profile'], ['#/automations', 'Connected apps'], ['#/evidence', 'My work evidence'], ['#/assistant', 'Prepare my day']]
  for (const [h, label] of expect) { await go(e, h); ok((await current(e)).join('|') === label, `${h} is marked as ${label} (${await current(e)})`) }
  const me = (await (await e.context().request.fetch(`${base}/api/session`)).json()).user.id
  await go(e, `#/contribution/${me}`); ok((await current(e)).join('|') === 'My contribution', 'my contribution profile is marked')
  ok((await e.locator('h1').textContent()) === 'My contribution', 'its title')
  await go(e, '#/impact'); await e.click('#nav a:has-text("My Contributions")')
  ok((await e.locator('#nav .nav-group.open .nav-sub a').allTextContents()).join('|') === 'Journeys|My contribution|My progress|Other contributions', 'My Contributions opens to its four places')
  await e.click('#profile-btn')
  ok(!(await e.locator('#profile-menu .menu-label:has-text("My workspace")').count()), 'employees have no extra menu: it is already their navigation')
  await e.keyboard.press('Escape')
  step = 'employee: every route opens, manager-only pages stay closed'
  for (const h of ['#/dashboard', '#/my-tasks', '#/requests', '#/impact', '#/contributions', '#/analytics', '#/settings/profile', '#/automations', '#/evidence', '#/assistant', '#/alerts']) {
    await go(e, h); ok(!(await e.locator('main .notice.err').count()), `${h} opens`); ok(await overflow(e) <= 1, `${h} fits`)
  }
  for (const h of ['#/team-tasks', '#/reports', '#/copilot', '#/slack-intake']) { await go(e, h); ok((await e.locator('main h1').first().textContent()).includes('is for managers') || (await e.locator('main h1').first().textContent()).includes('are for managers'), `${h} is closed to employees with a clear message`) }
  await go(e, '#/reviews'); await e.waitForFunction(() => location.hash === '#/dashboard'); ok(true, '#/reviews sends employees home')

  // ---------------- phone ----------------
  step = 'phone tab bars'
  const { page: pm } = await session('manager@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  ok((await pm.locator('.tabbar a span').allTextContents()).join('|') === 'Overview|Workboard|People|Reviews', 'manager tab bar')
  await go(pm, '#/review'); ok(await pm.locator('.tabbar a[aria-current="page"] span').textContent() === 'Reviews', 'the Reviews tab is marked for any page inside Reviews')
  await go(pm, '#/contribution'); ok(await pm.locator('.tabbar a[aria-current="page"] span').textContent() === 'People', 'People tab')
  ok(await overflow(pm) <= 1, 'phone: no overflow'); await shot(pm, 'nav-manager-phone')
  await pm.click('#more-toggle'); await pm.waitForSelector('.shell.nav-open'); await pm.waitForTimeout(600); await shot(pm, 'nav-manager-phone-drawer')
  ok((await tops(pm)).length === 5, 'the drawer shows the same five places')
  const { page: pe } = await session('priya@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  ok((await pe.locator('.tabbar a span').allTextContents()).join('|') === 'Workspace|Tasks|Contributions|Profile', 'employee tab bar')
  await go(pe, '#/contributions'); ok(await pe.locator('.tabbar a[aria-current="page"] span').textContent() === 'Contributions', 'Journeys belongs to the Contributions tab')
  ok(await overflow(pe) <= 1, 'phone: no overflow'); await shot(pe, 'nav-employee-phone')

  if (problems.length) throw new Error(`Browser problems:\n${problems.join('\n')}`)
  console.log('E2E navigation structure passed (five places for managers, four for employees, sub-links, Reviews badge, titles, phone tab bars, every route still opens).')
} catch (err) {
  console.error(`E2E navigation structure FAILED at step "${step}":`, err.message)
  if (problems.length) console.error(problems.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
