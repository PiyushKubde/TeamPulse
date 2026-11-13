// M91 (MSG91) human-in-the-loop alerts, Platform API.
// Contract: https://m91-api.msg91.com/api/public/api.md (read 2026-11-09).
//
//   Base      https://m91-api.msg91.com/api/v1          Authorization: Bearer m91sk_…
//   POST /recipients   { phone, label? }                invite a person (they must accept in the M91 app)
//   POST /alerts       { phone, title, description, severity, responseOptions, other, callbackUrl, isAutoClose, customId }
//   GET  /alerts/:id?phone=…                           read the alert back (decision, responses, status)
//   POST /alerts/close { phone, customId | alertId }   close it when the condition is resolved
//
// Channel mode (send link, https://m91-api.msg91.com/llms.txt, read 2026-11-09): M91_SEND_LINK alerts everyone in one
// M91 channel; the link itself is the credential (never logged, never in source).
//   POST <link>            { title, description, severity, responseOptions, other, callbackUrl, isAutoClose, customId }
//   GET  <link>            connection test (no title → raises nothing): { ok, channel: { name } }
//   GET  <link>/alerts/:id read back       POST <link>/close { customId | alertId }
// One condition rings the channel once: the customId is per condition (not per person), and M91 absorbs repeats of an
// open customId. People join the channel in the M91 app; KONVO invites nobody in this mode.
//
// Every response is { success, data } or { success: false, error: { code, message } }. Phones are digits with the
// country code and no "+". The callback signature cannot be verified yet (the secret is not exposed), so a callback is
// only a signal: the alert is always read back before anything is recorded.
import { redact, registerSecret } from '../ai/redact.js'

const BASE = 'https://m91-api.msg91.com/api/v1'
const SEND_LINK_RE = /^https:\/\/m91-api\.msg91\.com\/s\/[A-Za-z0-9_-]{8,}$/

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

export function createM91Transport({ apiKey = '', callbackUrl = '', sendLink = '' } = {}, fetchImpl = fetch) {
  const channel = SEND_LINK_RE.test(sendLink)
  registerSecret(sendLink)
  registerSecret(apiKey)
  const ready = channel || /^m91sk_[A-Za-z0-9_-]{8,}$/.test(apiKey)

  async function call(method, path, body) {
    let res
    try {
      res = await fetchImpl(channel ? `${sendLink}${path}` : `${BASE}${path}`, {
        method,
        headers: { ...(channel ? {} : { Authorization: `Bearer ${apiKey}` }), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000)
      })
    } catch (error) {
      throw new M91Error(`Could not reach M91 (${error.name === 'TimeoutError' ? 'timeout' : 'network error'}).`, { retryable: true })
    }
    const json = await res.json().catch(() => null)
    if (res.ok && json?.success !== false) return { status: res.status, data: json?.data ?? null }
    const code = json?.error?.code || null
    const message = redact(String(json?.error?.message || `HTTP ${res.status}`)).slice(0, 200)
    // 429 and 5xx are worth retrying; 4xx means the request or the recipient must change first.
    throw new M91Error(`M91 refused: ${code ? `${code} — ` : ''}${message}`, { status: res.status, code, retryable: res.status === 429 || res.status >= 500 })
  }

  return {
    name: 'm91',
    mode: channel ? 'channel' : 'person',
    configured: Boolean(apiKey || sendLink),
    ready,
    status() {
      if (sendLink && !channel) return { state: 'invalid_link', message: 'M91_SEND_LINK does not look like an M91 send link (https://m91-api.msg91.com/s/…).' }
      if (channel) return { state: 'ready', message: `M91 channel mode: alerts go to the team's M91 channel.${callbackUrl ? ' Answers come back to KONVO.' : ' Set APP_URL (https) and M91_CALLBACK_TOKEN to receive answers.'}` }
      if (!apiKey) return { state: 'not_configured', message: 'Set M91_SEND_LINK (a channel send link from the M91 app) or M91_API_KEY (m91sk_…) to send alerts through M91. Alerts are in-app until then.' }
      if (!ready) return { state: 'invalid_key', message: 'M91_API_KEY does not look like an M91 API key (m91sk_…).' }
      return { state: 'ready', message: `M91 is configured.${callbackUrl ? ' Answers come back to KONVO.' : ' Set APP_URL (https) and M91_CALLBACK_TOKEN to receive answers.'}` }
    },
    /** Invites a person so they can be alerted; they must accept in the M91 app. */
    async invite(phone, label = 'KONVO alerts') {
      if (channel) return { phone: m91Phone(phone), state: 'channel', reachable: null }
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
      if (channel) {
        // The whole channel is alerted, so the title names the person it is about.
        let t = `${recipient?.name ? `${recipient.name}: ` : ''}${String(title || 'KONVO alert')}`.slice(0, 2000)
        if (t.length < 5) t = `KONVO: ${t}`
        const description = [body, link].filter(Boolean).join('\n').slice(0, 2000) || undefined
        try {
          const out = await call('POST', '', { title: t, ...(description ? { description } : {}), severity, responseOptions: [{ label: "I'm on it", effect: 'SHARED' }, { label: 'Seen', effect: 'PERSONAL' }], other: true, isAutoClose: true, customId: idempotencyKey, ...(callbackUrl ? { callbackUrl } : {}) })
          return { providerMessageId: out.data?._id ?? null, delivered: out.data?.delivered ?? null, deduplicated: Boolean(out.data?.deduplicated) }
        } catch (error) {
          if (error.code === 'CHANNEL_EMPTY') throw new M91Error('Nobody in the M91 channel can receive alerts yet (members must install M91 and accept).', { status: 409, code: 'CHANNEL_EMPTY' })
          throw error
        }
      }
      const phone = m91Phone(recipient?.phone)
      if (!phone) throw new M91Error(`${recipient?.name || 'This person'} has no phone number in KONVO (Settings → Profile).`, { code: 'NO_PHONE' })
      let t = String(title || 'KONVO alert').slice(0, 2000)
      if (t.length < 5) t = `KONVO: ${t}`
      const description = [body, link].filter(Boolean).join('\n').slice(0, 2000) || undefined
      const payload = {
        phone, title: t, ...(description ? { description } : {}), severity,
        // One person takes it on (closes it), or just acknowledges it; free-text replies stay on.
        responseOptions: [{ label: "I'm on it", effect: 'SHARED' }, { label: 'Seen', effect: 'PERSONAL' }],
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
      if (channel) return (await call('GET', `/alerts/${encodeURIComponent(id)}`)).data
      const p = m91Phone(phone)
      const out = await call('GET', `/alerts/${encodeURIComponent(id)}?phone=${p}`)
      return out.data
    },
    /** Closes an alert whose condition is resolved. Already closed or unknown is not an error. */
    async close({ phone, customId, alertId }) {
      if (!ready) return { closed: false }
      try {
        if (channel) await call('POST', '/close', customId ? { customId } : { alertId })
        else await call('POST', '/alerts/close', { phone: m91Phone(phone), ...(customId ? { customId } : { alertId }) })
        return { closed: true }
      } catch (error) {
        if (error.status === 404 || error.status === 403) return { closed: false, alreadyClosed: true }
        throw error
      }
    }
  }
}
