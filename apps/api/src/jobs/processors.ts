import { registerInline } from './queues.js'
import { processSyncEvent } from '../integrations/ingest.js'
import { pushOutbound } from '../integrations/outbound.js'
import { runBackfill } from '../integrations/backfill.js'
import { hourly, nightly, weeklyReports } from './scheduled.js'

/** Job name → handler. The worker routes BullMQ jobs here; tests call them inline. */
export const PROCESSORS = {
  'ingest:event': (d: { eventId: string }, attempt?: number) => processSyncEvent(d.eventId, { attempt }),
  'ingest:outbound': (d: { taskId: string; status: string }) => pushOutbound(d.taskId, d.status),
  'ingest:backfill': (d: { connectionId: string }) => runBackfill(d.connectionId),
  'reminders:hourly': () => hourly(),
  'snapshots:nightly': () => nightly(),
  'reports:weekly': () => weeklyReports(),
} as const

for (const [k, fn] of Object.entries(PROCESSORS)) {
  const [q, job] = k.split(':') as [never, string]
  registerInline(q, job, (d) => (fn as (d: unknown) => Promise<unknown>)(d).catch(() => undefined))
}
