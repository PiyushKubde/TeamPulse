// The one viaSocket client, server only (viasocket-apps SDK). Same gateway shape as DealSaathi, so tests pass a fake.
// https://viasocket.com/docs/skill.md?format=sdk
import { ViaSocket } from 'viasocket-apps'

export function createViasocketGateway({ orgId, projectId, secret }) {
  if (!(orgId && projectId && secret)) return { configured: false }
  const viasocket = new ViaSocket({ orgId, projectId, secret })
  const slugCache = new Map()
  /** catalog.serviceIdFor first; falls back to scanning catalog.list() (seen needed for 'gmail' with 0.7.0 in DealSaathi). */
  async function serviceIdFor(slug) {
    if (slugCache.has(slug)) return slugCache.get(slug)
    let id
    try {
      id = await viasocket.catalog.serviceIdFor(slug)
    } catch (error) {
      for (let offset = 0; offset < 4000 && !id; offset += 200) {
        const page = await viasocket.catalog.list({ limit: 200, offset })
        if (!page.length) break
        id = page.find((a) => a.slug === slug)?.serviceId
      }
      if (!id) throw error
    }
    slugCache.set(slug, id)
    return id
  }
  const user = (id) => viasocket.user(String(id))
  return {
    configured: true,
    serviceIdFor,
    versions: (serviceId) => viasocket.catalog.versions(serviceId),
    versionIdFor: (serviceId, actionId, version) => viasocket.catalog.versionIdFor(serviceId, actionId, version),
    token: (userId) => user(userId).token(),
    listConnections: (userId) => user(userId).listConnections(),
    revokeConnection: (userId, authId) => user(userId).revokeConnection(authId),
    listFlows: (userId) => user(userId).listFlows(),
    enable: (userId, serviceId, authId) => user(userId).enable(serviceId, authId),
    setFlowStatus: (userId, scriptId, status) => user(userId).setFlowStatus(scriptId, status),
    listOptions: (userId, actionVersionId, params) => user(userId).listOptions(actionVersionId, params),
    runAction: (scriptId, actionVersionId, inputData) => viasocket.runAction(scriptId, actionVersionId, inputData)
  }
}
