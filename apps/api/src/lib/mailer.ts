import nodemailer from 'nodemailer'
import { env, isTest } from '../config/env.js'
import { logger } from '../config/logger.js'

const transport = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_SECURE,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    })
  : null

/** Mail outbox for tests and local development without SMTP. */
export const devOutbox: { to: string; subject: string; text: string }[] = []

export const mailConfigured = Boolean(transport)

export async function sendMail(to: string, subject: string, text: string) {
  if (!transport) {
    devOutbox.push({ to, subject, text })
    if (devOutbox.length > 100) devOutbox.shift()
    // Development only: no SMTP configured, so the message (including its link) goes to the log.
    if (!isTest) logger.info({ to, subject }, `[mail not sent: SMTP_HOST empty]\n${text}`)
    return { delivered: false }
  }
  await transport.sendMail({ from: env.MAIL_FROM, to, subject, text })
  return { delivered: true }
}
