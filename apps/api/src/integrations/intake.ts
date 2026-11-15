// Chat message → task. AI (when configured) decides whether a message asks for work and extracts its fields;
// WorkPulse validates everything and creates the task. Without AI every human message becomes a task flagged for review.
import { z } from 'zod'
import { IMPACT_LEVELS, PRIORITIES } from '@workpulse/shared'
import { prisma, type IntegrationConnection } from '../lib/prisma.js'
import { todayIn } from '../lib/dates.js'
import { env } from '../config/env.js'
import { logger } from '../config/logger.js'
import { aiStatus, structured } from '../ai/provider.js'
import { notify } from '../services/notify.js'
import type { ApplyResult } from './normalization/normalizer.js'
import type { NormalizedMessage } from './normalization/types.js'
import type { ConnectionSettings } from './catalog.js'
import { chooseAssignee, recordAssignment } from '../services/assignment.js'

const draftSchema = z.object({
  isTask: z.boolean(),
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullable(),
  priority: z.enum(PRIORITIES),
  dueDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  assigneeName: z.string().max(200).nullable(),
  impact: z.enum(IMPACT_LEVELS),
  reason: z.string().max(300),
})

const firstLine = (text: string) =>
  text
    .split('\n')[0]!
    .replace(/<[@#!][^>]*>/g, '')
    .trim()
    .slice(0, 200) || 'Task from Slack'

export async function applyIntake(conn: IntegrationConnection, m: NormalizedMessage): Promise<ApplyResult & { taskTitle?: string }> {
  if (m.ignore) return { outcome: 'skipped', taskId: null, reason: 'Bot, edited or system message: not turned into a task.', flagged: [] }
  const existing = await prisma.taskSource.findUnique({
    where: { orgId_provider_externalId: { orgId: conn.orgId, provider: 'slack', externalId: m.externalId } },
  })
  if (existing) return { outcome: 'skipped', taskId: existing.taskId, reason: 'This message already created a task.', flagged: [] }

  const members = (
    await prisma.organizationMember.findMany({ where: { orgId: conn.orgId, status: 'ACTIVE' }, select: { userId: true, user: { select: { name: true } } } })
  ).map((x) => ({ userId: x.userId, name: x.user.name }))
  const owner = await prisma.user.findUniqueOrThrow({ where: { id: conn.userId }, select: { name: true, timezone: true } })

  let draft: z.infer<typeof draftSchema> | null = null
  if (aiStatus().configured) {
    try {
      draft = await structured({
        userId: conn.userId,
        name: 'slack_intake',
        system: [
          `You read one Slack message posted by ${owner.name} and turn it into a task for a work tracker. Today is ${todayIn(owner.timezone)}.`,
          'isTask is false only for messages that ask for no work (greetings, thanks, FYIs, questions answered by yes/no, chatter).',
          'title: short imperative outcome (e.g. "Deploy the M91 feature"). description: the useful details, including people or systems mentioned.',
          `assigneeName: only when the message clearly asks a specific person to do the work, and only if it is one of: ${members.map((x) => x.name).join(', ') || 'nobody'}. Otherwise null (WorkPulse then picks the best-fit teammate).`,
          'dueDate: resolve relative dates ("by Friday") against today, else null. priority from urgency words; MEDIUM by default. impact is only a suggestion; NONE if unclear.',
          'Use only what the message says. Never invent people, dates or details.',
        ].join('\n'),
        input: m.text.slice(0, 4000),
        schema: draftSchema,
      })
    } catch (e) {
      logger.warn({ err: e instanceof Error ? e.message : e }, 'slack intake AI failed; creating the task without AI')
    }
  }
  if (draft && !draft.isTask) return { outcome: 'skipped', taskId: null, reason: `Not a task request (AI): ${draft.reason}`, flagged: [] }

  const title = draft?.title ?? firstLine(m.text)
  const decision = await chooseAssignee(conn.orgId, conn.userId, { title, description: draft?.description ?? m.text, namedPerson: draft?.assigneeName })
  const assigneeId = decision.userId
  const description = [draft?.description, `From Slack:\n> ${m.text.slice(0, 3000)}`].filter(Boolean).join('\n\n')
  const task = await prisma.task.create({
    data: {
      orgId: conn.orgId,
      creatorId: conn.userId,
      assigneeId,
      origin: 'EXTERNAL',
      title,
      description,
      status: 'TODO',
      priority: draft?.priority ?? 'MEDIUM',
      impactLevel: draft?.impact ?? 'NONE',
      dueAt: draft?.dueDate ? new Date(`${draft.dueDate}T17:00:00Z`) : null,
      category: 'From Slack',
      // Without AI nobody checked the wording or the fields yet.
      needsReview: !draft,
      source: {
        create: {
          orgId: conn.orgId,
          provider: 'slack',
          externalId: m.externalId,
          externalKey: `#${(conn.settings as ConnectionSettings).intake?.label ?? m.channel}`,
          sourceUrl: `https://slack.com/app_redirect?channel=${encodeURIComponent(m.channel)}`,
          connectionId: conn.id,
          rawSnapshot: { channel: m.channel, ts: m.ts },
        },
      },
    },
  })
  await prisma.taskActivity.create({ data: { taskId: task.id, kind: 'imported', actorType: draft ? 'AI' : 'SYNC', toValue: 'slack message' } })
  await recordAssignment(task.id, decision, null)
  await notify({
    orgId: conn.orgId,
    userId: assigneeId,
    kind: 'external_task',
    title: `New task from Slack: ${task.title}`,
    link: `/tasks/${task.id}`,
    dedupeKey: `slack-task:${task.id}`,
  })
  return { outcome: 'created', taskId: task.id, flagged: draft ? [] : ['created without AI'], taskTitle: task.title }
}

/** Confirmation in the user's Slack destination (a bot message, so it is never re-ingested). */
export function confirmationText(title: string, taskId: string) {
  return `:white_check_mark: Task created in WorkPulse: *${title}*\n${env.APP_URL}/tasks?task=${taskId}`
}
