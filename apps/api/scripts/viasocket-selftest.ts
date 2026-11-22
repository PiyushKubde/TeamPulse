// REAL viaSocket checks that need no connected app account. Uses an isolated end user id and synthetic data only.
// Run: npm run viasocket:selftest -w @workpulse/api
import { z } from 'zod'
import { PROVIDERS, ACTIONS } from '../src/integrations/catalog.js'
import { viasocket } from '../src/integrations/viasocket/client.js'
import { automationToken, createFlow, readFlow, runHistory, runWebhookFlow, saveSteps, setTrigger } from '../src/integrations/viasocket/automations.js'
import { strictJsonSchema } from '../src/ai/provider.js'
import { env } from '../src/config/env.js'

const USER = 'workpulse-selftest'
const results: { check: string; ok: boolean; detail: string }[] = []
const record = (check: string, ok: boolean, detail: string) => {
  results.push({ check, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${check}: ${detail}`)
}

async function main() {
  const vs = viasocket()
  const user = vs.user(USER)

  // 1. Catalog keys/versions/ids exist in the live listing.
  const wanted = new Map<string, { key: string; version: string; id: string }[]>()
  for (const p of Object.values(PROVIDERS))
    wanted.set(
      p.slug,
      p.triggers.map((t) => ({ key: t.key, version: t.version, id: t.triggerId })),
    )
  for (const a of Object.values(ACTIONS)) wanted.set(a.app, [...(wanted.get(a.app) ?? []), { key: a.key, version: a.version, id: a.actionId }])
  for (const [app, events] of wanted) {
    if (!events.length) continue
    const { actions, serviceId } = await user.listActions(app)
    const missing = events.filter((e) => {
      const live = actions.find((x) => x.key === e.key)
      return !live || live.actionId !== e.id || !live.versions.some((v) => v.version.toLowerCase() === e.version.toLowerCase())
    })
    record(
      `catalog ${app}`,
      missing.length === 0,
      missing.length ? `missing/mismatched: ${missing.map((m) => `${m.key} ${m.version}`).join(', ')}` : `${events.length} events match (service ${serviceId})`,
    )
  }

  // 2. Embed token for the Connect popup.
  const token = await user.token()
  record('embed token', token.split('.').length === 3, 'signed HS256 JWT for the end user')

  // 3. Automation round trip with a code-only step (no app connection needed).
  const at = await automationToken(USER)
  record('automationToken', Boolean(at), 'short-lived token issued')
  const scriptId = await createFlow(at, { title: 'WorkPulse self-test (safe to delete)', description: 'Created and deleted by the WorkPulse self-test.' })
  try {
    await setTrigger(at, scriptId, { triggerType: 'webhook' })
    await saveSteps(at, scriptId, [{ stepname: 'echo', code: 'return { echoed: context?.req?.body?.ping ?? null }', service_action_functions: [] }])
    const flow = await readFlow(at, scriptId)
    record('createFlow/setTrigger/saveSteps/readFlow', flow.steps?.some((s) => s.stepname === 'echo') ?? false, `flow status ${flow.status}`)
    const out = await runWebhookFlow<{ echoed?: string }>(scriptId, { ping: 'workpulse' })
    record('webhook flow run', JSON.stringify(out).includes('workpulse'), `answered ${JSON.stringify(out).slice(0, 120)}`)
    // Run logs land a few seconds after the run.
    let rows: unknown[] = []
    for (let i = 0; i < 8 && !rows.length; i++) {
      await new Promise((r) => setTimeout(r, 5000))
      rows = await runHistory(at, scriptId)
    }
    record('runHistory', rows.length > 0, `${rows.length} run(s) recorded`)
  } finally {
    await user.deleteFlow(scriptId)
    record('deleteFlow', true, 'self-test flow removed')
  }

  // 4. Structured AI output through viaSocket (synthetic text only).
  const schema = z.object({ priority: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']), title: z.string() })
  const reply = await user.ai.send({
    message: 'Synthetic test: "fix the login outage for all customers ASAP"',
    prompt: 'Return a task title and a priority.',
    responseType: 'json_schema',
    jsonSchema: { name: 'selftest', schema: strictJsonSchema(schema), strict: true },
    service: env.AI_SERVICE,
    model: env.AI_MODEL_FAST,
  })
  const parsed = schema.safeParse(typeof reply.content === 'string' ? JSON.parse(reply.content) : reply.content)
  record(
    'AI structured output',
    parsed.success,
    parsed.success ? `${env.AI_SERVICE}/${env.AI_MODEL_FAST} → ${JSON.stringify(parsed.data)}` : 'did not validate',
  )

  const failed = results.filter((r) => !r.ok).length
  console.log(`\n${results.length - failed}/${results.length} passed`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('FAIL  self-test aborted:', e?.status ?? '', e?.message ?? e)
  process.exit(1)
})
