// What runs when. On Embarko, its scheduler calls /api/internal/cron/:name (see embarko.json); locally, with no
// scheduler, the process runs the same jobs on time itself. On-call checks and the tick also run every minute in-process,
// so phone answers are read quickly; the scheduler's 5-minute tick is the backstop. A job never runs twice at once.
import { env, isTest } from '../config/env.js'
import { logger } from '../config/logger.js'
import { prisma } from '../lib/prisma.js'
import * as m91 from '../lib/m91.js'
import { enqueue } from './queues.js'
import { hourly, nightly, weeklyReports } from './scheduled.js'
import { checkOps, heartbeat, processPersonalAlerts, syncPhoneInvitations } from '../services/phone-alerts.js'

/** Sync events a restart left waiting (the queue is in memory) go back in the queue. */
async function requeueWaitingEvents() {
  const stale = await prisma.syncEvent.findMany({
    where: { status: { in: ['RECEIVED', 'PROCESSING'] }, receivedAt: { lt: new Date(Date.now() - 5 * 60000) }, attempts: { lt: 5 } },
    select: { id: true },
    take: 200,
  })
  for (const e of stale) await enqueue('ingest', 'event', { eventId: e.id }, { jobId: e.id })
}

async function tick() {
  await heartbeat('tick')
  await processPersonalAlerts()
  await syncPhoneInvitations()
  await requeueWaitingEvents()
}

export const SCHEDULES = { tick, hourly, nightly, weekly: weeklyReports } as const
export type ScheduleName = keyof typeof SCHEDULES
/** Long jobs answer the scheduler at once and carry on (it allows 5 minutes per call). */
export const BACKGROUND: ScheduleName[] = ['nightly', 'weekly']

const running = new Set<ScheduleName>()
export async function runSchedule(name: ScheduleName) {
  if (running.has(name)) return 'already running'
  running.add(name)
  try {
    await SCHEDULES[name]()
    return 'ok'
  } finally {
    running.delete(name)
  }
}

const log = (name: string) => (e: unknown) => logger.error({ job: name, err: e instanceof Error ? e.message : e }, 'scheduled job failed')

export function startClock() {
  if (isTest) return
  const selfScheduled = !env.CRON_SECRET
  const everyMinute = () => {
    const now = new Date()
    if (m91.channelConfigured()) void checkOps().catch(log('on-call checks'))
    void runSchedule('tick').catch(log('tick'))
    if (!selfScheduled) return
    // Same times as embarko.json (server time).
    if (now.getMinutes() === 5) void runSchedule('hourly').catch(log('hourly'))
    if (now.getHours() === 2 && now.getMinutes() === 0) void runSchedule('nightly').catch(log('nightly'))
    if (now.getDay() === 1 && now.getHours() === 8 && now.getMinutes() === 0) void runSchedule('weekly').catch(log('weekly'))
  }
  setInterval(everyMinute, 60_000).unref()
  logger.info(selfScheduled ? 'clock running: all scheduled jobs in-process' : 'clock running: Embarko schedules hourly, nightly and weekly jobs')
}
