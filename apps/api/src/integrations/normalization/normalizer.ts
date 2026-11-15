// Applies normalized external records to KONVO. The only code that writes external data into tasks.
// Rules: only EXTERNAL_FIELDS are ever written; impactLevel, complexity, assessments, evidence verification and
// feedback are internal-only. Stale events (older than what is stored) are skipped. In TWO_WAY mode a field changed
// on both sides since the last sync becomes a SyncConflict instead of being overwritten.
import { prisma, type IntegrationConnection, type Prisma, type TaskStatus } from '../../lib/prisma.js'
import { statusEffects } from '../../modules/tasks.js'
import { notify } from '../../services/notify.js'
import { chooseAssignee, recordAssignment, type AssignmentDecision } from '../../services/assignment.js'
import type { ConnectionSettings } from '../catalog.js'
import { mapPriority, mapStatus, normKey } from './status-mapping.js'
import type { NormalizedComment, NormalizedEvidence, NormalizedTask } from './types.js'

export const EXTERNAL_FIELDS = ['title', 'description', 'status', 'priority', 'assigneeId', 'dueAt', 'labels'] as const
type ExternalField = (typeof EXTERNAL_FIELDS)[number]

export type ApplyResult =
  | { outcome: 'created' | 'updated' | 'unchanged' | 'archived' | 'conflict'; taskId: string; flagged: string[] }
  | { outcome: 'stale' | 'skipped'; taskId: string | null; reason: string; flagged: string[] }

async function orgMappings(orgId: string, provider: string) {
  const rows = await prisma.syncMapping.findMany({ where: { orgId, provider, active: true } })
  const status = new Map<string, string>()
  const priority = new Map<string, string>()
  for (const r of rows) (r.kind === 'STATUS' ? status : priority).set(normKey(r.fromValue), r.toValue)
  return { status, priority }
}

/** Records an unknown value as a pending mapping for a person (or the AI, as a suggestion) to resolve. */
async function flagUnknown(orgId: string, provider: string, kind: 'STATUS' | 'PRIORITY', fromValue: string) {
  await prisma.syncMapping.upsert({
    where: { orgId_provider_kind_fromValue_version: { orgId, provider, kind, fromValue, version: 1 } },
    create: { orgId, provider, kind, fromValue, toValue: kind === 'STATUS' ? 'TODO' : 'MEDIUM', confidence: 0, source: 'DEFAULT', active: false },
    update: {},
  })
}

async function resolveAssignee(orgId: string, settings: ConnectionSettings, a: NormalizedTask['assignee']) {
  if (!a) return { id: null as string | null, unmapped: false }
  const mapped = a.externalId ? settings.userMap?.[a.externalId] : undefined
  if (mapped) {
    const ok = await prisma.organizationMember.findFirst({ where: { orgId, userId: mapped, status: 'ACTIVE' } })
    if (ok) return { id: mapped, unmapped: false }
  }
  if (a.email) {
    const m = await prisma.organizationMember.findFirst({ where: { orgId, status: 'ACTIVE', user: { email: a.email.toLowerCase() } } })
    if (m) return { id: m.userId, unmapped: false }
  }
  return { id: null, unmapped: true }
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a instanceof Date ? a.toISOString() : (a ?? null)) === JSON.stringify(b instanceof Date ? b.toISOString() : (b ?? null))

