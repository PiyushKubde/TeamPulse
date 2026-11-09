// AI providers behind one small interface, so the evaluation engine never depends on a vendor:
//   { configured, name, model, generate({ system, user, schema }) → { output, model, usage } }
// Errors are ProviderError with `retryable` set, so the engine decides about retries without knowing the vendor.
//
//   AI_PROVIDER=anthropic  Claude through the official SDK (server-side key: ANTHROPIC_API_KEY)
//   AI_PROVIDER=mock       a deterministic SIMULATED analyser for local development and demos only — refused in
//                          production, and every assessment it makes is labelled "simulated" in the UI
//   (unset)                not configured: the app says so; no analysis is pretended
import Anthropic from '@anthropic-ai/sdk'

export class ProviderError extends Error {
  constructor(code, message, retryable) { super(message); this.code = code; this.retryable = retryable }
}

export function createAiProvider(cfg) {
  const ai = cfg.ai || {}
  if (ai.provider === 'anthropic' && ai.apiKey) return anthropicProvider(ai)
  if (ai.provider === 'mock' && !cfg.production) return simulatedProvider()
  const reason = ai.provider === 'mock' ? 'AI_PROVIDER=mock is for local development only and is ignored in production.'
    : ai.provider === 'anthropic' ? 'AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY.'
      : ai.provider ? `Unknown AI_PROVIDER "${ai.provider}".` : 'No AI provider is configured (set AI_PROVIDER and its key).'
  return { configured: false, name: null, model: null, reason, async generate() { throw new ProviderError('not_configured', reason, false) } }
}

function anthropicProvider(ai) {
  // Everything that could redirect, log or trace evaluation data is pinned here rather than read from the
  // environment: an explicit key (so ANTHROPIC_AUTH_TOKEN / profiles are never used), an explicit base URL
  // (ANTHROPIC_BASE_URL ignored), logLevel 'warn' (ANTHROPIC_LOG=debug cannot dump requests) and no OpenTelemetry
  // (ANTHROPIC_OPEN_TELEMETRY_* cannot switch on content capture).
  const client = new Anthropic({
    apiKey: ai.apiKey, baseURL: ai.baseUrl || 'https://api.anthropic.com', timeout: ai.timeoutMs || 120000,
    maxRetries: ai.maxRetries ?? 2, logLevel: 'warn', openTelemetry: false
  })
  const model = ai.model || 'claude-opus-5-5'
  return {
    configured: true, name: 'anthropic', model, fallbacks: ai.fallbacks !== false, baseUrl: client.baseURL,
    async generate({ system, user, schema }) {
      const params = {
        model, max_tokens: 16000, system,
        messages: [{ role: 'user', content: user }],
        output_config: { effort: ai.effort || 'medium', format: { type: 'json_schema', schema } }
      }
      let res
      try {
        // Server-side fallback on a safety decline (re-runs on a fallback model inside the same call); AI_FALLBACKS=off disables.
        res = ai.fallbacks === false
          ? await client.messages.create(params)
          : await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      } catch (error) {
        throw mapError(error)
      }
      return readResponse(res, model)
    }
  }
}

/** Turns a Messages API response into { output, model, fallback, usage } or a ProviderError. Exported for tests. */
export function readResponse(res, requestedModel) {
  const hops = (res.content || []).filter((b) => b.type === 'fallback').map((b) => ({ from: b.from?.model ?? null, to: b.to?.model ?? null }))
  const iterations = Array.isArray(res.usage?.iterations) ? res.usage.iterations : []
  const servedModel = res.model || requestedModel
  const fallback = { used: hops.length > 0 || iterations.some((x) => x.type === 'fallback_message') || servedModel !== requestedModel, requestedModel, servedModel, hops }
  if (res.stop_reason === 'refusal') {
    const cat = res.stop_details?.category ? ` (${res.stop_details.category})` : ''
    throw new ProviderError('refused', `The model declined to analyse this task${cat}${fallback.used ? ', including the fallback model' : ''}.`, false)
  }
  if (res.stop_reason === 'max_tokens') throw new ProviderError('truncated', 'The analysis was cut off before it finished.', true)
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('')
  if (!text.trim()) throw new ProviderError('invalid_output', 'The model returned no text.', true)
  let output
  try { output = JSON.parse(text) } catch { throw new ProviderError('invalid_output', 'The model did not return valid JSON.', true) }
  const u = res.usage || {}
  return {
    output, model: servedModel, fallback, requestId: res._request_id ?? null, stopReason: res.stop_reason,
    usage: { input_tokens: u.input_tokens ?? null, output_tokens: u.output_tokens ?? null, cache_read_input_tokens: u.cache_read_input_tokens ?? null, cache_creation_input_tokens: u.cache_creation_input_tokens ?? null }
  }
}

