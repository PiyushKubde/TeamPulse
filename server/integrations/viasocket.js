// The one viaSocket client, server only: viasocket-apps 0.19 (https://viasocket.com/docs/skill.md?format=sdk).
// Apps are named by slug, actions and triggers by key with a pinned version. Everything TeamPulse asks of viaSocket
// goes through this one object, so tests can pass a stand-in (never counted as a live test).
import { ViaSocket } from 'viasocket-apps'

export function createViasocketGateway({ orgId, projectId, secret }) {
  if (!(orgId && projectId && secret)) return { configured: false }
  const viasocket = new ViaSocket({ orgId, projectId, secret })
  const user = (id) => viasocket.user(String(id))
  return {
    configured: true,
    serviceIdFor: (slug) => viasocket.catalog.serviceIdFor(slug),
    versions: (serviceId) => viasocket.catalog.versions(serviceId),
    token: (userId) => user(userId).token(),
    listConnections: (userId) => user(userId).listConnections(),
    revokeConnection: (userId, authId) => user(userId).revokeConnection(authId),
    listFlows: (userId) => user(userId).listFlows(),
    setFlowStatus: (userId, scriptId, status) => user(userId).setFlowStatus(scriptId, status),
    listActions: (userId, app) => user(userId).listActions(app),
    findEnabled: (userId, app) => user(userId).findEnabled(app),
    enable: (userId, app, authId) => user(userId).enable(app, authId),
    listOptions: (userId, app, actionKey, params) => user(userId).listOptions(app, actionKey, params),
    runAction: (scriptId, actionKey, inputData, version) => viasocket.runAction(scriptId, actionKey, inputData, { version }),
    sampleEvent: (triggerId, authId, authType, inputData) => viasocket.sampleEvent(triggerId, authId, authType, inputData),
    subscribe: (userId, app, triggerKey, params) => user(userId).subscribe(app, triggerKey, params),
    updateSubscription: (userId, scriptId, params) => user(userId).updateSubscription(scriptId, params)
  }
}