export async function applyTask(conn: IntegrationConnection, n: NormalizedTask, opts: { backfill?: boolean } = {}): Promise<ApplyResult> {
  const settings = (conn.settings ?? {}) as ConnectionSettings
  const maps = await orgMappings(conn.orgId, n.provider)
  const status = mapStatus(n.provider, n.rawStatus, n.rawStatusCategory, maps.status)
  const priority = mapPriority(n.rawPriority, maps.priority)
  const assignee = await resolveAssignee(conn.orgId, settings, n.assignee)
  const flagged: string[] = []
  if (status.source === 'FALLBACK' && (n.rawStatus || n.rawStatusCategory)) {
    flagged.push(`status "${n.rawStatus ?? n.rawStatusCategory}"`)
    await flagUnknown(conn.orgId, n.provider, 'STATUS', n.rawStatus ?? n.rawStatusCategory!)
  }
  if (priority.source === 'FALLBACK' && n.rawPriority) {
    flagged.push(`priority "${n.rawPriority}"`)
    await flagUnknown(conn.orgId, n.provider, 'PRIORITY', n.rawPriority)
  }
  if (assignee.unmapped) flagged.push(`assignee "${n.assignee?.email ?? n.assignee?.name ?? n.assignee?.externalId}"`)

  const external: Record<ExternalField, unknown> = {
    title: n.title.slice(0, 200),
    description: n.description?.slice(0, 20000) ?? null,
    status: status.value,
    priority: priority.value,
    assigneeId: assignee.id,
    dueAt: n.dueAt,
    labels: n.labels,
  }
  const sourceData = {
    externalKey: n.externalKey,
    sourceUrl: n.sourceUrl,
    externalUpdatedAt: n.externalUpdatedAt,
    externalRevision: n.revision,
    lastSyncedAt: new Date(),
    lastExternal: external as Prisma.InputJsonValue,
    connectionId: conn.id,
  }

  const existing = await prisma.taskSource.findUnique({
    where: { orgId_provider_externalId: { orgId: conn.orgId, provider: n.provider, externalId: n.externalId } },
    include: { task: true },
  })

  if (!existing) {
    if (n.deleted) return { outcome: 'skipped', taskId: null, reason: 'Deleted before it was imported.', flagged }
    if (conn.syncMode === 'IMPORT_ONLY' && !opts.backfill)
      return { outcome: 'skipped', taskId: null, reason: 'Import-only connection: live events do not create tasks.', flagged }
    const now = new Date()
    // No recognised assignee on open work: pick one automatically (the external name first, else best fit).
    // Work that is already finished stays unassigned: guessing who did past work would hand out false credit.
    let decision: AssignmentDecision | null = null
    if (!assignee.id && status.value !== 'COMPLETED' && status.value !== 'CANCELLED') {
      decision = await chooseAssignee(conn.orgId, conn.userId, {
        title: n.title,
        description: n.description,
        namedPerson: n.assignee?.name ?? n.assignee?.email ?? null,
      })
      if (decision.by === 'NAMED') flagged.splice(0, flagged.length, ...flagged.filter((f) => !f.startsWith('assignee')))
    }
    const assigneeId = assignee.id ?? decision?.userId ?? null
    const task = await prisma.task.create({
      data: {
        orgId: conn.orgId,
        creatorId: conn.userId,
        origin: 'EXTERNAL',
        title: external.title as string,
        description: external.description as string | null,
        status: status.value,
        priority: priority.value,
        assigneeId,
        dueAt: n.dueAt,
        labels: n.labels,
        needsReview: flagged.length > 0,
        startedAt: status.value === 'IN_PROGRESS' || status.value === 'IN_REVIEW' || status.value === 'COMPLETED' ? now : null,
        completedAt: status.value === 'COMPLETED' ? (n.externalUpdatedAt ?? now) : null,
        source: { create: { orgId: conn.orgId, provider: n.provider, externalId: n.externalId, rawSnapshot: {}, ...sourceData } },
      },
    })
    await prisma.taskActivity.create({
      data: { taskId: task.id, kind: 'imported', actorType: 'SYNC', toValue: `${n.provider}${n.externalKey ? ` ${n.externalKey}` : ''}` },
    })
    if (decision) await recordAssignment(task.id, decision, null)
    if (assigneeId && assigneeId !== conn.userId) {
      await notify({
        orgId: conn.orgId,
        userId: assigneeId,
        kind: 'external_task',
        title: `New task from ${n.provider}: ${task.title}`,
        link: `/tasks/${task.id}`,
        dedupeKey: `ext-new:${task.id}`,
      })
    }
    return { outcome: 'created', taskId: task.id, flagged }
  }

  const task = existing.task
  // Ordering guard: an event at or before the stored source timestamp is stale (retries, out-of-order delivery).
  if (existing.externalUpdatedAt && n.externalUpdatedAt && n.externalUpdatedAt <= existing.externalUpdatedAt) {
    return {
      outcome: 'stale',
      taskId: task.id,
      reason: `Event from ${n.externalUpdatedAt.toISOString()} is not newer than ${existing.externalUpdatedAt.toISOString()}.`,
      flagged,
    }
  }
  if (conn.syncMode === 'IMPORT_ONLY' && !opts.backfill) {
    return { outcome: 'skipped', taskId: task.id, reason: 'Import-only connection: updates are not applied.', flagged }
  }
  if (n.deleted) {
    await prisma.$transaction([
      prisma.task.update({ where: { id: task.id }, data: { archivedAt: task.archivedAt ?? new Date() } }),
      prisma.taskSource.update({ where: { id: existing.id }, data: sourceData }),
      prisma.taskActivity.create({ data: { taskId: task.id, kind: 'archived_by_source', actorType: 'SYNC', toValue: n.provider } }),
    ])
    return { outcome: 'archived', taskId: task.id, flagged }
  }

  const last = (existing.lastExternal ?? {}) as Partial<Record<ExternalField, unknown>>
  const internal: Record<ExternalField, unknown> = {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assigneeId: task.assigneeId,
    dueAt: task.dueAt,
    labels: task.labels,
  }
  const patch: Prisma.TaskUncheckedUpdateInput = {}
  const conflicts: { field: string; internalValue: string | null; externalValue: string | null }[] = []
  const changes: { field: string; from: unknown; to: unknown }[] = []
  for (const f of EXTERNAL_FIELDS) {
    if (same(external[f], internal[f])) continue
    const externalChanged = !(f in last) || !same(external[f], last[f])
    if (!externalChanged) continue // the external side did not change this field; keep KONVO's value
    const internalChanged = f in last && !same(internal[f], last[f])
    // An unmapped assignee never clears a KONVO assignee.
    if (f === 'assigneeId' && external[f] === null && assignee.unmapped) continue
    if (conn.syncMode === 'TWO_WAY' && internalChanged) {
      conflicts.push({ field: f, internalValue: JSON.stringify(internal[f] ?? null), externalValue: JSON.stringify(external[f] ?? null) })
      continue
    }
    ;(patch as Record<string, unknown>)[f] = external[f]
    changes.push({ field: f, from: internal[f], to: external[f] })
  }
  if (patch.status) Object.assign(patch, statusEffects(task, patch.status as TaskStatus, n.externalUpdatedAt ?? new Date()))
  if (flagged.length) patch.needsReview = true

  await prisma.$transaction([
    prisma.task.update({ where: { id: task.id }, data: patch }),
    prisma.taskSource.update({ where: { id: existing.id }, data: sourceData }),
    ...changes.map((c) =>
      prisma.taskActivity.create({
        data: {
          taskId: task.id,
          kind: 'field_changed',
          actorType: 'SYNC',
          field: c.field,
          fromValue: c.from == null ? null : String(c.from instanceof Date ? c.from.toISOString() : c.from),
          toValue: c.to == null ? null : String(c.to instanceof Date ? c.to.toISOString() : c.to),
        },
      }),
    ),
    ...conflicts.map((c) => prisma.syncConflict.create({ data: { taskId: task.id, ...c } })),
  ])
  if (conflicts.length) {
    await notify({
      orgId: conn.orgId,
      userId: conn.userId,
      kind: 'sync_conflict',
      title: `Sync conflict on "${task.title}"`,
      body: `Changed in KONVO and ${n.provider}: ${conflicts.map((c) => c.field).join(', ')}`,
      link: `/tasks/${task.id}`,
      dedupeKey: `conflict:${task.id}:${n.externalUpdatedAt?.toISOString() ?? Date.now()}`,
    })
    return { outcome: 'conflict', taskId: task.id, flagged }
  }
  if (changes.length && task.assigneeId && task.assigneeId !== conn.userId) {
    await notify({
      orgId: conn.orgId,
      userId: task.assigneeId,
      kind: 'external_update',
      title: `Updated in ${n.provider}: ${task.title}`,
      body: changes.map((c) => c.field).join(', '),
      link: `/tasks/${task.id}`,
      dedupeKey: `ext-upd:${task.id}:${n.externalUpdatedAt?.toISOString() ?? Date.now()}`,
    })
  }
  return { outcome: changes.length ? 'updated' : 'unchanged', taskId: task.id, flagged }
}

