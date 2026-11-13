// The one viaSocket client, server only: viasocket-apps 0.19 (https://viasocket.com/docs/skill.md?format=sdk).
// Apps are named by slug, actions and triggers by key with a pinned version. Everything KONVO asks of viaSocket
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
    updateSubscription: (userId, scriptId, params) => user(userId).updateSubscription(scriptId, params),
    // viaSocket's built-in AI (https://viasocket.com/docs/ai.md): one message to the assistant viaSocket runs for
    // this identifier. Used by the work-measurement engine with its own identifier, never an employee's chat.
    aiSend: (identifier, params) => user(identifier).ai.send(params),
    // Runs of one of this user's flows, last 30 days (https://viasocket.com/docs/automations.md?format=sdk, runHistory).
    // The user-scoped token is derived per call and never stored; viaSocket answers 403 for another user's flow.
    flowRuns: async (userId, scriptId, { page = 1, limit = 20 } = {}) => {
      const reg = await fetch('https://flow-api.viasocket.com/users/register', { headers: { authorization: await user(userId).token() }, signal: AbortSignal.timeout(15000) })
      const regBody = await reg.json().catch(() => ({}))
      if (!reg.ok || !regBody?.data?.token) { const e = new Error(regBody?.message || `automation token: ${reg.status}`); e.status = reg.status; throw e }
      const res = await fetch(`https://flow-api.viasocket.com/logs/orgId/${orgId}?projectId=${projectId}&scriptId=${encodeURIComponent(scriptId)}&page=${page}&limit=${limit}`, { headers: { proxy_auth_token: regBody.data.token }, signal: AbortSignal.timeout(15000) })
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body?.success === false) { const e = new Error(body?.message || `runHistory: ${res.status}`); e.status = res.status; throw e }
      return body.data
    }
  }
}
