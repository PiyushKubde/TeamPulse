// Connections, the once-after-Connect choices, and the subscriptions built from them.
// auth_id and every script_id are stored encrypted, per user, and used only for the user who owns them.
import { prisma, type IntegrationConnection, type Prisma } from '../lib/prisma.js'
import { decrypt, encrypt, randomToken, sha256 } from '../lib/crypto.js'
import { badRequest, notFound, unavailable } from '../lib/errors.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { PROVIDERS, provider, type ConnectionSettings, type ProviderDef } from './catalog.js'
import { viasocket, vsUserId } from './viasocket/client.js'

interface VsConnection {
  id?: string
  auth_row_id?: string
  service_id?: string
  connection_label?: string
  isExpired?: boolean
}

export const authIdOf = (c: IntegrationConnection) => decrypt(c.authIdEnc)

/** The Connect popup needs the user's embed token and the app's service_id (never the secret). */
export async function connectSetup(userId: string, slug: string) {
  const def = provider(slug)
  if (!def) throw notFound('Integration')
  const user = viasocket().user(vsUserId(userId))
  const [embedToken, serviceId] = await Promise.all([user.token(), user.serviceIdFor(slug)])
  const actions = [...def.triggers.map((t) => t.triggerId), ...Object.values(ACTION_IDS[slug] ?? {})]
  return { embedToken, serviceId, actions }
}

const ACTION_IDS: Record<string, Record<string, string>> = {
  linear: { status: 'rowcz65p8jcd' },
  'jira-software-cloud': { jql: 'rowu6c69h46o' },
  slack: { send: 'row1jrbor' },
  gmail: { send: 'rowogelpy0h6' },
}

/** Ownership check: the auth_id must be one of THIS user's viaSocket connections, for this app. */
async function assertOwnsAuth(userId: string, slug: string, authId: string) {
  const user = viasocket().user(vsUserId(userId))
  const [list, serviceId] = await Promise.all([user.listConnections() as Promise<VsConnection[]>, user.serviceIdFor(slug)])
  const match = list.find((c) => c.id === authId || c.auth_row_id === authId)
  if (!match) throw badRequest('That connection does not belong to you. Connect the app again.')
  if (match.service_id && match.service_id !== serviceId) throw badRequest('That connection is for a different app.')
  return match
}

export async function saveConnection(orgId: string, userId: string, slug: string, authId: string) {
  const def = provider(slug)
  if (!def) throw notFound('Integration')
  const vs = await assertOwnsAuth(userId, slug, authId)
  const hash = sha256(authId)
  // The same account may be connected in several organizations: each organization has its own connection.
  const existing = await prisma.integrationConnection.findUnique({
    where: { orgId_userId_provider_authIdHash: { orgId, userId, provider: slug, authIdHash: hash } },
  })
  // Connecting the same app again (expired sign-in, more permissions) replaces the previous connection: its choices and
  // sync mode carry over and its flows are removed, so the user never ends up with two half-configured connections.
  const previous = await prisma.integrationConnection.findFirst({
    where: { orgId, userId, provider: slug, authIdHash: { not: hash }, status: { not: 'REVOKED' } },
    orderBy: { updatedAt: 'desc' },
  })
  const conn = await prisma.integrationConnection.upsert({
    where: { orgId_userId_provider_authIdHash: { orgId, userId, provider: slug, authIdHash: hash } },
    create: {
      orgId,
      userId,
      provider: slug,
      authIdEnc: encrypt(authId),
      authIdHash: hash,
      label: vs.connection_label ?? null,
      settings: (previous?.settings ?? {}) as Prisma.InputJsonValue,
      syncMode: previous?.syncMode ?? 'ONE_WAY',
    },
    // Reconnect in place: same auth_id, status back to active; choices are kept.
    update: { status: 'ACTIVE', lastError: null, label: vs.connection_label ?? existing?.label ?? null },
  })
  if (previous) {
    await prisma.taskSource.updateMany({ where: { connectionId: previous.id }, data: { connectionId: conn.id } })
    // The old sign-in may be the same viaSocket account; only revoke it when it is a different auth.
    await disconnect(previous, true).catch((e) => logger.warn({ err: e instanceof Error ? e.message : e }, 'could not retire previous connection'))
    if (def.triggers.length)
      await syncSubscriptions(conn).catch((e) => logger.warn({ err: e instanceof Error ? e.message : e }, 'could not subscribe after reconnect'))
  }
  return conn
}