export async function applyComment(conn: IntegrationConnection, c: NormalizedComment): Promise<ApplyResult> {
  const src = await prisma.taskSource.findUnique({
    where: { orgId_provider_externalId: { orgId: conn.orgId, provider: c.provider, externalId: c.issueExternalId } },
  })
  if (!src) return { outcome: 'skipped', taskId: null, reason: 'Comment on an issue that is not in KONVO.', flagged: [] }
  await prisma.taskComment.upsert({
    where: { taskId_externalId: { taskId: src.taskId, externalId: c.externalId } },
    create: {
      taskId: src.taskId,
      externalId: c.externalId,
      body: `${c.author ? `**${c.author}** (via ${c.provider}): ` : ''}${c.body}`.slice(0, 10000),
      createdAt: c.createdAt ?? undefined,
    },
    update: { body: `${c.author ? `**${c.author}** (via ${c.provider}): ` : ''}${c.body}`.slice(0, 10000) },
  })
  return { outcome: 'updated', taskId: src.taskId, flagged: [] }
}

/** Task keys (ENG-42, PROJ-7, org/repo#12) mentioned in a PR/commit/release, matched against imported tasks. */
export async function matchByKey(orgId: string, text: string) {
  const keys = [...new Set(text.match(/\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b|[\w.-]+\/[\w.-]+#\d+/g) ?? [])].slice(0, 10)
  if (!keys.length) return null
  const src = await prisma.taskSource.findFirst({ where: { orgId, externalKey: { in: keys } }, select: { taskId: true } })
  return src?.taskId ?? null
}

export async function applyEvidence(conn: IntegrationConnection, e: NormalizedEvidence): Promise<ApplyResult & { evidenceId?: string }> {
  const taskId = await matchByKey(conn.orgId, e.searchText)
  const row = await prisma.evidence.upsert({
    where: { orgId_source_externalId: { orgId: conn.orgId, source: 'GITHUB', externalId: e.externalId } },
    create: {
      orgId: conn.orgId,
      taskId,
      kind: e.kind,
      source: 'GITHUB',
      title: e.title,
      url: e.url,
      externalId: e.externalId,
      sourceMeta: e.meta as Prisma.InputJsonValue,
      addedById: conn.userId,
    },
    update: { title: e.title, url: e.url, sourceMeta: e.meta as Prisma.InputJsonValue },
  })
  if (taskId) await prisma.taskActivity.create({ data: { taskId, kind: 'evidence_added', actorType: 'SYNC', toValue: e.title } })
  return {
    outcome: taskId ? 'updated' : 'skipped',
    taskId,
    reason: taskId ? undefined : 'No task key found; waiting for a match.',
    flagged: [],
    evidenceId: row.id,
  } as ApplyResult & { evidenceId: string }
}
