// Browser journey for the contribution record (Playwright, Chromium): an employee records a short contribution, attaches evidence, corrects it after
// a manager's review; the manager sees it on the contribution profile and in Work Intelligence and verifies it. Claimed is never shown as verified.
// Disposable DATA_DIR with demo data (never ./data). Usage: npm run test:e2e:contributions   (SCREENSHOTS=<dir> keeps screenshots)
/* global document, window */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-cr-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 4300 + Math.floor(Math.random() * 90)
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
const settle = (page) => page.waitForLoadState('networkidle').then(() => page.waitForTimeout(200))
const stageOf = (page) => page.locator('.page-head .badge').first().textContent()

try {
  const { page: e, ctx: ectx } = await session('priya@demo.teampulse')
  const { page: m, ctx: mctx } = await session('manager@demo.teampulse')
  const priyaId = (await (await mctx.request.fetch(`${base}/api/assignable`)).json()).find((p) => p.name === 'Priya Sharma').userId

  step = 'employee records a short contribution'
  await e.goto(`${base}/#/impact`); await e.waitForSelector('#new-impact')
  ok((await e.locator('#new-impact').textContent()) === 'Record a contribution', 'the button says Record a contribution')
  await e.click('#new-impact'); await e.waitForSelector('#imp')
  ok(await e.locator('#i-p[required], #i-w[required], #i-r[required]').count() === 0, 'the three descriptions are optional: a short record is fine')
  ok(await e.getByText('Records are not points').count() === 1, 'the form says records are not points')
  ok(await e.locator('#i-c').inputValue() === '', 'no category is chosen for the person')
  await e.fill('#i-t', 'Stopped the double-charge race at checkout')
  await e.selectOption('#i-c', 'RELIABILITY')
  await e.fill('#i-w', 'Found the reservation race in the payment capture path and added an idempotent token')
  await shot(e, 'cr-employee-form', false)
  await e.click('#imp button[type=submit]')
  await e.waitForSelector('h1:has-text("Stopped the double-charge race at checkout")')
  ok((await stageOf(e)) === 'Claimed', `a new record is Claimed (${await stageOf(e)})`)
  ok((await e.locator('main').textContent()).includes('Not described'), 'what was not written says so, nothing is invented')
  ok((await e.locator('main').textContent()).includes('does not mean nothing was contributed'), 'missing evidence is not treated as no contribution')
  ok(await e.locator('#verify').count() === 0, 'the contributor has no Verify button')

  step = 'the same contribution is not recorded twice'
  await e.goto(`${base}/#/impact`); await e.click('#new-impact'); await e.waitForSelector('#imp')
  await e.fill('#i-t', 'stopped the double-charge race at checkout'); await e.selectOption('#i-c', 'RELIABILITY'); await e.fill('#i-w', 'Again')
  await e.click('#imp button[type=submit]')
  await e.waitForSelector('.form-error .notice')
  ok((await e.locator('.form-error').textContent()).includes('already recorded'), 'a duplicate is refused with a clear reason')
  await e.click('[data-close]')

  step = 'evidence makes it Supported, not Verified'
  await e.locator('main a', { hasText: 'Stopped the double-charge race at checkout' }).first().click()
  await e.waitForSelector('#add-link')
  await e.click('#add-link'); await e.fill('#l-u', 'https://github.com/acme/shop/pull/481'); await e.fill('#l-l', 'PR 481'); await e.click('.modal button[type=submit], #f button[type=submit]')
  await e.waitForFunction(() => document.querySelector('.page-head .badge')?.textContent === 'Supported')
  ok(!(await e.locator('main').textContent()).includes('Manager verified'), 'not verified')

  step = 'manager sees it on the profile and in Work Intelligence'
  await m.goto(`${base}/#/contribution/${priyaId}`); await m.waitForSelector('#p-contrib li')
  const row = m.locator('#p-contrib li', { hasText: 'Stopped the double-charge race' })
  ok((await row.textContent()).includes('Supported') && (await row.textContent()).includes('1 evidence'), 'profile: stage and evidence count')
  ok(!(await row.textContent()).includes('Verified'), 'profile: a claim is not shown as verified')
  ok((await m.locator('.sec-h').textContent()) === 'Assessment', 'the profile reads contributions, then assessment')
  await shot(m, 'cr-manager-profile')
  await m.goto(`${base}/#/analytics`); await m.waitForSelector('[data-testid=people-list] [data-person-row]')
  await m.waitForFunction(() => document.querySelector('.wi-contrib'))
  const wi = await m.locator('[data-person-row]', { hasText: 'Priya Sharma' }).textContent()
  ok(wi.includes('Stopped the double-charge race') && wi.includes('Supported') && wi.includes('awaiting your review'), 'Work Intelligence: the contribution, its stage and that it awaits review')
  ok(!(await m.locator('[data-testid=outcomes-section]').textContent()).includes('Stopped the double-charge race'), 'Team outcomes lists verified outcomes only')
  await shot(m, 'cr-manager-team')

  step = 'manager reviews: not verified, with a reason; the employee corrects it'
  await m.locator('.wi-contrib a', { hasText: 'Stopped the double-charge race' }).click(); await m.waitForSelector('#verify')
  await m.click('#reject'); await m.fill('#cf-reason', 'The PR does not show the load test result'); await m.click('#cf-ok')
  await m.waitForFunction(() => document.querySelector('.page-head .badge')?.textContent === 'Reviewed')
  await e.reload(); await e.waitForSelector('.notice.err')
  ok((await e.locator('.notice.err').textContent()).includes('The PR does not show the load test result'), 'the employee sees why')
  await e.click('#edit'); await e.waitForSelector('#imp'); await e.fill('#i-r', 'No double charges across three load-test runs (see PR 481)'); await e.click('#imp button[type=submit]')
  await e.waitForFunction(() => document.querySelector('.page-head .badge')?.textContent === 'Supported')

  step = 'manager verifies; only then it is Verified and a team outcome'
  await m.reload(); await m.waitForSelector('#verify'); await m.click('#verify'); await m.click('#cf-ok')
  await m.waitForFunction(() => document.querySelector('.page-head .badge')?.textContent === 'Verified')
  await m.goto(`${base}/#/analytics`); await m.waitForSelector('[data-testid=outcomes-section] .wi-outcomes li')
  ok((await m.locator('[data-testid=outcomes-section]').textContent()).includes('Stopped the double-charge race'), 'now a verified team outcome')
  await e.goto(`${base}/#/contribution/${(await (await ectx.request.fetch(`${base}/api/session`)).json()).user.id}`); await e.waitForSelector('#p-contrib li')
  ok((await e.locator('#p-contrib').textContent()).includes('Verified') && await e.locator('#p-record').count() === 1, 'the employee sees it verified on their own profile, with a way to record another')
  await shot(e, 'cr-employee-profile')

  step = 'phone'
  const { page: p } = await session('priya@demo.teampulse', { viewport: { width: 390, height: 844 }, mobile: true })
  await p.goto(`${base}/#/contribution/${(await (await ectx.request.fetch(`${base}/api/session`)).json()).user.id}`); await p.waitForSelector('#p-contrib li'); await settle(p)
  ok(await overflow(p) <= 1, `phone: profile fits (${await overflow(p)}px)`)
  await shot(p, 'cr-mobile-profile')
  await p.click('#p-record'); await p.waitForSelector('#imp'); await settle(p)
  ok(await overflow(p) <= 1, 'phone: the form fits')
  await shot(p, 'cr-mobile-form', false)
  await p.click('[data-close]')
  await p.goto(`${base}/#/impact`); await p.waitForSelector('.card h3'); await settle(p)
  ok(await overflow(p) <= 1, 'phone: the list fits')

  if (problems.length) throw new Error(`Browser problems:\n${problems.join('\n')}`)
  console.log('E2E contributions passed (record, duplicate guard, supported, reviewed with reason, correction, verified, profile, Work Intelligence, phone).')
} catch (err) {
  console.error(`E2E contributions FAILED at step "${step}":`, err.message)
  if (problems.length) console.error(problems.join('\n'))
  process.exitCode = 1
} finally {
  await browser.close()
  server.kill()
}
