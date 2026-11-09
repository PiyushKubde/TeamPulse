// Deterministic rules applied to every model answer. The model proposes; these rules make sure it cannot:
// cite evidence that does not exist, rate anything without evidence, inflate complexity from labels or the
// employee's own description alone, rate quality above what reviews/regressions show, penalise work held up by
// blockers outside the person's control, call an estimate verified, attribute a shared outcome to one person,
// or invent numbers. Every adjustment is recorded as a note shown to the manager.
import { RATED } from './rubric.js'

const SELF_REPORTED = new Set(['task', 'submission', 'update', 'context'])
const LEVEL_OF = { L1: 1, L2: 2, L3: 3, L4: 4 }

function missingInfo(facts, task) {
  const out = []
  if (!task.description && !task.expected_outcome) out.push('A description of the problem and the expected outcome of the task.')
  if (facts.evidenceItems === 0) out.push('Evidence of the work: a pull request, document, dashboard, test results or a demo link.')
  if (!facts.impacts.length) out.push('An outcome record (Performance & Impact) describing what changed, so impact can be judged and verified.')
  else if (!facts.impacts.some((i) => i.verification === 'VERIFIED')) out.push('Manager verification of the recorded outcome (it is still a claim).')
  if (facts.delivered && !facts.signals.approved) out.push('The manager\'s review of the completion submission.')
  return out
}

/** The assessment when there is not enough to judge anything: produced by rules, no model call. */
export function insufficientAssessment(facts, task) {
  const reason = 'Not enough evidence to judge this: no description, only a short completion note, no attached evidence and no outcome record.'
  return {
    evidenceState: 'insufficient',
    understanding: 'TeamPulse does not have enough information to understand this work yet.',
    summary: 'No assessment possible from the available evidence. This says nothing about the quality of the work — only that it is not documented.',
    complexity: { state: 'insufficient_evidence', level: null, confidence: null, reason, refs: [], source: 'rules' },
    dimensions: Object.fromEntries(RATED.map((k) => [k, { state: 'insufficient_evidence', level: null, confidence: null, reason, refs: [], source: 'rules' }])),
    impact: impactBlock(facts, []),
    missing: missingInfo(facts, task),
    notes: ['Rules: evidence below the minimum, so the AI was not asked (nothing to analyse, nothing guessed).'],
    blockerNote: '', sharedNote: ''
  }
}

function impactBlock(facts, estimated) {
  const view = (i) => ({ ref: i.ref, impactId: i.id, title: i.title, category: i.category, valueType: i.valueType, value: i.valueType === 'NONE' ? null : i.value, unit: i.unit, verification: i.verification, shared: i.others.length > 0, otherContributors: i.others })
  return {
    claimed: [...facts.claims.map((c) => ({ ref: c.ref, text: c.text, source: 'completion submission' })), ...facts.impacts.filter((i) => i.verification !== 'VERIFIED' && i.evidenceCount === 0).map(view)],
    estimated,
    evidenceSupported: facts.impacts.filter((i) => i.verification === 'PENDING' && i.evidenceCount > 0).map(view),
    verified: facts.impacts.filter((i) => i.verification === 'VERIFIED').map(view)
  }
}

