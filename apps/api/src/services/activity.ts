import { prisma, type Actor } from '../lib/prisma.js'

export const TRACKED_FIELDS = [
  'title',
  'status',
  'priority',
  'assigneeId',
  'dueAt',
  'projectId',
  'estimateMins',
  'impactLevel',
  'complexity',
  'category',
  'parentId',
] as const

const str = (v: unknown) => (v == null ? null : v instanceof Date ? v.toISOString() : String(v))

/** One activity row per changed tracked field. */
export async function recordChanges(taskId: string, before: Record<string, unknown>, after: Record<string, unknown>, actorType: Actor, actorId: string | null) {
  const rows = TRACKED_FIELDS.filter((f) => f in after && str(before[f]) !== str(after[f])).map((f) => ({
    taskId,
    actorType,
    actorId,
    kind: 'field_changed',
    field: f,
    fromValue: str(before[f]),
    toValue: str(after[f]),
  }))
  if (rows.length) await prisma.taskActivity.createMany({ data: rows })
}

export const logActivity = (taskId: string, kind: string, actorType: Actor, actorId: string | null, toValue?: string) =>
  prisma.taskActivity.create({ data: { taskId, kind, actorType, actorId, toValue: toValue ?? null } })
