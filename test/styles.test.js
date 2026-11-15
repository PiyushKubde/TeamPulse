import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import http from 'node:http'

const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const rules = [...css.matchAll(/(^|\})\s*([^{}@][^{}]*)\{([^{}]*)\}/g)].map((m) => ({ selector: m[2].trim(), body: m[3] }))

test('no selector nests :root inside :root (such a rule can never match)', () => {
  const bad = rules.filter((r) => /:root[^,{]*\s+:root/.test(r.selector))
  assert.deepEqual(bad.map((r) => r.selector), [])
})

test('the Advanced Builder container has a definite, responsive height, a border and a surface', () => {
  const base = rules.find((r) => r.selector === '#embed-box')
  assert.ok(base, 'a plain #embed-box rule exists')
  // The embed script sizes its wrapper at height:100% of this element (min 320px) and its iframe at 100% of that wrapper, so without a definite
  // height the iframe falls back to 150px and the wrapper's white background shows below it.
  assert.match(base.body, /height:\s*clamp\(/)
  assert.match(base.body, /border:\s*1px solid/)
  assert.match(base.body, /background:\s*var\(--surface\)/)
  assert.ok(css.includes('@media (max-width: 640px)') && /#embed-box\s*\{\s*height:\s*clamp\(/.test(css.slice(css.indexOf('@media (max-width: 640px)'))), 'phones get a definite height too')
})

// A plain HTTP request, as a browser revalidates (Node's fetch adds a cache-control request header of its own, which makes the server skip the 304).
const conditionalStatus = (base, path, etag) => new Promise((resolve, reject) => { http.get(new URL(path, base), { headers: { 'If-None-Match': etag } }, (res) => { res.resume(); resolve(res.statusCode) }).on('error', reject) })

test('the page, scripts and stylesheet are revalidated on every load, so a deploy reaches everyone at once', async () => {
  const { startApp } = await import('./helpers.js')
  const t = await startApp({ cfgOverrides: { production: true } })
  try {
    for (const path of ['/', '/index.html', '/styles.css', '/js/app.js', '/js/views/automations.js']) {
      const res = await fetch(`${t.base}${path}`)
      assert.equal(res.status, 200, path)
      assert.equal(res.headers.get('cache-control'), 'no-cache', `${path} must be revalidated, not cached for an hour`)
      const etag = res.headers.get('etag')
      assert.ok(etag, `${path} has an ETag, so an unchanged file costs a 304`)
      assert.equal(await conditionalStatus(t.base, path, etag), 304, `${path} answers a conditional request with 304`)
    }
  } finally { await t.close() }
})

// ---------- Periwinkle palette tokens ----------
const lum = (hex) => { const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b }
const contrast = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05) }
const block = (sel) => { const i = css.indexOf(sel + ' {'); return i < 0 ? '' : css.slice(css.indexOf('{', i) + 1, css.indexOf('}', i)) }
const tok = (body, name) => body.match(new RegExp('(?:^|[\\s;])' + name + ':\\s*(#[0-9A-Fa-f]{6})'))?.[1]?.toUpperCase()
const light = () => block(':root, :root[data-theme="light"]'); const dark = () => block(':root[data-theme="dark"]')

test('the four brand colours are the foundation: Midnight Slate and Soft White pages, Periwinkle accent, dark by default', () => {
  assert.equal(tok(dark(), '--bg'), '#1B2430'); assert.equal(tok(light(), '--bg'), '#EEF1F5')
  assert.equal(tok(dark(), '--text'), '#EEF1F5'); assert.equal(tok(light(), '--text'), '#1B2430')
  assert.equal(tok(dark(), '--accent'), '#B8C0FF'); assert.equal(tok(light(), '--periwinkle'), '#B8C0FF'); assert.equal(tok(light(), '--blue-grey'), '#8A94A6')
  assert.equal(tok(dark(), '--accent-ink'), '#1B2430', 'dark: Midnight Slate ink on Periwinkle')
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')
  assert.match(html, /getItem\('tp-theme'\) \|\| 'dark'/, 'dark is the default theme'); assert.match(html, /var pref = 'dark'/)
})

test('Periwinkle is readable: ink on Periwinkle in dark, white on a darker periwinkle and blue text on the page in light', () => {
  assert.ok(contrast(tok(dark(), '--accent'), tok(dark(), '--accent-ink')) >= 7, 'dark: ink on the accent')
  assert.ok(contrast(tok(dark(), '--accent'), tok(dark(), '--surface')) >= 7, 'dark: accent on a surface')
  assert.ok(contrast(tok(dark(), '--text-3'), tok(dark(), '--surface-hover')) >= 4.5, 'dark: supporting text on a hovered surface')
  assert.ok(contrast(tok(light(), '--accent'), tok(light(), '--accent-ink')) >= 4.5, 'light: white text on the accent')
  assert.ok(contrast(tok(light(), '--accent'), tok(light(), '--bg')) >= 4.5, 'light: the accent as a line or text on the page')
  assert.ok(contrast(tok(light(), '--brand-ink'), tok(light(), '--bg')) >= 4.5, 'light: link text on the page')
  assert.ok(contrast(tok(light(), '--text-3'), tok(light(), '--surface-sunken')) >= 4.5, 'light: supporting text on a sunken surface')
  for (const bg of ['--surface', '--bg', '--surface-2', '--surface-hover', '--surface-sunken']) assert.ok(contrast(tok(light(), '--text-4'), tok(light(), bg)) >= 4.5, `light: the faintest text tier on ${bg}`)
  for (const bg of ['--bg', '--surface', '--surface-2', '--surface-hover', '--elevated']) assert.ok(contrast(tok(dark(), '--text-4'), tok(dark(), bg)) >= 4.5, `dark: the faintest text tier on ${bg}`)
  for (const bg of ['--surface', '--surface-hover']) assert.ok(contrast(tok(dark(), '--placeholder'), tok(dark(), bg)) >= 4.5, `dark: placeholder on ${bg}`)
  assert.notEqual(tok(light(), '--accent'), '#B8C0FF', 'light mode never uses raw Periwinkle for text or under white text')
})

test('no earlier palette survives, and colours outside the token blocks come from tokens', () => {
  const raw = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8')
  assert.ok(!/b9f227|electric|lime|A0D2EB|1F6A94|ice blue|lavender|purple/i.test(raw), 'no Electric Lime, Ice Blue, Lavender or Purple')
  const outside = css.replace(light(), '').replace(dark(), '')
  const literals = [...outside.matchAll(/#[0-9A-Fa-f]{6}\b|rgba?\([^)]*\)/g)].map((m) => m[0]).filter((x) => !/^rgba?\(\s*0,\s*0,\s*0,/.test(x))
  assert.deepEqual(literals, [])
})
