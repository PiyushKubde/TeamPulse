// Two-way sync, WorkPulse → provider. Only for TWO_WAY connections, only status (Linear), only after a person mapped
// each WorkPulse status to one of their Linear states. Runs in the background so task saves never wait on Linear.
import { prisma, type Task } from '../lib/prisma.js'
import { enqueue } from '../jobs/queues.js'
import { runFlow } from './flows.js'
import type { ConnectionSettings } from './catalog.js'

export async function queueOutbound(taskId: string, before: Pick<Task, 'status'>, after: Pick<Task, 'status'>) {
  if (before.status === after.status) return
  const src = await prisma.taskSource.findUnique({ where: { taskId }, include: { connection: true } })
  if (!src?.connection || src.connection.syncMode !== 'TWO_WAY' || src.provider !== 'linear') return
  await enqueue('ingest', 'outbound', { taskId, status: after.status }, { jobId: `out:${taskId}:${after.status}:${Date.now()}` })
}

export async function pushOutbound(taskId: string, status: string) {
  const src = await prisma.taskSource.findUnique({ where: { taskId }, include: { connection: true } })
  if (!src?.connection || src.connection.syncMode !== 'TWO_WAY') return 'skipped'
  const stateId = (src.connection.settings as ConnectionSettings).statusMap?.[status]
  if (!stateId) return 'unmapped'
  await runFlow(src.connection, 'linear_status', { issue: src.externalId, stateID: stateId })
  // Record what we pushed as the last external value, so the echo event from Linear is not seen as a conflict.
  const last = { ...(src.lastExternal as Record<string, unknown>), status }
  await prisma.taskSource.update({ where: { id: src.id }, data: { lastExternal: last, lastSyncedAt: new Date() } })
  await prisma.taskActivity.create({ data: { taskId, kind: 'pushed_to_source', actorType: 'SYNC', field: 'status', toValue: status } })
  return 'pushed'
}
