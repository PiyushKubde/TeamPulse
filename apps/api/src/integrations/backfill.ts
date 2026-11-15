// Initial import. Jira through a per-user flow running Find_Issue_via_JQL; Linear through runCode on the user's
// enabled app (Linear's catalog has no "list issues" action: this code is KONVO's to maintain if Linear's API changes).
import { prisma, type IntegrationConnection, type Prisma } from '../lib/prisma.js'
import { badRequest } from '../lib/errors.js'
import { viasocket } from './viasocket/client.js'
import { enabledScriptId } from './connections.js'
import { runFlow } from './flows.js'
import { normalizeIssue as linearIssue } from './providers/linear.js'
import { normalize as jiraNormalize } from './providers/jira.js'
import { applyTask } from './normalization/normalizer.js'
import type { NormalizedTask } from './normalization/types.js'
import type { ConnectionSettings } from './catalog.js'

const LINEAR_QUERY = `query KONVOBackfill($team: String!, $after: String, $since: DateTimeOrDuration) {
  team(id: $team) { issues(first: 50, after: $after, filter: { updatedAt: { gte: $since } }, orderBy: updatedAt) {
    nodes { id identifier title description url priority dueDate updatedAt archivedAt state { name type } assignee { id name email } labels { nodes { name } } }
    pageInfo { hasNextPage endCursor } } } }`

const LINEAR_CODE = `const r = await axios.post("https://api.linear.app/graphql", { query: context.inputData.query, variables: context.inputData.variables })
if (r.data?.errors?.length) throw new Error(r.data.errors[0].message)
return r.data.data`

async function linearPages(conn: IntegrationConnection, teamId: string, since: string) {
  const scriptId = await enabledScriptId(conn)
  const out: NormalizedTask[] = []
  let after: string | null = null
  for (let page = 0; page < 40; page++) {
    const data = (await viasocket().runCode(scriptId, LINEAR_CODE, { query: LINEAR_QUERY, variables: { team: teamId, after, since } })) as {
      team?: { issues?: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } }
    }
    const issues = data?.team?.issues
    if (!issues) break
    out.push(...issues.nodes.map((n) => linearIssue(n)))
    if (!issues.pageInfo.hasNextPage) break
    after = issues.pageInfo.endCursor
  }
  return out
}

async function jiraItems(conn: IntegrationConnection, projectKey: string, since: Date) {
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(projectKey)) throw badRequest('Invalid Jira project.')
  const stamp = since.toISOString().slice(0, 16).replace('T', ' ').replace(/-/g, '/')
  const jql = `project = "${projectKey}" AND updated >= "${stamp}" ORDER BY updated ASC`
  const out = await runFlow(conn, 'jira_backfill', { jql })
  const n = jiraNormalize('task', out)
  return n.type === 'task' ? n.items : []
}

/** Imports issues updated since the checkpoint (default: last 90 days). Applies them like live events, as backfill. */
export async function runBackfill(connectionId: string) {
  const conn = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connectionId } })
  const s = conn.settings as ConnectionSettings
  const resource = conn.provider === 'linear' ? s.teamId : s.projectKey
  if (!resource) throw badRequest('Choose what to import first.')
  const cp = await prisma.syncCheckpoint.findUnique({ where: { connectionId_resource: { connectionId, resource } } })
  const since = cp?.cursor ? new Date(cp.cursor) : new Date(Date.now() - 90 * 864e5)
  const items =
    conn.provider === 'linear'
      ? await linearPages(conn, resource, since.toISOString())
      : conn.provider === 'jira-software-cloud'
        ? await jiraItems(conn, resource, since)
        : []
  const counts: Record<string, number> = {}
  let newest = since
  for (const n of items) {
    const r = await applyTask(conn, n, { backfill: true })
    counts[r.outcome] = (counts[r.outcome] ?? 0) + 1
    if (n.externalUpdatedAt && n.externalUpdatedAt > newest) newest = n.externalUpdatedAt
    await prisma.syncEvent.upsert({
      where: {
        orgId_provider_idempotencyKey: {
          orgId: conn.orgId,
          provider: conn.provider,
          idempotencyKey: `backfill:${n.externalId}:${n.externalUpdatedAt?.toISOString() ?? ''}`,
        },
      },
      create: {
        orgId: conn.orgId,
        connectionId: conn.id,
        provider: conn.provider,
        eventType: 'backfill',
        idempotencyKey: `backfill:${n.externalId}:${n.externalUpdatedAt?.toISOString() ?? ''}`,
        payload: { externalId: n.externalId, key: n.externalKey } as Prisma.InputJsonValue,
        status: r.outcome === 'stale' ? 'SKIPPED_STALE' : r.flagged.length ? 'NEEDS_MAPPING' : 'PROCESSED',
        taskId: r.taskId,
        processedAt: new Date(),
        attempts: 1,
        error: 'reason' in r ? r.reason : r.flagged.length ? `Needs review: ${r.flagged.join(', ')}` : null,
      },
      update: {},
    })
  }
  await prisma.syncCheckpoint.upsert({
    where: { connectionId_resource: { connectionId, resource } },
    create: { connectionId, resource, cursor: newest.toISOString(), lastRunAt: new Date() },
    update: { cursor: newest.toISOString(), lastRunAt: new Date() },
  })
  await prisma.integrationConnection.update({ where: { id: connectionId }, data: { lastSyncAt: new Date(), lastError: null } })
  return { imported: items.length, ...counts }
}
