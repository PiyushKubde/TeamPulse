// The structured output the model must return, and a strict validator for it. The JSON Schema is sent to the
// provider (structured outputs); the validator runs on every response anyway, because the engine never trusts
// model output: unknown fields, bad enums and out-of-range numbers are rejected, not repaired.

const STATES = ['assessed', 'insufficient_evidence', 'not_applicable']
const refs = { type: 'array', items: { type: 'string' }, description: 'Only ref values that appear in the evidence pack (e.g. "submission-1"). Never invent one.' }
const dim = (desc) => ({
  type: 'object', additionalProperties: false, required: ['state', 'level', 'confidence', 'reason', 'evidence_refs'],
  description: desc,
  properties: {
    state: { type: 'string', enum: STATES },
    level: { type: 'integer', enum: [0, 1, 2, 3, 4, 5], description: '1-5 when state is assessed; 0 otherwise.' },
    confidence: { type: 'number', description: '0 to 1.' },
    reason: { type: 'string', description: 'One or two plain sentences a manager can read, naming the evidence.' },
    evidence_refs: refs
  }
})

export const OUTPUT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['understanding', 'complexity', 'dimensions', 'contribution_summary', 'estimated_outcomes', 'missing_information', 'blocker_note', 'shared_contribution_note'],
  properties: {
    understanding: { type: 'string', description: 'What the work was and what was done, in 2-4 plain sentences, from the evidence only.' },
    complexity: {
      type: 'object', additionalProperties: false, required: ['state', 'level', 'confidence', 'reason', 'evidence_refs'],
      properties: {
        state: { type: 'string', enum: STATES },
        level: { type: 'string', enum: ['L1', 'L2', 'L3', 'L4', 'none'] },
        confidence: { type: 'number' },
        reason: { type: 'string' },
        evidence_refs: refs
      }
    },
    dimensions: {
      type: 'object', additionalProperties: false, required: ['impact', 'quality', 'ownership', 'problem_solving', 'collaboration'],
      properties: {
        impact: dim('Business/customer value of what was delivered. Estimated unless an impact record is verified.'),
        quality: dim('Correctness, completeness, validation, rework, regressions.'),
        ownership: dim('Responsibility, follow-through, communication, handling blockers, handoff.'),
        problem_solving: dim('Investigation, root cause, decisions, alternatives, prevention.'),
        collaboration: dim('Helping or unblocking others, reviews, knowledge sharing, documentation.')
      }
    },
    contribution_summary: { type: 'string', description: 'What this person contributed, for a manager, in 2-3 sentences. No praise words without evidence.' },
    estimated_outcomes: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['description', 'basis_refs'], properties: { description: { type: 'string' }, basis_refs: refs } },
      description: 'Likely outcomes not yet verified. Do not include numbers unless they appear in the evidence.'
    },
    missing_information: { type: 'array', items: { type: 'string' }, description: 'Concrete evidence that would make this assessment more reliable.' },
    blocker_note: { type: 'string', description: 'How blockers affected the work, separating what was outside the employee\'s control. Empty if none.' },
    shared_contribution_note: { type: 'string', description: 'Who else contributed to the same outcome and what is this person\'s part. Empty if not shared.' }
  }
}

const isStr = (v) => typeof v === 'string'
function checkKeys(o, keys, path) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error(`${path} must be an object`)
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw new Error(`${path}.${k} is not allowed`)
  for (const k of keys) if (!(k in o)) throw new Error(`${path}.${k} is missing`)
}
function checkRefs(a, path) {
  if (!Array.isArray(a) || !a.every(isStr) || a.length > 30) throw new Error(`${path} must be a list of refs`)
}
function checkDim(d, path, levels) {
  checkKeys(d, ['state', 'level', 'confidence', 'reason', 'evidence_refs'], path)
  if (!STATES.includes(d.state)) throw new Error(`${path}.state is invalid`)
  if (!levels.includes(d.level)) throw new Error(`${path}.level is invalid`)
  if (typeof d.confidence !== 'number' || !(d.confidence >= 0 && d.confidence <= 1)) throw new Error(`${path}.confidence must be between 0 and 1`)
  if (!isStr(d.reason) || d.reason.length > 2000) throw new Error(`${path}.reason must be text`)
  checkRefs(d.evidence_refs, `${path}.evidence_refs`)
}

/** Throws with a precise message when the output does not match the schema. */
export function validateOutput(o) {
  checkKeys(o, OUTPUT_SCHEMA.required, 'output')
  for (const k of ['understanding', 'contribution_summary', 'blocker_note', 'shared_contribution_note']) if (!isStr(o[k]) || o[k].length > 4000) throw new Error(`output.${k} must be text`)
  checkDim(o.complexity, 'complexity', ['L1', 'L2', 'L3', 'L4', 'none'])
  checkKeys(o.dimensions, ['impact', 'quality', 'ownership', 'problem_solving', 'collaboration'], 'dimensions')
  for (const [k, d] of Object.entries(o.dimensions)) checkDim(d, `dimensions.${k}`, [0, 1, 2, 3, 4, 5])
  if (!Array.isArray(o.estimated_outcomes) || o.estimated_outcomes.length > 10) throw new Error('estimated_outcomes must be a short list')
  o.estimated_outcomes.forEach((x, i) => { checkKeys(x, ['description', 'basis_refs'], `estimated_outcomes[${i}]`); if (!isStr(x.description)) throw new Error('estimated outcome needs a description'); checkRefs(x.basis_refs, `estimated_outcomes[${i}].basis_refs`) })
  if (!Array.isArray(o.missing_information) || !o.missing_information.every(isStr) || o.missing_information.length > 15) throw new Error('missing_information must be a list of text')
  return o
}
