// System email (verification, password reset, invitations, reports).
// Order: SMTP when configured → else the Gmail account an owner/admin connected in Integrations (through viaSocket) →
// else the message is kept in the log/outbox and the UI says email is not set up.
import nodemailer from 'nodemailer'
import { env, isTest } from '../config/env.js'
import { logger } from '../config/logger.js'
import { prisma } from './prisma.js'

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null

/** Mail outbox for tests and local development without any sender. */
export const devOutbox: { to: string; subject: string; text: string }[] = []

/** The Gmail connection that sends system email: MAIL_VIASOCKET_USER_ID's, else the oldest owner/admin connection. */
async function systemGmail() {
  const where = env.MAIL_VIASOCKET_USER_ID
    ? { provider: 'gmail', status: 'ACTIVE' as const, userId: env.MAIL_VIASOCKET_USER_ID }
    : {
        provider: 'gmail',
        status: 'ACTIVE' as const,
        user: { memberships: { some: { role: { in: ['OWNER' as const, 'ADMIN' as const] }, status: 'ACTIVE' as const } } },
      }
  return prisma.integrationConnection.findFirst({ where, orderBy: { createdAt: 'asc' } })
}

export async function mailConfigured() {
  return Boolean(transport) || Boolean(await systemGmail())
}

export async function sendMail(to: string, subject: string, text: string): Promise<{ delivered: boolean; via: 'smtp' | 'gmail' | 'none' }> {
  const { recordFailure, recordSuccess } = await import('../services/phone-alerts.js')
  if (transport) {
    try {
      await transport.sendMail({ from: env.MAIL_FROM, to, subject, text })
    } catch (e) {
      void recordFailure('email')
      throw e
    }
    void recordSuccess('email')
    return { delivered: true, via: 'smtp' }
  }
  const gmail = isTest ? null : await systemGmail()
  if (gmail) {
    try {
      const { runFlow } = await import('../integrations/flows.js')
      await runFlow(gmail, 'system_mail', { to, subject, text })
      void recordSuccess('email')
      return { delivered: true, via: 'gmail' }
    } catch (e) {
      void recordFailure('email')
      logger.error({ err: e instanceof Error ? e.message : e, to }, 'system email through Gmail failed')
    }
  }
  devOutbox.push({ to, subject, text })
  if (devOutbox.length > 100) devOutbox.shift()
  if (!isTest) logger.info({ to, subject }, `[mail not sent: no SMTP and no connected Gmail]\n${text}`)
  return { delivered: false, via: 'none' }
}