/** Owner-only lookup. Anyone else gets 404, so ids of other people's connections are useless. */
export async function ownConnection(userId: string, orgId: string, id: string) {
  const c = await prisma.integrationConnection.findFirst({ where: { id, userId, orgId } })
  if (!c) throw notFound('Connection')
  return c
}

/** Options for a picker (team, project, repo, channel), from the event the catalog names. */
export async function pickerOptions(conn: IntegrationConnection, fieldKey: string, search?: string, paginate?: string) {
  const def = provider(conn.provider)!
  const picker = def.pickers.find((p) => p.fieldKey === fieldKey)
  if (!picker) throw badRequest('Unknown field.')
  const settings = conn.settings as ConnectionSettings
  const needs = picker.needs?.(settings) ?? {}
  if (Object.values(needs).some((v) => v === undefined)) throw badRequest('Choose the team first.')
  return viasocket()
    .user(vsUserId(conn.userId))
    .listOptions(picker.app, picker.event, {
      fieldKey,
      authId: authIdOf(conn),
      version: picker.version,
      existingFields: needs,
      search: search || undefined,
      paginate: paginate ? JSON.parse(paginate) : undefined,
    })
}

const handlerFor = (providerSlug: string, subscriptionId: string, token: string) => {
  const url = `${env.PUBLIC_API_URL!.replace(/\/$/, '')}/api/integrations/events/${providerSlug}/${subscriptionId}`
  // Runs on viaSocket per event: forwards the raw event to WorkPulse, authenticated with this subscription's token.
  // ngrok-skip-browser-warning: harmless elsewhere; lets a local ngrok tunnel pass the request straight through.
  return `await axios.post(${JSON.stringify(url)}, { event: context.req.body }, { headers: { authorization: ${JSON.stringify(`Bearer ${token}`)}, 'ngrok-skip-browser-warning': '1' }, timeout: 20000 })\nreturn { forwarded: true }`
}

export interface SubscriptionPlan {
  triggerKey: string
  resource: string
  inputData: Record<string, unknown>
}

export function plannedSubscriptions(def: ProviderDef, settings: ConnectionSettings, syncMode: string): SubscriptionPlan[] {
  // Import-only connections take a one-time backfill and no live events.
  if (syncMode === 'IMPORT_ONLY' && def.capabilities.includes('tasks') && !def.capabilities.includes('evidence')) return []
  return def.triggers
    .filter((t) => (t.enabled ? t.enabled(settings) : true))
    .flatMap((t) => t.inputs(settings).map((i) => ({ triggerKey: t.key, resource: i.resource, inputData: i.inputData })))
}

/**
 * Brings the viaSocket subscriptions of a connection in line with its current choices:
 * creates missing ones, removes ones no longer wanted. Each new subscription gets its own bearer token.
 */
