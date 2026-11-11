// The evaluation runner keeps working: dataset replays, dry run, scoring path (simulated), and it refuses to call
// the live API without --confirm-live.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const run = (args, env = {}) => spawnSync('node', ['--disable-warning=ExperimentalWarning', 'scripts/eval-measurement.mjs', ...args], { encoding: 'utf8', env: { ...process.env, ...env } })

test('dataset: at least 12 cases, required categories, fictional, draft status stated', () => {
  const d = JSON.parse(readFileSync('eval/dataset.json', 'utf8'))
  assert.ok(d.cases.length >= 12)
  assert.match(d.referenceStatus, /NOT reviewed by a human/)
  for (const c of ['Routine administrative task', 'Simple bug fix', 'Complex API integration', 'Root-cause investigation', 'Difficult production incident', 'Documentation and knowledge sharing', "Task involving another employee's contribution", 'Task delayed by an external blocker', 'Task with failing tests', 'Task with requested rework', 'Task with claimed but unverified business impact', 'Task with insufficient completion evidence'])
    assert.ok(d.cases.some((x) => x.category === c), c)
  for (const c of d.cases) { assert.ok(c.expected, c.id); assert.ok(Array.isArray(c.expected.mustNotAssume), c.id); assert.ok(Array.isArray(c.expected.missing), c.id) }
})

test('dry run replays every case with no model call', () => {
  const r = run(['--dry-run'])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /"insufficientAsExpected": 14/)
})

test('simulated run produces a scored report with the disclaimer', () => {
  const out = join(mkdtempSync(join(tmpdir(), 'tp-evalr-')), 'r.json')
  const r = run(['--provider=simulated', '--repeats=2', '--cases=external-blocker,insufficient-evidence,shared-contribution', `--out=${out}`])
  assert.equal(r.status, 0, r.stderr)
  const rep = JSON.parse(readFileSync(out, 'utf8'))
  assert.match(rep.disclaimer, /not an accuracy measure/i); assert.match(rep.disclaimer, /SIMULATED/)
  assert.equal(rep.summary.schemaValidRate, 1); assert.equal(rep.summary.citationValidity, 1); assert.equal(rep.summary.guardrailsBroke, 0)
  const blocked = rep.cases.find((c) => c.id === 'external-blocker')
  assert.ok(blocked.runs.every((x) => x.guarded.every(([, ok]) => ok)), 'external blocker: guarded output meets every expectation')
  assert.ok(blocked.consistency, 'consistency measured across repeats')
  assert.equal(rep.cases.find((c) => c.id === 'insufficient-evidence').runs[0].modelCalled, false)
  assert.equal(rep.cases.find((c) => c.id === 'shared-contribution').runs[0].sharedFlag, true)
  assert.doesNotMatch(JSON.stringify(rep), /ticket count|tasks completed/i)
})

test('live provider is refused without --confirm-live', () => {
  const r = run(['--provider=anthropic'], { ANTHROPIC_API_KEY: 'sk-ant-test-not-real' })
  assert.equal(r.status, 2); assert.match(r.stderr, /--confirm-live/)
})
