// One structured-output call, two providers: viaSocket's AI API (OpenAI models, default) or OpenAI directly.
// Every answer is a strict JSON schema, then re-validated with zod before any caller sees it.
import OpenAI from 'openai'
import { z } from 'zod'
import { env, viasocketConfigured } from '../config/env.js'
import { logger } from '../config/logger.js'
import { unavailable } from '../lib/errors.js'
import { viasocket } from '../integrations/viasocket/client.js'
import { recordFailure, recordSuccess } from '../services/phone-alerts.js'

export function aiStatus(): { configured: boolean; provider: string | null; reason: string | null } {
  if (!env.AI_PROVIDER) return { configured: false, provider: null, reason: 'AI is switched off (AI_PROVIDER is empty).' }
  if (env.AI_PROVIDER === 'viasocket' && !viasocketConfigured)
    return { configured: false, provider: 'viasocket', reason: 'AI is not configured: the viaSocket keys are missing.' }
  if (env.AI_PROVIDER === 'openai' && !env.OPENAI_API_KEY)
    return { configured: false, provider: 'openai', reason: 'AI is not configured: OPENAI_API_KEY is missing.' }
  return { configured: true, provider: env.AI_PROVIDER, reason: null }
}

export function assertAi() {
  const s = aiStatus()
  if (!s.configured) throw unavailable('ai_not_configured', s.reason!)
}

/** OpenAI strict mode needs every property required and no extra keys; optional values are expressed as nullable. */
export function strictJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: 'draft-7' }) as Record<string, unknown>
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return
    const n = node as Record<string, unknown>
    delete n.$schema
    delete n.format // not supported by strict mode; zod re-checks formats
    delete n.pattern
    if (n.type === 'object' && n.properties) {
      n.additionalProperties = false
      n.required = Object.keys(n.properties as object)
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk)
      else walk(v)
    }
  }
  walk(json)
  return json
}

let openai: OpenAI | null = null

export interface StructuredRequest<S extends z.ZodType> {
  /** The end user the call is for (viaSocket keeps AI usage per user). */
  userId: string
  name: string
  system: string
  input: string
  schema: S
  tier?: 'fast' | 'assistant'
}

export async function structured<S extends z.ZodType>(req: StructuredRequest<S>): Promise<z.infer<S>> {
  assertAi()
  const model = req.tier === 'assistant' ? env.AI_MODEL_ASSISTANT : env.AI_MODEL_FAST
  const jsonSchema = { name: req.name, schema: strictJsonSchema(req.schema), strict: true }
  let raw: unknown
  const started = Date.now()
  try {
    if (env.AI_PROVIDER === 'viasocket') {
      const reply = await viasocket().user(req.userId).ai.send({
        message: req.input,
        prompt: req.system,
        responseType: 'json_schema',
        jsonSchema,
        service: env.AI_SERVICE,
        model,
      })
      if (reply.finishReason === 'truncated') throw unavailable('ai_truncated', 'The AI answer was cut short. Try a narrower question.')
      raw = typeof reply.content === 'string' ? JSON.parse(reply.content) : reply.content
    } else {
      openai ??= new OpenAI({ apiKey: env.OPENAI_API_KEY })
      const completion = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: req.system },
          { role: 'user', content: req.input },
        ],
        response_format: { type: 'json_schema', json_schema: jsonSchema },
      })
      raw = JSON.parse(completion.choices[0]?.message.content ?? 'null')
    }
  } catch (e) {
    void recordFailure('ai')
    throw e
  }
  void recordSuccess('ai')
  logger.info({ ai: req.name, ms: Date.now() - started, provider: env.AI_PROVIDER }, 'ai call')
  const parsed = req.schema.safeParse(raw)
  if (!parsed.success) {
    logger.warn({ ai: req.name, issues: parsed.error.issues.slice(0, 3) }, 'ai answer failed validation')
    throw unavailable('ai_invalid', 'The AI answer did not pass validation and was discarded.')
  }
  return parsed.data
}