export async function syncSubscriptions(conn: IntegrationConnection) {
  const def = provider(conn.provider)!
  const wanted = plannedSubscriptions(def, conn.settings as ConnectionSettings, conn.syncMode)
  const current = await prisma.integrationSubscription.findMany({ where: { connectionId: conn.id } })
  if (wanted.length && !env.PUBLIC_API_URL) {
    throw unavailable('public_url_missing', 'Live sync needs PUBLIC_API_URL: a public HTTPS address where viaSocket can reach WorkPulse.')
  }
  const user = viasocket().user(vsUserId(conn.userId))
  const authId = authIdOf(conn)
  const results: { triggerKey: string; resource: string; status: string; error?: string }[] = []

  for (const sub of current) {
    const keep = wanted.some(
      (w) => w.triggerKey === sub.triggerKey && w.resource === sub.resource && JSON.stringify(w.inputData) === JSON.stringify(sub.inputData),
    )
    if (keep && sub.status === 'ACTIVE') continue
    if (sub.scriptIdEnc) await user.deleteFlow(decrypt(sub.scriptIdEnc)).catch((e) => logger.warn({ err: e?.message }, 'deleteFlow failed'))
    await prisma.integrationSubscription.delete({ where: { id: sub.id } })
  }

  for (const w of wanted) {
    const exists = await prisma.integrationSubscription.findUnique({
      where: { connectionId_triggerKey_resource: { connectionId: conn.id, triggerKey: w.triggerKey, resource: w.resource } },
    })
    if (exists?.status === 'ACTIVE') {
      results.push({ triggerKey: w.triggerKey, resource: w.resource, status: 'ACTIVE' })
      continue
    }
    const trigger = def.triggers.find((t) => t.key === w.triggerKey)!
    const token = randomToken(32)
    const row = await prisma.integrationSubscription.create({
      data: {
        connectionId: conn.id,
        triggerKey: w.triggerKey,
        resource: w.resource,
        version: trigger.version,
        inputData: w.inputData as Prisma.InputJsonValue,
        tokenHash: sha256(token),
        status: 'PENDING',
      },
    })
    const code = handlerFor(conn.provider, row.id, token)
    try {
      const sub = await user.subscribe(conn.provider, w.triggerKey, {
        authId,
        inputData: w.inputData,
        version: trigger.version,
        code,
        description: `WorkPulse: ${def.name} ${w.triggerKey.replace(/_/g, ' ')} (${w.resource})`,
        meta: { workpulseSubscription: row.id },
      })
      await prisma.integrationSubscription.update({
        where: { id: row.id },
        data: { scriptIdEnc: encrypt(sub.scriptId), handlerHash: sha256(code), handlerBase: env.PUBLIC_API_URL ?? null, status: 'ACTIVE' },
      })
      results.push({ triggerKey: w.triggerKey, resource: w.resource, status: 'ACTIVE' })
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 300) : 'subscribe failed'
      await prisma.integrationSubscription.update({ where: { id: row.id }, data: { status: 'ERROR' } })
      results.push({ triggerKey: w.triggerKey, resource: w.resource, status: 'ERROR', error: message })
    }
  }
  const errors = results.filter((r) => r.status === 'ERROR')
  await prisma.integrationConnection.update({
    where: { id: conn.id },
    data: { lastError: errors.length ? errors.map((e) => `${e.triggerKey}: ${e.error}`).join('; ') : null, status: errors.length ? 'ERROR' : 'ACTIVE' },
  })
  return results
}

/**
 * Start-up reconciliation: creates subscriptions that could not be made earlier (no public URL then) and re-points
 * handlers whose public URL changed (a new tunnel), each with a fresh token. Never throws.
 */
export async function reconcileSubscriptions() {
  if (!env.PUBLIC_API_URL) return { repointed: 0, synced: 0 }
  let repointed = 0
  let synced = 0
  const subs = await prisma.integrationSubscription.findMany({
    where: {
      status: 'ACTIVE',
      scriptIdEnc: { not: null },
      NOT: { triggerKey: { startsWith: 'flow:' } },
      OR: [{ handlerBase: null }, { handlerBase: { not: env.PUBLIC_API_URL } }],
    },
    include: { connection: true },
  })
  for (const sub of subs) {
    try {
      const token = randomToken(32)
      const code = handlerFor(sub.connection.provider, sub.id, token)
      await viasocket().user(vsUserId(sub.connection.userId)).updateSubscription(decrypt(sub.scriptIdEnc!), { code })
      await prisma.integrationSubscription.update({
        where: { id: sub.id },
        data: { tokenHash: sha256(token), handlerHash: sha256(code), handlerBase: env.PUBLIC_API_URL },
      })
      repointed++
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e, subscription: sub.id }, 'could not re-point subscription')
    }
  }
  const conns = await prisma.integrationConnection.findMany({ where: { status: { in: ['ACTIVE', 'ERROR'] } } })
  for (const c of conns) {
    const def = provider(c.provider)
    if (!def || !def.triggers.length) continue
    const wanted = plannedSubscriptions(def, c.settings as ConnectionSettings, c.syncMode).length
    const have = await prisma.integrationSubscription.count({ where: { connectionId: c.id, status: 'ACTIVE', NOT: { triggerKey: { startsWith: 'flow:' } } } })
    if (wanted > have) {
      await syncSubscriptions(c).catch((e) => logger.warn({ err: e instanceof Error ? e.message : e }, 'could not create subscriptions'))
      synced++
    }
  }
  if (repointed || synced) logger.info({ repointed, synced, base: env.PUBLIC_API_URL }, 'subscriptions reconciled')
  return { repointed, synced }
}

