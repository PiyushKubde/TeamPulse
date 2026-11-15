// The automations module from https://viasocket.com/docs/automations.md?format=sdk (not in the package yet),
// in TypeScript. Server only: proxy_auth_token is the user's own viaSocket token.
import { env } from '../../config/env.js'
import { viasocket } from './client.js'

const API = 'https://flow-api.viasocket.com'

async function call<T>(token: string, method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', proxy_auth_token: token },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = (await res.json().catch(() => ({}))) as { data?: T; message?: string }
  if (!res.ok) throw new Error(payload?.message || `${method} ${url}: ${res.status}`)
  return payload.data as T
}

/** Short-lived: derive at the start of each build, edit or read; never store it. */
export async function automationToken(userId: string) {
  const res = await fetch(`${API}/users/register`, { headers: { authorization: await viasocket().user(String(userId)).token() } })
  const payload = (await res.json().catch(() => ({}))) as { data?: { token: string }; message?: string }
  if (!res.ok || !payload.data) throw new Error(payload?.message || `automationToken: ${res.status}`)
  return payload.data.token
}

export const createFlow = async (token: string, f: { title: string; description: string }) =>
  (await call<{ script_id: string }>(token, 'POST', `${API}/automations`, f)).script_id

export type Trigger = { triggerType: 'webhook' } | { triggerType: 'cron'; cronStatement: string; timezone?: string }
export const setTrigger = (token: string, scriptId: string, trigger: Trigger) => call(token, 'POST', `${API}/automations/${scriptId}/trigger`, trigger)

export interface Step {
  stepname: string
  code: string
  service_action_functions: { name: string; auth_id: string; action_id: string }[]
}
/** Replaces the whole array, then publishes. */
export const saveSteps = (token: string, scriptId: string, steps: Step[]) => call(token, 'POST', `${API}/automations/${scriptId}/steps`, { steps })
export const readFlow = (token: string, scriptId: string) =>
  call<{ script_id: string; title: string; status: string; steps: Step[] }>(token, 'GET', `${API}/automations/${scriptId}`)

export interface RunLog {
  _id?: string
  status?: string
  createdAt?: string
  requestTimestamp?: string
  console?: unknown
  stepOrderJsonData?: unknown
  output?: string
  flowHitId?: string
  /** Holds request headers: never shown to users or logged. */
  requestSnapshot?: unknown
}

/** The last 30 days of runs, newest first (viaSocket answers { finalResponse: [...] }; logs land a few seconds after a run). */
export async function runHistory(token: string, scriptId: string, { page = 1, limit = 20 } = {}): Promise<RunLog[]> {
  const url = `${API}/logs/orgId/${env.VIASOCKET_ORG_ID}?projectId=${env.VIASOCKET_PROJECT_ID}&scriptId=${scriptId}&page=${page}&limit=${limit}`
  const res = await fetch(url, { headers: { proxy_auth_token: token } })
  if (!res.ok) throw new Error(`runHistory: ${res.status}`)
  const body = (await res.json()) as { data?: { finalResponse?: RunLog[] } | RunLog[]; finalResponse?: RunLog[] }
  const d = body.data ?? body
  return Array.isArray(d) ? d : (d.finalResponse ?? [])
}

/** POSTs to a webhook-triggered flow; answers the last step's return value. The script_id is a credential. */
export async function runWebhookFlow<T = unknown>(scriptId: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const res = await fetch(`https://flow.sokt.io/func/${scriptId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Flow answered ${res.status}: ${text.slice(0, 300)}`)
  try {
    return JSON.parse(text) as T
  } catch {
    return text as T
  }
}
