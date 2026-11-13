// Diagnostic for the Advanced Builder tab: mounts the REAL viaSocket embed script inside KONVO's page and measures the container,
// the SDK's wrapper and the iframe at desktop and phone widths. viaSocket's own API is stubbed in the browser (a fake embed token), so no
// credentials, connections or production data are involved; the embed's inner content therefore cannot fully render here and is not judged.
// It checks only what KONVO controls: that the container has a definite, sensible height and the iframe fills it, with no clipping.
// Needs internet access to load https://embed.viasocket.com. Usage: node --disable-warning=ExperimentalWarning scripts/diag-builder.mjs
/* global document, window, location, getComputedStyle */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
const { chromium } = createRequire(import.meta.url)('playwright')

const dataDir = mkdtempSync(join(tmpdir(), 'konvo-diag-builder-'))
if (dataDir.replace(/\\/g, '/') === join(process.cwd(), 'data').replace(/\\/g, '/')) throw new Error('refusing to use the real data directory')
const shots = process.env.SHOTS_DIR || join(tmpdir(), 'konvo-builder-shots')
mkdirSync(shots, { recursive: true })
const port = 4900 + Math.floor(Math.random() * 90)
const env = { ...process.env, DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', DEV_LOGIN: '1', NODE_ENV: 'development' }
for (const k of ['GOOGLE_CLIENT_ID', 'ANTHROPIC_API_KEY', 'MAIL_PROVIDER', 'M91_SEND_LINK', 'M91_API_KEY', 'VIASOCKET_EMBED_SECRET', 'LOCAL_SCHEDULER']) delete env[k]
execFileSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/seed-demo.js'], { env, stdio: 'ignore' })
const server = spawn('node', ['--disable-warning=ExperimentalWarning', 'server/index.js'], { env, stdio: ['ignore', 'pipe', 'inherit'] })
await new Promise((resolve, reject) => { server.stdout.on('data', (d) => String(d).includes('listening') && resolve()); server.on('exit', reject) })
const base = `http://127.0.0.1:${port}`
const browser = await chromium.launch()
const out = []
let failed = false

async function measure(width, height, theme) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme })
  const page = await ctx.newPage()
  const errors = []
  const failedReq = []
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 160)}`) })
  page.on('requestfailed', (r) => failedReq.push(`${r.url().slice(0, 90)} (${r.failure()?.errorText})`))
  // Stub only viaSocket's server-side endpoints; the embed script itself is the real one from the CDN.
  await page.route('**/api/viasocket/connections', async (route) => {
    const res = await route.fetch(); const j = await res.json().catch(() => ({}))
    route.fulfill({ response: res, json: { ...j, configured: true, apps: j.apps || [] } })
  })
  await page.route('**/api/viasocket/token**', (route) => route.fulfill({ json: { token: 'diag-token-not-real', serviceIds: {} } }))
  await page.route('**/api/viasocket/embed-flows', (route) => route.fulfill({ json: [] }))
  // The embed script asks viaSocket to register the token before it points the iframe at the embed. Stubbed here so the wrapper and iframe
  // are laid out exactly as they are in production (the frame then loads viaSocket's own page, which shows its own error for a fake token).
  await page.route('**/users/register', (route) => route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, json: { data: { project_id: 'diag', org: { meta: {} }, config: {} } } }))
  await page.goto(`${base}/#/login`)
  await page.getByText('Local development sign-in').click()
  await page.fill('#dev-email', 'manager@demo.teampulse')
  await page.click('#dev-login button[type=submit]')
  await page.waitForSelector('#nav')
  await page.evaluate(() => { location.hash = '#/automations?tab=builder' })
  await page.waitForSelector('#embed-box iframe', { timeout: 30000 }).catch(() => null)
  await page.waitForTimeout(6000)
  const m = await page.evaluate(() => {
    const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); const cs = getComputedStyle(el); return { w: Math.round(b.width), h: Math.round(b.height), top: Math.round(b.top + window.scrollY), minH: cs.minHeight, height: cs.height, overflow: cs.overflow, bg: cs.backgroundColor, border: cs.borderTopWidth } }
    const box = document.getElementById('embed-box')
    const root = box?.querySelector('[class*="viasocket-embed-parent-container"]')
    const body = box?.querySelector('.vs-embed__body')
    const iframe = box?.querySelector('iframe')
    const loader = box?.querySelector('.viasocket-iframe-loader')
    return { viewportH: window.innerHeight, box: r(box), root: r(root), body: r(body), iframe: r(iframe), loaderShown: loader ? getComputedStyle(loader).display !== 'none' && loader.getBoundingClientRect().height > 0 : null, pageScrollW: document.documentElement.scrollWidth, innerW: window.innerWidth, boxChildren: box ? box.children.length : 0 }
  })
  await page.screenshot({ path: join(shots, `builder-${width}-${theme}.png`), fullPage: true })
  await ctx.close()
  return { m, errors: [...new Set(errors)].slice(0, 6), failedReq: [...new Set(failedReq)].slice(0, 6) }
}

try {
  for (const [w, h, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [390, 844, 'dark']]) {
    const { m, errors, failedReq } = await measure(w, h, theme)
    out.push(`${w}x${h} ${theme}: box ${JSON.stringify(m.box)}\n  root ${JSON.stringify(m.root)}\n  body ${JSON.stringify(m.body)}\n  iframe ${JSON.stringify(m.iframe)}\n  loaderShown=${m.loaderShown} pageOverflowX=${m.pageScrollW - m.innerW}px errors=${JSON.stringify(errors)} failedRequests=${JSON.stringify(failedReq)}`)
    // What KONVO controls: a definite height that is not just the SDK's 320px minimum, and the iframe filling its wrapper.
    const minWanted = w <= 640 ? 480 : 560
    if (!m.box || !m.iframe) { failed = true; out.push('  FAIL: the embed did not mount') } else {
      if (m.box.h < minWanted) { failed = true; out.push(`  FAIL: the container is only ${m.box.h}px tall (want >= ${minWanted}px)`) }
      if (m.iframe.h < m.box.h - 4) { failed = true; out.push(`  FAIL: the iframe (${m.iframe.h}px) does not fill its container (${m.box.h}px)`) }
      if (m.pageScrollW - m.innerW > 1) { failed = true; out.push('  FAIL: the page scrolls sideways') }
      if (m.box.border === '0px') { failed = true; out.push('  FAIL: the container has lost its border and surface (its CSS rule did not apply)') }
    }
  }
} finally {
  await browser.close(); server.kill()
}
console.log(out.join('\n'))
console.log(failed ? '\nBuilder geometry: FAILED' : '\nBuilder geometry: ok (embed content itself not judged)')
console.log(`Screenshots: ${shots}`)
process.exit(failed ? 1 : 0)
