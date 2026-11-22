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

/** Readable messages when the server answered without an explanation (proxies, timeouts, crashes). */
const FALLBACK: Record<number, string> = {
  400: 'That request wasn’t valid. Check the form and try again.',
  401: 'Your session has ended. Please sign in again.',
  403: 'You don’t have permission to do that.',
  404: 'That item no longer exists or you can’t see it.',
  409: 'That can’t be done right now; it conflicts with the current state.',
  413: 'That is too large to upload.',
  429: 'Too many requests. Wait a moment and try again.',
  500: 'Something went wrong on our side. Please try again.',
  502: 'A connected app didn’t respond as expected. Please try again in a minute.',
  503: 'This feature isn’t available right now.',
  504: 'The server took too long to answer. Please try again.',
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
    throw new ApiError(
      res.status,
      e?.code ?? 'error',
      e?.message ?? FALLBACK[res.status] ?? FALLBACK[Math.floor(res.status / 100) * 100] ?? 'Something went wrong. Please try again.',
      e?.details,
    )
  }
  return data as T
}

export const errorMessage = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong.')