export function applyGuardrails(output, { pack, facts, task }) {
  const notes = []
  const known = new Set(Object.keys(facts.refs))
  const kindOf = (ref) => facts.refs[ref]?.kind
  const packText = JSON.stringify(pack)
  const cleanRefs = (list, where) => {
    const ok = [...new Set(list.filter((r) => known.has(r)))]
    const bad = list.filter((r) => !known.has(r))
    if (bad.length) notes.push(`Removed ${bad.length} reference(s) the AI cited that do not exist in the evidence (${where}).`)
    return ok
  }
  const lower = (d, max, why) => {
    if (d.state === 'assessed' && d.level > max) { notes.push(why); d.level = max; d.confidence = Math.min(d.confidence ?? 1, 0.5); d.reason = `${d.reason} [Adjusted by TeamPulse rules: ${why}]` }
  }

  // Complexity
  const c = output.complexity
  const complexity = { state: c.state, level: c.state === 'assessed' ? LEVEL_OF[c.level] ?? null : null, confidence: c.confidence, reason: c.reason, refs: cleanRefs(c.evidence_refs, 'complexity'), source: 'ai' }
  if (complexity.state === 'assessed' && (!complexity.level || !complexity.refs.length)) {
    notes.push('Complexity had no valid supporting evidence, so it is marked insufficient.')
    Object.assign(complexity, { state: 'insufficient_evidence', level: null })
  }
  if (complexity.state === 'assessed') {
    const workRefs = complexity.refs.filter((r) => kindOf(r) !== 'task')
    const corroborating = complexity.refs.filter((r) => !SELF_REPORTED.has(kindOf(r)))
    if (complexity.level >= 3 && !workRefs.length) lower(complexity, 2, 'L3+ needs evidence from the work itself; a title or priority label is not enough.')
    else if (complexity.level === 4 && !corroborating.length) lower(complexity, 3, 'L4 needs corroboration beyond the employee\'s own description (evidence, a review, a blocker, an outcome record).')
  }
  if (complexity.state !== 'assessed') complexity.level = null

  // Rated dimensions
  const dims = {}
  for (const k of RATED) {
    const d = output.dimensions[k]
    const x = { state: d.state, level: d.state === 'assessed' ? d.level : null, confidence: d.confidence, reason: d.reason, refs: cleanRefs(d.evidence_refs, k), source: 'ai' }
    if (x.state === 'assessed' && (!x.level || !x.refs.length)) {
      notes.push(`${k.replace('_', '-')} had no valid supporting evidence, so it is marked insufficient.`)
      Object.assign(x, { state: 'insufficient_evidence', level: null })
    }
    if (x.state !== 'assessed') x.level = null
    dims[k] = x
  }

  // Quality reflects reviews and regressions, whatever the model said.
  const q = dims.quality
  if (facts.regression) {
    const concernRefs = facts.signals.qualityConcerns.map((x) => x.ref)
    if (q.state === 'assessed') lower(q, 2, 'a regression, reopening or failing tests are recorded for this work.')
    else {
      Object.assign(q, { state: 'assessed', level: 2, confidence: 0.6, refs: concernRefs, source: 'rules', reason: `Recorded quality problems: ${facts.signals.qualityConcerns.map((x) => x.text).join('; ')}.` })
      notes.push('Quality set by rules from recorded regressions / failing tests (the AI did not rate it).')
    }
  } else if (facts.signals.changesRequested > 0) {
    lower(q, 4, 'the manager requested changes before approval (rework).')
  }
  if (q.state === 'assessed' && q.level >= 4 && !facts.signals.approved && facts.evidenceItems === 0) lower(q, 3, 'quality above 3 needs an approved review or validation evidence.')

  // Work held up by something outside the person's control is not judged on delivery.
  if (!facts.delivered && facts.blockedOutside) {
    for (const k of ['impact', 'quality']) {
      Object.assign(dims[k], { state: 'not_applicable', level: null, confidence: null, source: 'rules', reason: 'Not delivered yet because of a blocker outside the employee\'s control. This is not counted against them.' })
    }
    notes.push('Delivery is held up by a blocker outside the employee\'s control: impact and quality are not judged, and nothing counts against them.')
  }

  // Impact above 3 needs a verified outcome; shared outcomes are never one person's alone.
  const i = dims.impact
  if (i.state === 'assessed' && !facts.impacts.some((x) => x.verification === 'VERIFIED')) lower(i, 3, 'impact above 3 needs a manager-verified outcome; this is an estimate.')
  const shared = facts.impacts.filter((x) => x.others.length)
  if (shared.length && i.state === 'assessed') {
    i.reason = `${i.reason} [Shared outcome: ${shared.length} record(s) involve other contributors; the impact is not attributed to this person alone.]`
  }

  // Estimated outcomes: known references only, and no number that is not in the evidence.
  const estimated = []
  for (const e of output.estimated_outcomes) {
    const nums = (e.description.match(/\d+(?:[.,]\d+)?/g) || []).filter((n) => !packText.includes(n))
    if (nums.length) { notes.push(`Dropped an estimated outcome with numbers not found in the evidence (${nums.join(', ')}).`); continue }
    estimated.push({ text: e.description, refs: cleanRefs(e.basis_refs, 'estimated outcome'), label: 'AI estimate — not verified' })
  }

  const all = [complexity, ...Object.values(dims)]
  const insufficient = all.filter((d) => d.state === 'insufficient_evidence').length
  return {
    evidenceState: insufficient === all.length ? 'insufficient' : insufficient ? 'partial' : 'sufficient',
    understanding: output.understanding,
    summary: output.contribution_summary,
    complexity,
    dimensions: dims,
    impact: impactBlock(facts, estimated),
    missing: [...new Set([...output.missing_information, ...missingInfo(facts, task)])].slice(0, 12),
    notes,
    blockerNote: output.blocker_note,
    sharedNote: output.shared_contribution_note
  }
}
