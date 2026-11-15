// The only place the viaSocket SDK is constructed. Server only: the secret never leaves this process.
import { ViaSocket } from 'viasocket-apps'
import { env, viasocketConfigured } from '../../config/env.js'
import { unavailable } from '../../lib/errors.js'

let client: ViaSocket | null = null

/** Tests swap the transport with setViasocketForTests. */
export function viasocket(): ViaSocket {
  if (client) return client
  if (!viasocketConfigured) throw unavailable('viasocket_not_configured', 'Integrations are not configured: the viaSocket keys are missing on the server.')
  client ??= new ViaSocket({ orgId: env.VIASOCKET_ORG_ID!, projectId: env.VIASOCKET_PROJECT_ID!, secret: env.VIASOCKET_EMBED_SECRET! })
  return client
}

export function setViasocketForTests(fake: ViaSocket | null) {
  client = fake
}

/** viaSocket's end-user id for a WorkPulse user: our stable user id, never the email. */
export const vsUserId = (userId: string) => String(userId)
