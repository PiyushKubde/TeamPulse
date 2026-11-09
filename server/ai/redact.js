// Removes credentials from any text that could be logged, stored, or shown. Known secret values are registered at
// startup (the configured keys); common credential shapes are removed even when unknown.
const known = new Set()
export function registerSecret(value) { if (typeof value === 'string' && value.length >= 8) known.add(value) }
const PATTERNS = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic keys
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs (viaSocket embed tokens)
  /\b(x-api-key|api[_-]?key|authorization|secret|token)(["'\s:=]+)[A-Za-z0-9._~+/=-]{12,}/gi
]
export function redact(text) {
  if (text == null) return text
  let s = String(text)
  for (const v of known) s = s.split(v).join('[redacted]')
  for (const p of PATTERNS) s = s.replace(p, (m, k, sep) => (k && sep !== undefined ? `${k}${sep}[redacted]` : '[redacted]'))
  return s
}
