// Navigation races in a real browser: a page that is still loading when the person opens another one must neither throw nor paint
// over the newer page. API responses are delayed on purpose so the race happens every time instead of now and then.
// Starts the app on a temporary DATA_DIR with DEV_LOGIN=1 and demo data. Usage: npm run test:e2e:navigation
/* global document, location */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'konvo-e2e-nav-'))
if (dataDir.replace(/\\/g, '/') === join(process.cwd(), 'data').replace(/\\/g, '/')) throw new Error('refusing to use the real data directory')
const port = 4800 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER', 'M91_SEND_LINK', 'M91_API_KEY', 'VIASOCKET_EMBED_SECRET', 'LOCAL_SCHEDULER']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
const base = `http://127.0.0.1:${port}`
const browser = await chromium.launch()
const problems = []
let step = ''
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const API = /\/api\/(?!session)/
const DELAY_MS = 900

async function open(email) {
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`${step}: page error ${e.message} :: ${String(e.stack).split('\n').slice(1, 3).map((l) => l.replace(/http:\/\/127\.0\.0\.1:\d+/g, '').trim()).join(' | ')}`))
  if (email) {
    await page.goto(`${base}/#/login`)
    await page.getByText('Local development sign-in').click()
    await page.fill('#dev-email', email)
    await page.click('#dev-login button[type=submit]')
    await page.waitForSelector('#nav')
  }
  return page
}
const slow = (page) => page.route(API, async (route) => { await sleep(DELAY_MS); await route.continue().catch(() => {}) })
const fast = (page) => page.unroute(API)
const go = (page, hash) => page.evaluate((h) => { location.hash = h }, hash)
const heading = (page) => page.evaluate(() => document.querySelector('main h1, #root h1')?.textContent?.trim() || '')
async function settle(page) { await page.waitForTimeout(DELAY_MS * 3 + 600) }
/** What the page shows when nothing races it. */
async function alone(page, hash) {
  await go(page, hash)
  await page.waitForFunction(() => document.querySelector('main h1, #root h1'), null, { timeout: 15000 })
  await page.waitForTimeout(DELAY_MS + 600)
  return heading(page)
}

try {
  // 1. The page is replaced by a full-screen page (an email link) while a signed-in page is still loading: no page error.
  const starts = { manager: ['#/dashboard', '#/my-tasks', '#/team-tasks', '#/reports', '#/contribution', '#/reviews', '#/copilot', '#/slack-intake', '#/settings'], employee: ['#/dashboard', '#/my-tasks'] }
  for (const [who, email] of [['manager', 'manager@demo.teampulse'], ['employee', 'priya@demo.teampulse']]) {
    const page = await open(email)
    for (const start of starts[who]) {
      step = `${who}: ${start} replaced by a reset link`
      // Settle on a different page first, so the page under test is opened fresh and is the slow one (the dashboard loads its signals after its data).
      await go(page, start === '#/settings' ? '#/my-tasks' : '#/settings'); await page.waitForTimeout(DELAY_MS + 800)
      await slow(page)
      await go(page, start); await sleep(150)
      await go(page, '#/reset/aaaaaaaaaaaaaaaa')
      await settle(page)
      await fast(page)
      if (!(await page.isVisible('text=not valid or was already used'))) problems.push(`${step}: the reset page was not left showing its result (shows "${await heading(page)}")`)
    }
    await page.context().close()
  }

  // 2. Two signed-in pages: the one opened last stays on screen, however slow the earlier one is.
  const pairs = [['manager', 'manager@demo.teampulse', '#/team-tasks', '#/reports'], ['manager', 'manager@demo.teampulse', '#/reports', '#/team-tasks'], ['manager', 'manager@demo.teampulse', '#/dashboard', '#/reports'],
    ['employee', 'priya@demo.teampulse', '#/dashboard', '#/copilot'], ['employee', 'priya@demo.teampulse', '#/my-tasks', '#/copilot'], ['employee', 'priya@demo.teampulse', '#/dashboard', '#/my-tasks']]
  for (const [who, email, first, second] of pairs) {
    const page = await open(email)
    step = `${who}: ${first} then ${second}`
    const expected = await alone(page, second)
    await go(page, '#/dashboard' === first ? '#/my-tasks' : '#/dashboard'); await page.waitForTimeout(DELAY_MS + 800)
    await slow(page)
    await go(page, first); await sleep(150)
    await go(page, second)
    await settle(page)
    await fast(page)
    const shown = await heading(page)
    if (shown !== expected) problems.push(`${step}: the earlier page painted over the later one (expected "${expected}", found "${shown}")`)
    await page.context().close()
  }

  // 3. Signed out: moving between login, forgot-password and sign-up while the login page is still checking sign-in options.
  for (const [first, second, marker] of [['#/login', '#/forgot', '#fg'], ['#/login', '#/signup', '#su'], ['#/forgot', '#/login', '#pw-login'], ['#/signup', '#/login', '#pw-login']]) {
    const page = await open(null)
    step = `signed out: ${first} then ${second}`
    await slow(page)
    await page.goto(`${base}/${first}`)
    await sleep(120)
    await go(page, second)
    await settle(page)
    await fast(page)
    if (!(await page.isVisible(marker))) problems.push(`${step}: the page that was opened last is not what is on screen (no ${marker})`)
    await page.context().close()
  }
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
} finally {
  await browser.close(); server.kill()
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log('E2E navigation-race journeys passed (delayed responses force the race: no page errors, the last page opened stays on screen).')
