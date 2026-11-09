// Browser journeys for email/password sign-in. Mail goes through the real SMTP code path (nodemailer) to a LOCAL SMTP
// sink started here. This proves the flows, the forms and the links — not delivery by a real email provider.
// Usage: npm run test:e2e:auth   (SCREENSHOTS=<dir> to keep screenshots)
/* global document */
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

// ---- minimal SMTP sink ----
const inbox = []
const smtp = createServer((sock) => {
  let buf = ''; let inData = false; let rcpt = []
  sock.write('220 sink ESMTP\r\n')
  sock.on('data', (d) => {
    buf += d.toString('utf8')
    for (;;) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n'); if (end < 0) return
        const raw = buf.slice(0, end); buf = buf.slice(end + 5); inData = false
        const body = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
        inbox.push({ to: rcpt.map((r) => r.toLowerCase()), subject: (raw.match(/^Subject: (.*)$/m) || [])[1], body })
        rcpt = []; sock.write('250 queued\r\n'); continue
      }
      const nl = buf.indexOf('\r\n'); if (nl < 0) return
      const line = buf.slice(0, nl); buf = buf.slice(nl + 2)
      const cmd = line.slice(0, 4).toUpperCase()
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-sink\r\n250 8BITMIME\r\n')
      else if (cmd === 'RCPT') { rcpt.push(line.match(/<([^>]+)>/)[1]); sock.write('250 ok\r\n') }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n') }
      else if (cmd === 'QUIT') { sock.end('221 bye\r\n') }
      else sock.write('250 ok\r\n')
    }
  })
  sock.on('error', () => {})
})
const smtpPort = await new Promise((r) => smtp.listen(0, '127.0.0.1', () => r(smtp.address().port)))
const link = (to, kind) => { const m = [...inbox].reverse().find((x) => x.to.includes(to) && x.body.includes(`/#/${kind}/`)); return m && m.body.match(new RegExp(`(http://[^\\s"<]+/#/${kind}/[A-Za-z0-9_-]+)`))[1] }

const dataDir = mkdtempSync(join(tmpdir(), 'teampulse-e2e-auth-'))
const shots = process.env.SCREENSHOTS || null
if (shots) mkdirSync(shots, { recursive: true })
const port = 3990 + Math.floor(Math.random() * 9)
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', APP_URL: base,
  MAIL_PROVIDER: 'smtp', MAIL_FROM: 'no-reply@teampulse.test', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtpPort), SMTP_SECURE: 'false',
  GOOGLE_CLIENT_ID: 'e2e-placeholder.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'e2e-placeholder' }
for (const k of ['SMTP_USER', 'SMTP_PASS', 'DEV_LOGIN']) delete env[k]
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })

