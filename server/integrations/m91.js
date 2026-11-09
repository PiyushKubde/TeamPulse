// M91 (MSG91) human-in-the-loop alerts, Platform API.
// Contract: https://m91-api.msg91.com/api/public/api.md (read 2026-11-09).
//
//   Base      https://m91-api.msg91.com/api/v1          Authorization: Bearer m91sk_…
//   POST /recipients   { phone, label? }                invite a person (they must accept in the M91 app)
//   POST /alerts       { phone, title, description, severity, responseOptions, other, callbackUrl, isAutoClose, customId }
//   GET  /alerts/:id?phone=…                           read the alert back (decision, responses, status)
//   POST /alerts/close { phone, customId | alertId }   close it when the condition is resolved
//
// Every response is { success, data } or { success: false, error: { code, message } }. Phones are digits with the
// country code and no "+". The callback signature cannot be verified yet (the secret is not exposed), so a callback is
// only a signal: the alert is always read back before anything is recorded.
const BASE = 'https://m91-api.msg91.com/api/v1'

export class M91Error extends Error {
  constructor(message, { status = null, code = null, retryable = false, notConfigured = false } = {}) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
    this.notConfigured = notConfigured
  }
}

/** "+91 98765-43210" → "919876543210"; null when it is not a plausible international number. */
export function m91Phone(phone) {
  const digits = String(phone || '').replace(/[^\d]/g, '')
  return digits.length >= 8 && digits.length <= 15 ? digits : null
}

export function createM91Transport({ apiKey = '', callbackUrl = '' } = {}, fetchImpl = fetch) {
  const ready = /^m91sk_[A-Za-z0-9_-]{8,}$/.test(apiKey)

  async function call(method, path, body) {
    let res
    try {
      res = await fetchImpl(`${BASE}${path}`, {
        method,
        headers: { Authorization: `Bearer ${apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      })
    } catch (error) {
      throw new M91Error(`Could not reach M91 (${error.name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { retryable: true })
    }
    const json = await res.json().catch(() => null)
    if (res.ok && json?.success !== false) return { status: res.status, data: json?.data ?? null }
    const code = json?.error?.code || null
    const message = String(json?.error?.message || `HTTP ${res.status}`).slice(0, 200)
    // 429 and 5xx are worth retrying; 4xx means the request or the recipient must change first.
    throw new M91Error(`M91 refused: ${code ? `${code} — ` : ''}${message}`, { status: res.status, code, retryable: res.status === 429 || res.status >= 500 })
  }

  return {
    name: 'm91',
    configured: Boolean(apiKey),
    ready,
    status() {
      if (!apiKey) return { state: 'not_configured', message: 'Set M91_API_KEY (an m91sk_… key from the M91 app: Settings → API keys) to send alerts through M91. Alerts are in-app until then.' }
      if (!ready) return { state: 'invalid_key', message: 'M91_API_KEY does not look like an M91 API key (m91sk_…).' }
      return { state: 'ready', message: `M91 is configured.${callbackUrl ? ' Answers come back to TeamPulse.' : ' Set APP_URL (https) and M91_CALLBACK_TOKEN to receive answers.'}` }
    },
    /** Invites a person so they can be alerted; they must accept in the M91 app. */
    async invite(phone, label = 'TeamPulse alerts') {
      if (!ready) throw new M91Error('M91 is not configured.', { notConfigured: true })
      const p = m91Phone(phone)
      if (!p) throw new M91Error('Not a valid phone number for M91.')
      const out = await call('POST', '/recipients', { phone: p, label })
      return { phone: p, state: out.data?.state ?? null, reachable: Boolean(out.data?.reachable) }
    },
    /**
     * Raises one alert for one person. Resolves to { providerMessageId, delivered, deduplicated } or throws M91Error.
     * A recipient who was never invited is invited, and the send fails without retry until they accept.
     */
    async send({ title, body, link, recipient, idempotencyKey, severity = 'MEDIUM' }) {
      if (!ready) throw new M91Error(this.status().message, { notConfigured: true })
      const phone = m91Phone(recipient?.phone)
      if (!phone) throw new M91Error(`${recipient?.name || 'This person'} has no phone number in TeamPulse (Settings → Profile).`, { code: 'NO_PHONE' })
      let t = String(title || 'TeamPulse alert').slice(0, 2000)
      if (t.length < 5) t = `TeamPulse: ${t}`
      const description = [body, link].filter(Boolean).join('\n').slice(0, 2000) || undefined
      const payload = {
        phone, title: t, ...(description ? { description } : {}), severity,
        // One person takes it on (closes it), or just acknowledges it; free-text replies stay on.
        responseOptions: [{ label: 'I’m on it', effect: 'SHARED' }, { label: 'Seen', effect: 'PERSONAL' }],
        other: true, isAutoClose: true, customId: idempotencyKey,
        ...(callbackUrl ? { callbackUrl } : {})
      }
      try {
        const out = await call('POST', '/alerts', payload)
        return { providerMessageId: out.data?._id ?? null, delivered: out.data?.delivered ?? null, deduplicated: Boolean(out.data?.deduplicated) }
      } catch (error) {
        if (error.status === 404 && /not_a_recipient/i.test(error.message)) {
          await this.invite(phone).catch(() => {})
          throw new M91Error(`${recipient?.name || 'This person'} was invited to M91 and must accept the invitation in the M91 app before alerts reach them.`, { status: 404, code: 'not_a_recipient' })
        }
        if (error.code === 'CHANNEL_EMPTY') throw new M91Error(`${recipient?.name || 'This person'} has not accepted the M91 invitation yet (or has not installed the M91 app).`, { status: 409, code: 'CHANNEL_EMPTY' })
        throw error
      }
    },
    /** The alert as M91 has it now: { id, status, decision, responses }. */
    async getAlert(id, phone) {
      const p = m91Phone(phone)
      const out = await call('GET', `/alerts/${encodeURIComponent(id)}?phone=${p}`)
      return out.data
    },
    /** Closes an alert whose condition is resolved. Already closed or unknown is not an error. */
    async close({ phone, customId, alertId }) {
      if (!ready) return { closed: false }
      try {
        await call('POST', '/alerts/close', { phone: m91Phone(phone), ...(customId ? { customId } : { alertId }) })
        return { closed: true }
      } catch (error) {
        if (error.status === 404 || error.status === 403) return { closed: false, alreadyClosed: true }
        throw error
      }
    }
  }
}