/** Removes every flow WorkPulse made on the connection, then revokes the connection at viaSocket. */
export async function disconnect(conn: IntegrationConnection, revoke = true) {
  const user = viasocket().user(vsUserId(conn.userId))
  const subs = await prisma.integrationSubscription.findMany({ where: { connectionId: conn.id } })
  for (const s of subs) if (s.scriptIdEnc) await user.deleteFlow(decrypt(s.scriptIdEnc)).catch(() => undefined)
  // The same account can be connected in another organization: keep its sign-in and the shared enabled app then.
  const stillUsed = await prisma.integrationConnection.count({
    where: { id: { not: conn.id }, userId: conn.userId, provider: conn.provider, status: { not: 'REVOKED' } },
  })
  const sameAuthElsewhere = await prisma.integrationConnection.count({
    where: { id: { not: conn.id }, userId: conn.userId, provider: conn.provider, authIdHash: conn.authIdHash, status: { not: 'REVOKED' } },
  })
  if (conn.enabledScriptIdEnc && !stillUsed) await user.deleteFlow(decrypt(conn.enabledScriptIdEnc)).catch(() => undefined)
  if (revoke && !sameAuthElsewhere) await user.revokeConnection(authIdOf(conn)).catch((e) => logger.warn({ err: e?.message }, 'revokeConnection failed'))
  await prisma.$transaction([
    prisma.integrationSubscription.deleteMany({ where: { connectionId: conn.id } }),
    prisma.integrationConnection.update({ where: { id: conn.id }, data: { status: 'REVOKED', enabledScriptIdEnc: null } }),
  ])
}

/** Marks connections viaSocket reports as expired, so the UI offers "Reconnect" (which updates the same auth_id). */
export async function refreshConnectionHealth(userId: string) {
  const conns = await prisma.integrationConnection.findMany({ where: { userId, status: { in: ['ACTIVE', 'EXPIRED', 'ERROR'] } } })
  if (!conns.length) return
  const list = (await viasocket().user(vsUserId(userId)).listConnections()) as VsConnection[]
  for (const c of conns) {
    const authId = authIdOf(c)
    const vs = list.find((x) => x.id === authId || x.auth_row_id === authId)
    const status = !vs ? 'REVOKED' : vs.isExpired ? 'EXPIRED' : c.status === 'EXPIRED' ? 'ACTIVE' : c.status
    if (status !== c.status) {
      await prisma.integrationConnection.update({ where: { id: c.id }, data: { status } })
      if (status === 'EXPIRED') {
        const { phoneAlertConnectionExpired } = await import('../services/phone-alerts.js')
        await phoneAlertConnectionExpired(c)
      }
    }
  }
}

/** The enabled app (one flow per user and app) used to run actions such as Update_Issue_Status. */
export async function enabledScriptId(conn: IntegrationConnection) {
  if (conn.enabledScriptIdEnc) return decrypt(conn.enabledScriptIdEnc)
  const user = viasocket().user(vsUserId(conn.userId))
  const scriptId = (await user.findEnabled(conn.provider)) ?? (await user.enable(conn.provider, authIdOf(conn))).scriptId
  await prisma.integrationConnection.update({ where: { id: conn.id }, data: { enabledScriptIdEnc: encrypt(scriptId) } })
  return scriptId
}

export const catalogList = () => Object.values(PROVIDERS)