const browser = await chromium.launch()
const problems = []
let step = ''
const ok = (cond, msg) => { if (!cond) throw new Error(`Check failed: ${msg}`) }
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`), fullPage: true }) }
const waitMail = async (to, kind) => { for (let i = 0; i < 50; i++) { const l = link(to, kind); if (l) return l; await new Promise((r) => setTimeout(r, 100)) } throw new Error(`no ${kind} email for ${to}`) }
let current = null
const EMAIL = 'ada@e2e.test'; const PW = 'Copper-Kettle-2026!'; const PW2 = 'Silver-Kettle-2027!'

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  current = page
  page.on('pageerror', (e) => problems.push(`${step}: page error ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon|embed\.viasocket|net::|status of 4\d\d/.test(m.text())) problems.push(`${step}: console ${m.text()}`) })

  step = 'login page'
  await page.goto(base)
  await page.waitForSelector('#pw-login')
  for (const t of ['Continue with Google', 'Forgot password?', 'Create account']) ok(await page.isVisible(`text=${t}`), `login shows "${t}"`)
  ok(await page.isVisible('#li-email') && await page.isVisible('#li-pw') && await page.isVisible('#pw-login button:has-text("Sign in")'), 'email, password, Sign in')
  await shot(page, 'a1-login')

  step = 'register (validation)'
  await page.click('text=Create account')
  await page.waitForSelector('#su')
  ok(await page.isVisible('#su >> text=I agree to the terms'), 'terms checkbox'); ok(await page.isVisible('text=Continue with Google'), 'Google on sign-up')
  await page.fill('#su-name', 'Ada Lovelace'); await page.fill('#su-email', EMAIL); await page.fill('#su-pw', 'short'); await page.fill('#su-pw2', 'short')
  await page.check('input[name=acceptTerms]')
  await page.click('#su button[type=submit]')
  await page.waitForSelector('#su .notice.err')
  step = 'register'
  await page.fill('#su-pw', PW); await page.fill('#su-pw2', PW)
  await shot(page, 'a2-signup')
  await page.click('#su button[type=submit]')
  await page.waitForSelector('text=If this email can be used')
  await shot(page, 'a3-signup-sent')

  step = 'login before verifying'
  await page.goto(`${base}/#/login`); await page.waitForSelector('#pw-login')
  await page.fill('#li-email', EMAIL); await page.fill('#li-pw', PW); await page.click('#pw-login button[type=submit]')
  await page.waitForSelector('text=Confirm your email first')

  step = 'verify'
  await page.goto(await waitMail(EMAIL, 'verify'))
  await page.fill('#vf-pw', 'Wrong-Kettle-0000!'); await page.click('#vf button[type=submit]')
  await page.waitForSelector('text=not the password chosen')
  await page.fill('#vf-pw', PW); await page.click('#vf button[type=submit]')
  await page.waitForSelector('text=Welcome, Ada Lovelace')
  ok(await page.isVisible('text=create a new organization'), 'no automatic role; normal onboarding')
  await page.fill('#org', 'Engine Works'); await page.click('#create button[type=submit]')
  await page.waitForSelector('#nav')

  step = 'sign-in methods + change password'
  await page.goto(`${base}/#/settings/profile`); await page.waitForSelector('#chpw', { timeout: 5000 }).catch(async (e) => { console.log(await page.innerText('#main')); throw e })
  await shot(page, 'a4-signin-methods')
  await page.click('#chpw'); await page.fill('#cp0', PW); await page.fill('#cp1', PW2); await page.fill('#cp2', PW2)
  await page.click('#cpf button[type=submit]'); await page.waitForSelector('text=Password changed')

  step = 'logout + wrong password'
  await page.click('#logout'); await page.waitForSelector('#pw-login')
  await page.fill('#li-email', EMAIL); await page.fill('#li-pw', PW); await page.click('#pw-login button[type=submit]')
  await page.waitForSelector('text=Email or password is incorrect')

  step = 'forgot + reset'
  await page.click('text=Forgot password?'); await page.waitForSelector('#fg')
  await page.fill('#fg-email', EMAIL); await page.click('#fg button[type=submit]')
  await page.waitForSelector('text=If this email can be used')
  const resetUrl = await waitMail(EMAIL, 'reset')
  await page.goto(resetUrl); await page.waitForSelector('#rs')
  await page.fill('#rs-pw', PW); await page.fill('#rs-pw2', PW); await page.click('#rs button[type=submit]')
  await page.waitForSelector('#nav')
  ok(await page.isVisible('text=Engine Works'), 'same organization after reset')

  step = 'reused reset link'
  await page.goto(resetUrl); await page.waitForSelector('text=not valid or was already used')
  await shot(page, 'a5-reset-used')

  step = 'login with new password; phone width'
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const p = await phone.newPage()
  await p.goto(base); await p.waitForSelector('#pw-login')
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  ok(overflow <= 1, `login fits a phone (overflow ${overflow}px)`)
  await p.fill('#li-email', EMAIL); await p.fill('#li-pw', PW); await p.click('#pw-login button[type=submit]')
  await p.waitForSelector('#nav-toggle')
  await shot(p, 'a6-phone-signed-in')
  ok(inbox.every((m) => !m.body.includes(PW) && !m.body.includes(PW2)), 'no password in any email')
} catch (err) {
  problems.unshift(`FAILED at "${step}": ${err.message}`)
  if (current) problems.push(`page at failure (${current.url()}): ${(await current.innerText('body').catch(() => '')).slice(0, 600)}`)
} finally {
  await browser.close(); server.kill(); smtp.close()
}
if (problems.length) { console.error(problems.join('\n')); process.exit(1) }
console.log(`E2E auth journeys passed (${inbox.length} emails through the local SMTP sink).`)
