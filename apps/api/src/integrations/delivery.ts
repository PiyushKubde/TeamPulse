import { prisma } from '../lib/prisma.js'
import { badRequest } from '../lib/errors.js'
import { runFlow } from './flows.js'

/** Posts to the user's own Slack destination (chosen once in Integrations), through their delivery flow. */
export async function deliverToSlack(userId: string, orgId: string, text: string, dedupeKey: string) {
  const conn = await prisma.integrationConnection.findFirst({ where: { userId, orgId, provider: 'slack', status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' } })
  if (!conn) throw badRequest('Connect Slack and choose a channel in Integrations first.')
  const exec = await prisma.automationExecution.upsert({
    where: { dedupeKey },
    create: { orgId, userId, automation: 'slack_delivery', status: 'RUNNING', dedupeKey },
    update: { attempts: { increment: 1 } },
  })
  if (exec.status === 'SUCCEEDED') return
  try {
    await runFlow(conn, 'slack_delivery', { text })
    await prisma.automationExecution.update({ where: { id: exec.id }, data: { status: 'SUCCEEDED', attempts: { increment: 1 } } })
  } catch (e) {
    await prisma.automationExecution.update({
      where: { id: exec.id },
      data: { status: 'FAILED', error: e instanceof Error ? e.message.slice(0, 500) : 'failed' },
    })
    throw e
  }
}

export async function deliverToGmail(userId: string, orgId: string, subject: string, text: string, dedupeKey: string) {
  const conn = await prisma.integrationConnection.findFirst({ where: { userId, orgId, provider: 'gmail', status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' } })
  if (!conn) throw badRequest('Connect Gmail in Integrations first.')
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } })
  const exec = await prisma.automationExecution.upsert({
    where: { dedupeKey },
    create: { orgId, userId, automation: 'gmail_delivery', status: 'RUNNING', dedupeKey },
    update: { attempts: { increment: 1 } },
  })
  if (exec.status === 'SUCCEEDED') return
  try {
    await runFlow(conn, 'gmail_delivery', { subject, text }, { email: user.email })
    await prisma.automationExecution.update({ where: { id: exec.id }, data: { status: 'SUCCEEDED' } })
  } catch (e) {
    await prisma.automationExecution.update({
      where: { id: exec.id },
      data: { status: 'FAILED', error: e instanceof Error ? e.message.slice(0, 500) : 'failed' },
    })
    throw e
  }
}
