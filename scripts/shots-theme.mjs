// Screenshots of the main screens in light and dark, on disposable demo data (never ./data). Usage: SCREENSHOTS=<dir> node scripts/shots-theme.mjs
/* global document, getComputedStyle */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')
const out = process.env.SCREENSHOTS; if (!out) { console.error('Set SCREENSHOTS=<dir>'); process.exit(2) }
mkdirSync(out, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), 'kv-theme-')); const port = 4900 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development', CRON_SECRET: 'x', AI_PROVIDER: '' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER', 'GEMINI_API_KEY']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
const base = `http://127.0.0.1:${port}`
const browser = await chromium.launch(); const problems = []
const SCREENS = { anon: [['landing', '#/'], ['login', '#/login']], 'admin@demo.teampulse': [['admin', '#/admin'], ['members', '#/settings/members']], 'manager@demo.teampulse': [['manager-overview', '#/dashboard'], ['manager-workboard', '#/workboard'], ['manager-people', '#/contribution'], ['manager-intelligence', '#/analytics']], 'priya@demo.teampulse': [['employee-dashboard', '#/dashboard'], ['employee-tasks', '#/tasks']] }
for (const theme of ['light', 'dark']) {
  for (const [who, list] of Object.entries(SCREENS)) {
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, colorScheme: theme === 'dark' ? 'light' : 'dark' }) // OS scheme opposite to the chosen theme: the choice must win
    await ctx.addInitScript((t) => { try { localStorage.setItem('tp-theme', t) } catch { /* private */ } }, theme)
    const page = await ctx.newPage()
    page.on('pageerror', (e) => problems.push(`${theme} ${who}: ${e.message}`))
    if (who !== 'anon') { await page.goto(`${base}/#/login`); await page.getByText('Local development sign-in').click(); await page.fill('#dev-email', who); await page.click('#dev-login button[type=submit]'); await page.waitForSelector('#nav') }
    for (const [name, hash] of list) {
      await page.goto(`${base}/${hash}`); await page.waitForTimeout(700)
      const t = await page.evaluate(() => ({ theme: document.documentElement.dataset.theme, meta: document.querySelector('meta[name=theme-color]')?.content, bg: getComputedStyle(document.body).backgroundColor }))
      if (t.theme !== theme) problems.push(`${name}: expected ${theme}, got ${t.theme}`)
      if (name === 'members') { await page.click('#new-team'); await page.waitForTimeout(300); await page.screenshot({ path: join(out, `${theme}-modal.png`) }); await page.keyboard.press('Escape') }
      if (name === 'login') { await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.fill('input[type=email]', 'a@b.co'); await page.screenshot({ path: join(out, `${theme}-focus.png`) }) }
      await page.screenshot({ path: join(out, `${theme}-${name}.png`) })
      console.log(theme, name, t.theme, t.meta, t.bg)
    }
    await ctx.close()
  }
}
await browser.close(); server.kill()
console.log(problems.length ? `PROBLEMS:\n${problems.join('\n')}` : 'Screens captured, theme respected on every screen.')
