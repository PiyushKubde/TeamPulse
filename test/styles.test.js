import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

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
