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
