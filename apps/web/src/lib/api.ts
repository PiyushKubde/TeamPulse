// The only way the web app talks to the API. Cookies carry the session; the X-WorkPulse header is the CSRF guard.
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

type Query = Record<string, string | number | boolean | undefined | null | string[]>

export function qs(query?: Query) {
  if (!query) return ''
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    if (Array.isArray(v)) v.forEach((x) => p.append(k, x))
    else p.set(k, String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

export async function api<T = unknown>(path: string, opts: { method?: string; body?: unknown; query?: Query; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? 'POST' : 'GET')
  const headers: Record<string, string> = { 'X-WorkPulse': '1' }
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
  const res = await fetch(`/api${path}${qs(opts.query)}`, {
    method,
    headers,
    credentials: 'include',
    body: opts.form ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  })
  if (res.status === 204) return undefined as T
  const data = await res.json().catch(() => ({}))
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string; details?: unknown } }).error
    throw new ApiError(res.status, e?.code ?? 'error', e?.message ?? `Request failed (${res.status})`, e?.details)
  }
  return data as T
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')
