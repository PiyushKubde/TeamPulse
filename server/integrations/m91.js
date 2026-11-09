// M91 (MSG91) alert transport.
//
// Concept (from MSG91's guide "How the M91 alert flow moves an alert from software to a person"): software sends a
// titled alert request to a person, the person responds, and the answer is returned to the software.
//
// M91-PENDING: the exact HTTP endpoint, auth header and request/callback payloads are NOT implemented here, because
// the official documentation (https://m91.msg91.com/docs and msg91.com) could not be reached from the build
// environment, and TeamPulse must not invent them. Everything around the call is real and tested with a fake
// transport: the alert queue, per-rule settings, retries with backoff, history, idempotent callback storage and the
// in-app fallback. To activate: implement `send` and `parseCallback` below from the official docs, set
// M91_AUTH_KEY and M91_CALLBACK_TOKEN, and flip `apiImplemented` to true.

export function createM91Transport({ authKey = '' } = {}) {
  const apiImplemented = false
  return {
    name: 'm91',
    configured: Boolean(authKey),
    ready: Boolean(authKey) && apiImplemented,
    status() {
      if (!apiImplemented) return { state: 'pending_api', message: 'The M91 request format has not been implemented yet: it needs the official M91 API documentation. Alerts are delivered in-app until then.' }
      if (!authKey) return { state: 'not_configured', message: 'Set M91_AUTH_KEY to send alerts through M91.' }
      return { state: 'ready', message: 'M91 is configured.' }
    },
    /**
     * Sends one alert. Must resolve to { providerMessageId } or throw an error with
     * `retryable` (boolean) set. Input: { title, body, link, recipient: { name, email, phone }, idempotencyKey }.
     */
    async send() {
      const error = new Error('M91 sending is not implemented yet (M91-PENDING): the API request format needs the official documentation.')
      error.retryable = false
      error.notConfigured = true
      throw error
    },
    /**
     * Maps a callback body to { providerMessageId, status: 'DELIVERED'|'FAILED'|'RESPONDED', response }.
     * Returns null until implemented from the official documentation; the raw callback is still stored once.
     */
    parseCallback() {
      return null
    }
  }
}
