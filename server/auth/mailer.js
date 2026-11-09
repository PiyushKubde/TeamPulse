// Transactional email (verification, password reset). Two real providers, chosen by MAIL_PROVIDER:
//   smtp            — any SMTP service (Postmark, SES, Resend, SendGrid, MSG91, Gmail app password…) via nodemailer
//   viasocket_gmail — a Gmail account connected in TeamPulse's Automation Center, sent through viaSocket
// With neither configured, `configured` is false and nothing pretends to send: email sign-up and password reset
// say they are unavailable. Tests inject a capturing mailer.
import nodemailer from 'nodemailer'
import { loadContext } from '../access.js'
import { runOnce, gmailInput, readGmailResult } from '../integrations/actions.js'

export function createMailer(mail, { db, vs } = {}) {
  const from = mail.from
  if (mail.provider === 'smtp' && mail.smtp.host && from) {
    const transport = nodemailer.createTransport({
      host: mail.smtp.host, port: mail.smtp.port, secure: mail.smtp.secure,
      // Never fall back to plaintext (STARTTLS downgrade) except to a mail server on this machine.
      requireTLS: !mail.smtp.secure && !/^(localhost|127\.0\.0\.1|::1)$/.test(mail.smtp.host),
      auth: mail.smtp.user ? { user: mail.smtp.user, pass: mail.smtp.pass } : undefined,
      disableFileAccess: true, disableUrlAccess: true
    })
    return {
      configured: true, provider: 'smtp',
      async send({ to, subject, text, html }) {
        const info = await transport.sendMail({ from: mail.fromName ? { name: mail.fromName, address: from } : from, to, subject, text, html })
        if (!info?.messageId || (info.rejected && info.rejected.length)) throw new Error('The mail server did not accept the message.')
        return { providerId: info.messageId }
      },
      verify: () => transport.verify()
    }
  }
  if (mail.provider === 'viasocket_gmail' && mail.viasocket.userId && mail.viasocket.connectionId && vs?.configured) {
    return {
      configured: true, provider: 'viasocket_gmail',
      async send({ to, subject, text }) {
        const user = db.prepare('SELECT * FROM users WHERE id = ?').get(mail.viasocket.userId)
        const ctx = user ? loadContext(db, user) : null
        if (!ctx?.membership) throw new Error('The system mail sender is not an active TeamPulse member.')
        const ran = await runOnce(db, vs, ctx, mail.viasocket.connectionId, 'gmail_send_email', gmailInput({ to, subject, body: text, fromName: mail.fromName || 'TeamPulse' }))
        if (ran.outcome !== 'answered') throw new Error(ran.reason || 'Gmail did not confirm the email.')
        const read = readGmailResult(ran.result)
        if (!read.ok) throw new Error(read.reason)
        return { providerId: read.providerId }
      }
    }
  }
  return { configured: false, provider: null, async send() { throw new Error('Email is not configured on this server.') } }
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
function message(subject, lines, link, button) {
  const text = [...lines, '', link, '', 'If you did not ask for this, you can ignore this email.', '— TeamPulse'].join('\n')
  const html = `<div style="font-family:system-ui,Arial,sans-serif;max-width:520px">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}
<p><a href="${esc(link)}" style="display:inline-block;background:#4338ca;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">${esc(button)}</a></p>
<p style="color:#666;font-size:13px">Or open: ${esc(link)}</p><p style="color:#666;font-size:13px">If you did not ask for this, you can ignore this email.</p></div>`
  return { subject, text, html }
}

export const EMAILS = {
  verify: (name, link) => message('Confirm your email for TeamPulse', [`Hi ${name},`, 'Confirm your email address to finish creating your TeamPulse account. The link works for 24 hours.'], link, 'Confirm email'),
  reset: (name, link) => message('Reset your TeamPulse password', [`Hi ${name},`, 'Someone (hopefully you) asked to reset your TeamPulse password. The link works for 30 minutes and only once.'], link, 'Choose a new password'),
  linkPassword: (name, link) => message('Add password sign-in to your TeamPulse account', [`Hi ${name},`, 'Your TeamPulse account signs in with Google. Someone asked to add email and password sign-in to it. To do that, set a password with this link (1 hour, once). Your organization, role and work stay the same.'], link, 'Set a password'),
  alreadyRegistered: (name, link) => message('You already have a TeamPulse account', [`Hi ${name},`, 'Someone tried to create a TeamPulse account with this email, but you already have one. Sign in, or reset your password if you forgot it.'], link, 'Sign in')
}
