// viaSocket errors, cleaned of anything that could carry a credential (run URLs, script ids, tokens, emails).
import { AppError } from '../errors.js'

export function requireViasocket(vs) {
  if (!vs.configured) throw new AppError(503, 'viasocket_not_configured', 'ViaSocket is not configured on this server: an admin must set VIASOCKET_ORG_ID, VIASOCKET_PROJECT_ID and VIASOCKET_EMBED_SECRET.')
}

export function redact(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '[link]')
    .replace(/\bscri[A-Za-z0-9]{6,}\b/g, '[id]')
    .replace(/\beyJ[A-Za-z0-9._-]{10,}/g, '[token]')
    .replace(/(?:Bearer|token[=:])\s*[A-Za-z0-9._~+/-]{8,}=*/gi, '[token]')
    .replace(/[^\s@"'<>(),;]+@[^\s@"'<>(),;]+/g, '[email]')
}

export function viasocketError(error, what) {
  if (error instanceof AppError) return error
  const status = error?.status
  if (status === 401 || status === 403) return new AppError(502, 'viasocket_auth', `ViaSocket refused to ${what}: this server's ViaSocket credentials were not accepted.`)
  if (status === null || status === undefined) return new AppError(504, 'viasocket_unreachable', `Could not reach ViaSocket to ${what}. Try again in a moment.`)
  const message = redact(typeof error?.message === 'string' ? error.message : 'ViaSocket did not accept the request.').slice(0, 300)
  console.log(`[viasocket] could not ${what}: HTTP ${status}`)
  return new AppError(502, 'viasocket_error', `ViaSocket could not ${what}: ${message}`)
}
