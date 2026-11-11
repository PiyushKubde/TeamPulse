// Evaluation runner for the AI Work Measurement Engine.
//
// Replays every case of eval/dataset.json into a fresh IN-MEMORY TeamPulse (never a real database), builds the
// evidence pack with the production code, asks the provider, then scores the raw model output AND the output after
// the deterministic guardrails against the case's draft expectations.
//
//   node scripts/eval-measurement.mjs --dry-run                       build packs, check the dataset; no model calls
//   node scripts/eval-measurement.mjs --provider=simulated            exercise the harness with the dev simulator
//   node scripts/eval-measurement.mjs --provider=viasocket --confirm-live [--no-backup]   viaSocket AI (+ Anthropic backup if key set)
//   AI_PROVIDER=anthropic ANTHROPIC_API_KEY=… \
//   node scripts/eval-measurement.mjs --provider=anthropic --repeats=3 --confirm-live   real model (costs money)
//
// Options: --cases=id1,id2  --repeats=N (default 1; 3+ to measure consistency)  --out=path.json
// The report says "agreement with draft expectations": the reference answers are not human-reviewed, so nothing here
// is an accuracy claim. Ticket counts are not measured.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, now, uuid } from '../server/db.js'
import { createApp } from '../server/app.js'
import { loadConfig } from '../server/config.js'
import { createSession, COOKIE } from '../server/auth/sessions.js'
import { upsertGoogleUser } from '../server/auth/google.js'
import { createOrganization } from '../server/services/orgs.js'
import { createM91Transport } from '../server/integrations/m91.js'
import { createAiProvider } from '../server/ai/provider.js'
import { createViasocketGateway } from '../server/integrations/viasocket.js'
import { buildEvidencePack, isInsufficient } from '../server/measurement/evidence-pack.js'
import { OUTPUT_SCHEMA, validateOutput } from '../server/measurement/schema.js'
import { applyGuardrails, insufficientAssessment, GUARDRAIL_VERSION } from '../server/measurement/guardrails.js'
import { systemPrompt, userPrompt, PROMPT_VERSION } from '../server/measurement/engine.js'
import { rubricFor } from '../server/measurement/rubric.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true] }))
const dataset = JSON.parse(readFileSync(join(ROOT, 'eval/dataset.json'), 'utf8'))
const cases = args.cases ? dataset.cases.filter((c) => String(args.cases).split(',').includes(c.id)) : dataset.cases
const repeats = Math.max(1, Number(args.repeats) || 1)
const dry = Boolean(args['dry-run'])
const providerName = dry ? null : String(args.provider || 'simulated')

// ---------- provider ----------
let provider = null
if (!dry) {
  if (providerName === 'anthropic') {
    if (!args['confirm-live']) { console.error('Refusing to call the live API without --confirm-live (it costs money and sends the fictional dataset to Anthropic).'); process.exit(2) }
    provider = createAiProvider(loadConfig({ ai: { provider: 'anthropic', apiKey: process.env.ANTHROPIC_API_KEY || '', model: process.env.AI_MODEL || 'claude-opus-5-5', effort: process.env.AI_EFFORT || 'medium', timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 120000, fallbacks: process.env.AI_FALLBACKS !== 'off' }, production: true }))
  } else if (providerName === 'viasocket') {
    if (!args['confirm-live']) { console.error('Refusing to call viaSocket AI without --confirm-live (it sends the fictional dataset to viaSocket, which stores each call as a thread).'); process.exit(2) }
    const vs = createViasocketGateway({ orgId: process.env.VIASOCKET_ORG_ID, projectId: process.env.VIASOCKET_PROJECT_ID, secret: process.env.VIASOCKET_EMBED_SECRET })
    provider = createAiProvider(loadConfig({ ai: { provider: 'viasocket', viasocketPolicyConfirmed: true /* fictional dataset only — never real employee data */, viasocketService: process.env.AI_VIASOCKET_SERVICE || 'anthropic', viasocketModel: process.env.AI_VIASOCKET_MODEL || 'claude-sonnet-5-5', apiKey: args['no-backup'] ? '' : process.env.ANTHROPIC_API_KEY || '', timeoutMs: Number(process.env.AI_TIMEOUT_MS) || 120000 }, production: true }), { vs })
  } else if (providerName === 'simulated') {
    provider = createAiProvider({ production: false, ai: { provider: 'mock' } })
  } else { console.error(`Unknown --provider=${providerName}`); process.exit(2) }
  if (!provider.configured) { console.error(`Provider not configured: ${provider.reason}`); process.exit(2) }
}

