// Browser journeys for the AI contribution analysis (employee and manager). Runs the real server with
// AI_PROVIDER=mock — the SIMULATED development analyser, not AI — so the full UI can be exercised without a key.
// It proves the screens, the flows and the guardrail-backed data; it says nothing about the quality of a real model.
// Usage: npm run test:e2e:measurement   (SCREENSHOTS=<dir> to keep screenshots)
/* global document */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-ai-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 4100 + Math.floor(Math.random() * 90)
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', AI_PROVIDER: 'mock' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })

const browser = await chromium.launch()
const problems = []
let step = ''
let current = null
const ok = (cond, msg) => { if (!cond) throw new Error(`Check failed: ${msg}`) }
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }) }
async function session(email, viewport = { width: 1366, height: 900 }) {
  const ctx = await browser.newContext({ viewport })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => problems.push(`[${email}] ${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|net::|status of 4\d\d|status of 503/.test(m.text())) problems.push(`[${email}] ${step}: console ${m.text()}`) })
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', email)
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  current = page
  return page
}
const post = (page, path, body) => page.request.post(base + path, { data: body, headers: { 'X-Requested-With': 'TeamPulse' } })
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)

try {
  step = 'manager creates complex work for Priya'
  const m = await session('manager@demo.teampulse')
  const members = await (await m.request.get(`${base}/api/members`)).json()
  const priyaId = members.find((x) => x.name === 'Priya Sharma').userId
  const c = await post(m, '/api/tasks', { title: 'Fix intermittent checkout failures', description: 'Checkout fails for some users with no clear error. Needs investigation across multiple services (cart, payments, inventory).', priority: 'HIGH', assigneeId: priyaId, expectedOutcome: 'Checkout failures stop.' })
  ok(c.status() === 201, `task created (${c.status()})`)
  const taskId = (await c.json()).task.id

  step = 'employee works and submits'
  const e = await session('priya@demo.teampulse')
  await e.goto(`${base}/#/tasks/${taskId}`)
  await e.waitForSelector('#ai-card')
  ok(await e.isVisible('text=Analyse my work'), 'employee sees "Analyse my work"')
  await e.click('button[data-act="start"]')
  await e.waitForSelector('button[data-act="submit"]')
  ok((await post(e, `/api/evidence/task/${taskId}/links`, { url: 'https://github.com/acme/shop/pull/481', label: 'PR 481: idempotent reservation token' })).ok(), 'evidence link')
  await e.reload(); await e.waitForSelector('button[data-act="submit"]')
  await e.click('button[data-act="submit"]')
  await e.fill('#s-s', 'Investigated logs across cart, payments and inventory and found the root cause: a race condition between reservation and payment capture. Added an idempotent reservation token and a regression test.')
  await e.fill('#s-o', 'Checkout failures stopped in staging.')
  await e.click('#f button[type=submit]')

  step = 'analysis appears automatically (simulated)'
  await e.waitForSelector('#ai-card table.dims', { timeout: 20000 })
  ok(await e.isVisible('#ai-card >> text=Simulated — development only, not AI'), 'simulated badge shown')
  ok(await e.isVisible('#ai-card >> text=What KONVO understood'), 'understanding shown')
  for (const t of ['Complexity', 'Impact', 'Quality', 'Ownership', 'Problem-solving', 'Collaboration']) ok(await e.isVisible(`#ai-card table.dims >> text=${t}`), `dimension ${t}`)
  for (const t of ['Claimed', 'AI-estimated', 'Evidence-supported', 'Manager-verified']) ok(await e.isVisible(`#ai-card .impact-grid >> text=${t}`), `impact column ${t}`)
  ok(await e.isVisible('#ai-card >> text=L4 · Highly complex'), 'complexity L4 with corroborating evidence')
  ok(await e.isVisible('#ai-card a.chip:has-text("PR 481")'), 'evidence used is linked')
  await shot(e, 'm1-employee-analysis')

  step = 'employee proposes a correction'
  await e.click('#ai-card button[data-emp="PROPOSE_CORRECTION"]')
  await e.selectOption('#lv-d', 'collaboration'); await e.selectOption('#lv-l', '4')
  await e.fill('#fb-c', 'I paired with Dev on the payments side for two days.')
  await e.click('#f button[type=submit]')
  await e.waitForSelector('#ai-card >> text=Employee proposed a correction')

  step = 'manager reviews: sees the proposal, adjusts with a reason'
  await m.goto(`${base}/#/tasks/${taskId}`)
  await m.waitForSelector('#ai-card table.dims')
  await m.click('#ai-card button[data-mgr="ADJUST"]')
  ok(await m.isVisible('text=suggested Collaboration 4'), 'manager sees the employee\'s suggestion')
  await m.selectOption('#lv-d', 'collaboration'); await m.selectOption('#lv-l', '4')
  await m.fill('#mg-c', 'Confirmed with Dev: the pairing unblocked the payments fix.')
  await m.click('#f button[type=submit]')
  await m.waitForSelector('#ai-card >> text=Adjusted by a manager')
  ok(await m.isVisible('#ai-card >> text=Confirmed with Dev'), 'adjustment reason shown')
  await shot(m, 'm2-manager-adjusted')

  step = 'manager: team overview and profile'
  await m.goto(`${base}/#/contribution`)
  await m.waitForSelector('h1:has-text("Team intelligence")')
  ok(await m.isVisible('text=Not a ranking'), 'not-a-ranking note')
  const names = await m.$$eval('table tbody tr td:first-child b', (els) => els.map((x) => x.textContent))
  ok(JSON.stringify(names) === JSON.stringify([...names].sort((a, b) => a.localeCompare(b))), `alphabetical: ${names.join(', ')}`)
  await shot(m, 'm3-team')
  await m.click('table >> a:has-text("Priya Sharma")')
  await m.waitForSelector('h2:has-text("In short")')
  ok(await m.isVisible('text=1× L4'), 'complexity mix in profile')
  await shot(m, 'm4-profile')
  await m.goto(`${base}/#/dashboard`)
  await m.waitForSelector('.wb-col')

  step = 'employee sees own profile, not the team'
  await e.goto(`${base}/#/contribution`)
  await e.waitForSelector('h1:has-text("My contribution")')

  step = 'phone width'
  const p = await session('manager@demo.teampulse', { width: 390, height: 844 })
  await p.goto(`${base}/#/tasks/${taskId}`); await p.waitForSelector('#ai-card table.dims')
  ok(await overflow(p) <= 1, `task page with analysis fits a phone (${await overflow(p)}px)`)
  await shot(p, 'm5-phone-task')
  await p.goto(`${base}/#/contribution/${priyaId}`); await p.waitForSelector('h2:has-text("In short")')
  ok(await overflow(p) <= 1, `profile fits a phone (${await overflow(p)}px)`)
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
  if (current) problems.push(`page (${current.url()}): ${(await current.innerText('body').catch(() => '')).slice(0, 500)}`)
} finally {
  await browser.close(); server.kill()
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log('E2E contribution-analysis journeys passed (simulated analyser, not a real AI model).')
