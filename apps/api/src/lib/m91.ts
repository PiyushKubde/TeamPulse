// M91: reaching a human. Two credentials (https://m91-api.msg91.com/api/public/api.md#credentials):
// the on-call channel's send link (fixed team) and an API key (each user's own phone). Plain HTTPS; every field is
// read from inside `data`; errors branch on `error.code`; the token never reaches a log or an error message.
import { env } from '../config/env.js'

const API = 'https://m91-api.msg91.com/api/v1'

export interface ResponseOption {
  label: string
  effect: 'SHARED' | 'PERSONAL'
  required?: ('note' | 'attachment')[]
}
export interface AlertPayload {
  title: string
  description?: string
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'
  customId: string
  responseOptions: ResponseOption[]
  isAutoClose?: boolean
}
export interface AlertState {
  _id: string
  customId: string | null
  status: string
  decision: { label: string; effect: string; at?: string; by?: string } | null
  responses: { label: string; effect: string; note: string | null; by?: string; name?: string }[]
  resolvedAt: string | null
}

export class M91Error extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const redact = (s: string) => s.replace(/sk_[A-Za-z0-9]+/g, 'sk_…').replace(/m91sk_[A-Za-z0-9_]+/g, 'm91sk_…')

async function call<T>(url: string, init: RequestInit = {}): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })
  } catch (e) {
    throw new M91Error(0, 'NETWORK', redact(`M91 unreachable: ${e instanceof Error ? e.message : String(e)}`))
  }
  const body = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; error?: { code?: string; message?: string } }
  if (!res.ok || body.success === false)
    throw new M91Error(res.status, body.error?.code ?? `HTTP_${res.status}`, redact(body.error?.message ?? `M91 answered ${res.status}`))
  return body.data as T
}

const json = (method: string, payload: unknown, auth?: string): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...(auth ? { Authorization: `Bearer ${auth}` } : {}) },
  body: JSON.stringify(payload),
})

// ───────────── On-call channel (send link) ─────────────

export const channelConfigured = () => Boolean(env.M91_SEND_LINK)
const link = () => {
  if (!env.M91_SEND_LINK) throw new M91Error(0, 'NOT_CONFIGURED', 'M91_SEND_LINK is not set')
  return env.M91_SEND_LINK
}
/** Connection test: raises nothing. */
export const channelInfo = () => call<{ ok: boolean; channel: { id: string; name: string } }>(link())
export const channelAlert = (p: AlertPayload) => call<{ _id: string; delivered: number; deduplicated?: boolean }>(link(), json('POST', p))
export const channelClose = (customId: string) => call<{ _id: string; status: string }>(`${link()}/close`, json('POST', { customId }))

// ───────────── People (API key) ─────────────

export const platformConfigured = () => Boolean(env.M91_API_KEY)
const key = () => {
  if (!env.M91_API_KEY) throw new M91Error(0, 'NOT_CONFIGURED', 'M91_API_KEY is not set')
  return env.M91_API_KEY
}
/** Digits only, with country code, no "+"; a 10-digit number is taken as Indian (+91). */
export function normalizePhone(input: string) {
  const digits = input.replace(/\D/g, '')
  const full = digits.length === 10 ? `91${digits}` : digits
  return /^\d{11,15}$/.test(full) ? full : null
}
export const invite = (phone: string) =>
  call<{ phone: string; state: 'pending' | 'accepted' | 'declined'; reachable: boolean }>(
    `${API}/recipients`,
    json('POST', { phone, label: 'WorkPulse' }, key()),
  )
export const uninvite = (phone: string) =>
  call<{ phone: string; state: string }>(`${API}/recipients/${phone}`, { method: 'DELETE', headers: { Authorization: `Bearer ${key()}` } })
export const personAlert = (phone: string, p: AlertPayload) =>
  call<{ _id: string; delivered: number; deduplicated?: boolean }>(`${API}/alerts`, json('POST', { ...p, phone }, key()))
export const personRead = (phone: string, customId: string) =>
  call<AlertState>(`${API}/alerts/${encodeURIComponent(customId)}?phone=${phone}`, { headers: { Authorization: `Bearer ${key()}` } })
export const personClose = (phone: string, customId: string) =>
  call<{ _id: string; status: string }>(`${API}/alerts/close`, json('POST', { phone, customId }, key()))