// ---------- an isolated in-memory TeamPulse ----------
const db = openDatabase(':memory:')
const cfg = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'tp-eval-')), devLogin: false, appUrl: 'https://teampulse.eval', ai: { mode: 'off' } })
const app = createApp({ db, cfg, vs: { configured: false }, m91: createM91Transport({}), listen: false, ai: { configured: false, name: null, model: null, reason: 'eval harness' } })
const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)) })
const base = `http://127.0.0.1:${server.address().port}`
function person(name, email) { const u = upsertGoogleUser(db, { sub: `eval:${email}`, email, emailVerified: true, name }); return { ...u, cookie: `${COOKIE}=${createSession(db, u.id).token}` } }
const admin = person('Avery Admin', 'admin@northwind.eval')
const org = createOrganization(db, admin, { name: 'Northwind Freight', teamName: 'Leadership' })
const mgr = person('Sam Okafor', 'sam@northwind.eval')
const emp = person('Alex Rivera', 'alex@northwind.eval')
const peer = person('Jordan Lee', 'jordan@northwind.eval')
const team = uuid()
db.prepare('INSERT INTO teams (id, org_id, name, manager_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(team, org.id, 'Operations Engineering', mgr.id, now(), now())
for (const [u, role] of [[mgr, 'manager'], [emp, 'employee'], [peer, 'employee']]) db.prepare(`INSERT INTO memberships (id, org_id, user_id, role, team_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`).run(uuid(), org.id, u.id, role, team, now(), now())
const who = { emp, mgr, peer }
async function call(path, as, body, method = body === undefined ? 'GET' : 'POST') {
  const res = await fetch(base + path, { method, headers: { cookie: as.cookie, ...(body !== undefined ? { 'Content-Type': 'application/json', 'X-Requested-With': 'TeamPulse' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined })
  const json = await res.json().catch(() => null)
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${JSON.stringify(json)}`)
  return json
}

async function replay(c) {
  const t = await call('/api/tasks', mgr, { title: c.task.title, description: c.task.description ?? undefined, expectedOutcome: c.task.expectedOutcome ?? undefined, priority: c.task.priority, assigneeId: emp.id })
  const id = t.task.id
  for (const st of c.steps) {
    const as = who[st.as]
    switch (st.do) {
      case 'start': await call(`/api/tasks/${id}/status`, as, { status: 'IN_PROGRESS' }); break
      case 'progress': await call(`/api/tasks/${id}/progress`, as, { progress: st.progress, note: st.note }); break
      case 'comment': await call(`/api/tasks/${id}/comments`, as, { body: st.body }); break
      case 'link': await call(`/api/evidence/task/${id}/links`, as, { url: st.url, label: st.label }); break
      case 'blocker': await call(`/api/tasks/${id}/blockers`, as, { description: st.description, dependencyNote: st.dependency, isExternal: Boolean(st.external) }); break
      case 'escalate': { const b = db.prepare(`SELECT id FROM blockers WHERE task_id = ? ORDER BY reported_at DESC`).get(id); await call(`/api/blockers/${b.id}/escalate`, as, {}); break }
      case 'submit': await call(`/api/tasks/${id}/submit`, as, { summary: st.summary, outcome: st.outcome, evidenceLinks: st.links || [] }); break
      case 'review': await call(`/api/tasks/${id}/review`, as, { decision: st.decision, comment: st.comment }); break
      case 'reopen': await call(`/api/tasks/${id}/status`, as, { status: 'IN_PROGRESS', reason: st.reason }); break
      case 'impact': {
        const r = await call('/api/impact', as, { taskId: id, ...st.impact })
        if (st.verify) await call(`/api/impact/${r.id}/verification`, mgr, { decision: 'VERIFIED' })
        break
      }
      case 'sharedOutcome': {
        const t2 = await call('/api/tasks', mgr, { title: st.title, description: 'Shared part of the same outcome.', assigneeId: as.id })
        await call(`/api/tasks/${t2.task.id}/status`, as, { status: 'IN_PROGRESS' })
        await call(`/api/tasks/${t2.task.id}/submit`, as, { summary: st.impact.workPerformed, outcome: st.impact.result })
        await call(`/api/tasks/${t2.task.id}/review`, mgr, { decision: 'APPROVED' })
        const r = await call('/api/impact', as, { taskId: t2.task.id, ...st.impact })
        await call(`/api/impact/${r.id}/verification`, mgr, { decision: 'VERIFIED' })
        break
      }
      default: throw new Error(`Unknown step ${st.do} in ${c.id}`)
    }
  }
  return db.prepare('SELECT * FROM tasks WHERE id = ?').get(id)
}

// ---------- scoring ----------
const LEVEL = { L1: 1, L2: 2, L3: 3, L4: 4 }
function dimCheck(exp, d) {
  if (exp.state) return d.state === exp.state
  if (exp.range) return d.state === 'assessed' && d.level >= exp.range[0] && d.level <= exp.range[1]
  if (exp.max !== undefined) return d.state !== 'assessed' || d.level <= exp.max
  return true
}
// Normalise raw model output and guarded output into one shape: { complexity:{state,level}, dims:{k:{state,level}} }
const fromRaw = (o) => ({
  complexity: { state: o.complexity.state, level: o.complexity.state === 'assessed' ? LEVEL[o.complexity.level] ?? null : null },
  dims: Object.fromEntries(Object.entries(o.dimensions).map(([k, d]) => [k, { state: d.state, level: d.state === 'assessed' ? d.level : null }]))
})
const fromGuarded = (g) => ({ complexity: { state: g.complexity.state, level: g.complexity.level }, dims: Object.fromEntries(Object.entries(g.dimensions).map(([k, d]) => [k, { state: d.state, level: d.level }])) })
function expectationChecks(c, shape) {
  const e = c.expected
  const checks = []
  if (e.complexity === 'insufficient') checks.push(['complexity', shape.complexity.state === 'insufficient_evidence'])
  else if (e.complexity) checks.push(['complexity', shape.complexity.state === 'assessed' && e.complexity.map((x) => LEVEL[x]).includes(shape.complexity.level)])
  for (const [k, exp] of Object.entries(e.dimensions || {})) {
    if (k === '_all') { if (exp.notAll5) checks.push(['not all 5', !Object.values(shape.dims).every((d) => d.level === 5)]); continue }
    checks.push([k, dimCheck(exp, shape.dims[k])])
  }
  return checks
}
function textOf(o) {
  return [o.understanding, o.contribution_summary, o.complexity.reason, ...Object.values(o.dimensions).map((d) => d.reason), ...o.estimated_outcomes.map((x) => x.description), o.blocker_note, o.shared_contribution_note].join('\n')
}

// ---------- run ----------
const results = []
console.log(`Dataset ${dataset.version}: ${cases.length} case(s) · ${dry ? 'DRY RUN (no model calls)' : `provider ${provider.name} · model ${provider.model} · ${repeats} repeat(s)`} · prompt ${PROMPT_VERSION} · ${GUARDRAIL_VERSION}`)
console.log(dataset.referenceStatus)
for (const c of cases) {
  const task = await replay(c)
  const { pack, facts } = buildEvidencePack(db, task, emp.id)
  const insufficient = isInsufficient(facts)
  const row = { id: c.id, category: c.category, packBytes: Buffer.byteLength(JSON.stringify(pack)), items: pack.items.length, insufficient, insufficientExpected: Boolean(c.expected.insufficient), runs: [] }
  if (dry) { results.push(row); console.log(`  ${c.id.padEnd(32)} items ${String(pack.items.length).padStart(2)} · ${row.packBytes} B · ${insufficient ? 'insufficient → rules' : 'would call the model'}${insufficient !== row.insufficientExpected ? '  ⚠ differs from expectation' : ''}`); continue }
  for (let r = 0; r < repeats; r++) {
    const run = { repeat: r + 1 }
    if (insufficient) {
      const g = insufficientAssessment(facts, task)
      Object.assign(run, { modelCalled: false, schemaValid: null, guarded: expectationChecks(c, fromGuarded(g)), impactBasis: g.impact.basis, missing: g.missing, notes: g.notes })
    } else {
      const started = Date.now()
      try {
        const res = await provider.generate({ system: systemPrompt(rubricFor(db, org.id)), user: userPrompt(pack), schema: OUTPUT_SCHEMA, validate: validateOutput, context: { orgId: 'eval', runId: `${c.id}-${r}` } })
        run.modelCalled = true; run.model = res.model; run.answeredBy = res.provider || provider.name; run.fallback = res.fallback?.used || false; run.usage = res.usage; run.latencyMs = Date.now() - started
        try { validateOutput(structuredClone(res.output)); run.schemaValid = true } catch (error) { run.schemaValid = false; run.schemaError = error.message }
        if (run.schemaValid) {
          const raw = res.output
          const cited = [raw.complexity, ...Object.values(raw.dimensions)].flatMap((d) => d.evidence_refs).concat(raw.estimated_outcomes.flatMap((x) => x.basis_refs))
          run.citations = { total: cited.length, invalid: cited.filter((x) => !(x in facts.refs)).length }
          run.raw = expectationChecks(c, fromRaw(raw))
          run.rawComplexity = raw.complexity.level
          run.rawLevels = Object.fromEntries(Object.entries(raw.dimensions).map(([k, d]) => [k, d.state === 'assessed' ? d.level : d.state]))
          const text = textOf(raw)
          run.unsupportedClaims = (c.expected.mustNotAssume || []).filter((p) => new RegExp(p, 'i').test(text))
          run.missingDetectedByModel = (c.expected.missing || []).map((group) => raw.missing_information.some((m) => group.some((k) => m.toLowerCase().includes(k)))).filter(Boolean).length
          run.missingExpected = (c.expected.missing || []).length
          run.sharedMentioned = c.expected.shared ? /shared|jordan|another|other contributor|team/i.test(`${raw.shared_contribution_note} ${raw.dimensions.impact.reason}`) : null
          const g = applyGuardrails(structuredClone(raw), { pack, facts, task })
          run.guarded = expectationChecks(c, fromGuarded(g))
          run.guardedComplexity = g.complexity.level ? `L${g.complexity.level}` : g.complexity.state
          run.impactBasis = g.impact.basis
          run.sharedFlag = c.expected.shared ? g.impact.verified.some((v) => v.shared) : null
          run.notes = g.notes
          run.fixedByGuardrails = run.raw.filter(([, ok], i) => !ok && run.guarded[i]?.[1]).map(([k]) => k)
          run.brokenByGuardrails = run.raw.filter(([, ok], i) => ok && run.guarded[i] && !run.guarded[i][1]).map(([k]) => k)
        }
      } catch (error) { run.modelCalled = true; run.error = `${error.code || 'error'}: ${error.message}` }
    }
    run.impactBasisOk = c.expected.impactBasis ? run.impactBasis === c.expected.impactBasis : null
    row.runs.push(run)
  }
  // Consistency across repeats (model output before guardrails).
  const comps = row.runs.map((x) => x.rawComplexity).filter(Boolean)
  if (comps.length > 1) {
    const counts = comps.reduce((m, x) => ({ ...m, [x]: (m[x] || 0) + 1 }), {})
    row.consistency = { complexityAgreement: Math.max(...Object.values(counts)) / comps.length, complexityValues: counts }
    const spread = {}
    for (const k of Object.keys(row.runs[0].rawLevels || {})) {
      const lv = row.runs.map((x) => x.rawLevels?.[k]).filter((x) => typeof x === 'number')
      spread[k] = lv.length ? Math.max(...lv) - Math.min(...lv) : null
    }
    row.consistency.levelSpread = spread
  }
  results.push(row)
  const ok = (list) => (list ? `${list.filter(([, v]) => v).length}/${list.length}` : '–')
  const last = row.runs.at(-1)
  console.log(`  ${c.id.padEnd(32)} ${last.error ? `ERROR ${last.error}` : `${last.modelCalled ? `raw ${ok(last.raw)} → guarded ${ok(last.guarded)}` : `rules ${ok(last.guarded)}`}${last.unsupportedClaims?.length ? ` · unsupported: ${last.unsupportedClaims.join(' | ')}` : ''}${last.citations?.invalid ? ` · invalid refs ${last.citations.invalid}` : ''}`}`)
}

// ---------- summary ----------
const runs = results.flatMap((r) => r.runs.map((x) => ({ ...x, id: r.id })))
const called = runs.filter((x) => x.modelCalled && !x.error)
const sum = (f) => called.reduce((n, x) => n + f(x), 0)
const pass = (list) => list.filter(([, v]) => v).length
const summary = dry ? { cases: results.length, insufficientAsExpected: results.filter((r) => r.insufficient === r.insufficientExpected).length } : {
  cases: results.length, runs: runs.length, modelCalls: called.length + runs.filter((x) => x.error).length, errors: runs.filter((x) => x.error).length,
  schemaValidRate: called.length ? sum((x) => (x.schemaValid ? 1 : 0)) / called.length : null,
  citationValidity: sum((x) => x.citations?.total || 0) ? 1 - sum((x) => x.citations?.invalid || 0) / sum((x) => x.citations?.total || 0) : null,
  expectationAgreementRaw: `${sum((x) => (x.raw ? pass(x.raw) : 0))}/${sum((x) => x.raw?.length || 0)}`,
  expectationAgreementGuarded: `${runs.reduce((n, x) => n + (x.guarded ? pass(x.guarded) : 0), 0)}/${runs.reduce((n, x) => n + (x.guarded?.length || 0), 0)}`,
  complexityInRangeRaw: `${sum((x) => (x.raw?.find(([k]) => k === 'complexity')?.[1] ? 1 : 0))}/${called.length}`,
  unsupportedClaimRuns: called.filter((x) => x.unsupportedClaims?.length).length,
  missingEvidenceDetectedByModel: `${sum((x) => x.missingDetectedByModel || 0)}/${sum((x) => x.missingExpected || 0)}`,
  sharedAttributionMentionedByModel: `${called.filter((x) => x.sharedMentioned === true).length}/${called.filter((x) => x.sharedMentioned !== null && x.sharedMentioned !== undefined).length}`,
  guardrailsFixed: sum((x) => x.fixedByGuardrails?.length || 0), guardrailsBroke: sum((x) => x.brokenByGuardrails?.length || 0),
  impactBasisCorrect: `${runs.filter((x) => x.impactBasisOk).length}/${runs.filter((x) => x.impactBasisOk !== null).length}`,
  fallbacks: called.filter((x) => x.fallback).length,
  answeredBy: called.reduce((m, x) => ({ ...m, [x.answeredBy]: (m[x.answeredBy] || 0) + 1 }), {}),
  tokens: { input: sum((x) => x.usage?.input_tokens || 0), output: sum((x) => x.usage?.output_tokens || 0) }
}
const report = {
  dataset: dataset.version, referenceStatus: dataset.referenceStatus, generatedAt: new Date().toISOString(),
  provider: dry ? null : { name: provider.name, model: provider.model, simulated: Boolean(provider.simulated) }, promptVersion: PROMPT_VERSION, guardrailVersion: GUARDRAIL_VERSION, repeats,
  disclaimer: 'Agreement with DRAFT expectations that no human has reviewed. Not an accuracy measure.' + (provider?.simulated ? ' SIMULATED provider: these numbers say nothing about a real model.' : ''),
  summary, cases: results
}
console.log('\nSummary:', JSON.stringify(summary, null, 2))
console.log(report.disclaimer)
const out = args.out || (dry ? null : join(ROOT, 'eval/results', `${new Date().toISOString().replace(/[:.]/g, '-')}-${provider.name}.json`))
if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(report, null, 2)); console.log(`Report: ${out}`) }
server.close(); db.close()