function mapError(error) {
  // Most specific first; the SDK has already retried 429/5xx/connection errors twice.
  if (error instanceof Anthropic.AuthenticationError) return new ProviderError('auth', 'The AI provider rejected the API key (401). Check ANTHROPIC_API_KEY.', false)
  if (error instanceof Anthropic.PermissionDeniedError) return new ProviderError('forbidden', 'The API key is not allowed to use this model or feature (403). Check the key\'s workspace and AI_MODEL.', false)
  if (error instanceof Anthropic.NotFoundError) return new ProviderError('not_found', `The AI provider does not know this model or endpoint (404). Check AI_MODEL.`, false)
  if (error instanceof Anthropic.RateLimitError) return new ProviderError('rate_limited', 'The AI provider is rate limiting requests.', true)
  if (error instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout', 'The AI provider did not answer in time.', true)
  if (error instanceof Anthropic.APIConnectionError) return new ProviderError('network', 'Could not reach the AI provider.', true)
  if (error instanceof Anthropic.InternalServerError) return new ProviderError('provider_error', `The AI provider failed (${error.status}).`, true)
  if (error instanceof Anthropic.BadRequestError) return new ProviderError('bad_request', `The AI provider rejected the request (400)${error.error?.error?.message ? `: ${String(error.error.error.message).slice(0, 200)}` : ''}.`, false)
  if (error instanceof Anthropic.APIError) return new ProviderError('provider_error', `The AI provider returned ${error.status ?? 'an error'}.`, (error.status ?? 500) >= 500)
  if (error instanceof Anthropic.AnthropicError) return new ProviderError('client_error', `The AI client failed: ${String(error.message).slice(0, 200)}`, false)
  return new ProviderError('unknown', 'The AI call failed.', false)
}

// ---------- simulated analyser (development only) ----------
// Reads the evidence pack with simple keyword rules and answers in the real schema. It is NOT AI and its results
// are labelled simulated everywhere; it exists so the full experience can be exercised without a key.
const DEEP = /investigat|root cause|race condition|across (?:services|systems)|multiple (?:services|systems)|migration|novel|unknown cause|reproduc|profil|trace/i
function simulatedProvider() {
  return {
    configured: true, name: 'simulated', model: 'simulated-rules-v1', simulated: true,
    async generate({ user }) {
      const pack = JSON.parse(user.slice(user.indexOf('{'), user.lastIndexOf('}') + 1))
      const items = pack.items || []
      const text = (i) => [i.text, i.workSummary, i.outcomeClaimed, i.result, i.workPerformed].filter(Boolean).join(' ')
      const deep = items.filter((i) => DEEP.test(text(i)) || DEEP.test(pack.task.description || ''))
      const work = items.filter((i) => ['submission', 'update', 'evidence', 'review', 'impact'].includes(i.kind))
      const refsOf = (list) => list.slice(0, 4).map((i) => i.ref)
      const level = deep.length >= 2 ? 'L4' : deep.length ? 'L3' : work.length ? 'L2' : 'L1'
      const s = pack.signals
      const dim = (state, lvl, reason, refs, confidence = 0.6) => ({ state, level: state === 'assessed' ? lvl : 0, confidence, reason, evidence_refs: refs })
      const ins = (why) => dim('insufficient_evidence', 0, why, [], 0.3)
      const help = items.filter((i) => i.kind === 'help')
      const impacts = items.filter((i) => i.kind === 'impact')
      return {
        model: 'simulated-rules-v1', usage: null,
        output: {
          understanding: `[Simulated] ${pack.task.title}: ${work.length} work record(s), ${items.filter((i) => i.kind === 'evidence').length} evidence item(s).`,
          complexity: work.length ? { state: 'assessed', level, confidence: 0.55, reason: `[Simulated] ${deep.length ? 'Investigation / multi-system work is described.' : 'Established approach described.'}`, evidence_refs: refsOf(deep.length ? deep : work) } : { state: 'insufficient_evidence', level: 'none', confidence: 0.3, reason: '[Simulated] No work described.', evidence_refs: [] },
          dimensions: {
            impact: impacts.length ? dim('assessed', impacts.some((i) => i.verification === 'verified') ? 4 : 3, '[Simulated] Based on the outcome record(s).', refsOf(impacts)) : ins('[Simulated] No outcome recorded.'),
            quality: work.length ? dim('assessed', s.reviewApproved ? 4 : 3, `[Simulated] ${s.reviewApproved ? 'Review approved.' : 'Not reviewed yet.'}`, refsOf(work)) : ins('[Simulated] Nothing to judge.'),
            ownership: work.length ? dim('assessed', items.some((i) => i.kind === 'update') ? 4 : 3, '[Simulated] Updates and submission present.', refsOf(work)) : ins('[Simulated] Nothing to judge.'),
            problem_solving: deep.length ? dim('assessed', 4, '[Simulated] Investigation described.', refsOf(deep)) : ins('[Simulated] No investigation described.'),
            collaboration: help.length ? dim('assessed', 4, '[Simulated] Helped teammates.', refsOf(help)) : ins('[Simulated] No collaboration recorded.')
          },
          contribution_summary: `[Simulated] ${level} work. This is a development simulation, not an AI analysis.`,
          estimated_outcomes: [],
          missing_information: [],
          blocker_note: s.blockersOutsideEmployeeControl.length ? '[Simulated] A blocker outside the employee\'s control affected this work.' : '',
          shared_contribution_note: s.sharedImpactRecords.length ? '[Simulated] The outcome is shared with other contributors.' : ''
        }
      }
    }
  }
}
