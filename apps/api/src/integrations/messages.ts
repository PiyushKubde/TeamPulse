// Plain-language explanations for integration problems. Raw provider errors stay in the logs and Sync History;
// people see what happened and what to do next.
import { prisma } from '../lib/prisma.js'
import { HttpError } from '../lib/errors.js'

const APP_NAMES: Record<string, string> = { slack: 'Slack', gmail: 'Gmail', linear: 'Linear', 'jira-software-cloud': 'Jira', github: 'GitHub' }

/** A setup problem (nothing connected or chosen yet): 409 with a message that says exactly what to do. */
export async function notConnected(userId: string, orgId: string, provider: string, need: string) {
  const app = APP_NAMES[provider] ?? provider
  const elsewhere = await prisma.integrationConnection.findFirst({
    where: { userId, provider, status: { not: 'REVOKED' }, orgId: { not: orgId } },
    select: { org: { select: { name: true } } },
  })
  const message = elsewhere
    ? `${app} is connected in your other organization (${elsewhere.org.name}), not this one. Connections belong to one organization: open Integrations here and connect ${app}, then ${need}.`
    : `${app} isn’t connected yet. Open Integrations, connect ${app}, then ${need}.`
  return new HttpError(409, 'not_connected', message)
}

const KNOWN: [RegExp, string][] = [
  [/channel_not_found/i, 'Slack can’t find that channel any more (it may have been deleted or renamed to private). Choose the channel again in Integrations.'],
  [
    /not_in_channel|is_archived/i,
    'KONVO isn’t a member of that Slack channel or it is archived. Invite the app to the channel, or choose another one in Integrations.',
  ],
  [
    /invalid_auth|token_revoked|account_inactive|Auth data not found|unauthori[sz]ed|401/i,
    'The connection’s sign-in has expired or was revoked. Click “Reconnect” on the app in Integrations.',
  ],
  [/ratelimit|rate.?limit|429/i, 'The app is rate-limiting requests right now. It will work again in a minute or two.'],
  [/timeout|ETIMEDOUT|aborted|ECONNRESET|ENOTFOUND|fetch failed/i, 'The app didn’t respond in time. Please try again in a minute.'],
  [/Choose a Slack channel|Choose a Linear team|No recipient/i, 'Finish the setup first: choose where messages should go in Integrations.'],
]

/** Turns any delivery failure into an HttpError with a message a person can act on. */
export function humanize(e: unknown, provider: string): HttpError {
  if (e instanceof HttpError) return e
  const raw = e instanceof Error ? e.message : String(e)
  const app = APP_NAMES[provider] ?? provider
  const hit = KNOWN.find(([re]) => re.test(raw))
  return new HttpError(
    502,
    'delivery_failed',
    hit ? hit[1] : `${app} didn’t accept the message. Try again; if it keeps failing, use “Reconnect” on ${app} in Integrations.`,
    { detail: raw.slice(0, 300) },
  )
}
