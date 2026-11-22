// Slack adapter: a message in the intake channel. Accepts the bare message event (the trigger's sample) or the Events API
// envelope ({ event: {...} }).
import { z } from 'zod'
import type { Normalized, NormalizedMessage } from '../normalization/types.js'

const message = z.looseObject({
  ts: z.string().min(1),
  text: z.string().max(40000).nullish(),
  user: z.string().nullish(),
  channel: z.string().min(1),
  bot_id: z.string().nullish(),
  subtype: z.string().nullish(),
  thread_ts: z.string().nullish(),
})

/** Subtypes that are still a person's message; everything else (bot_message, message_changed, channel_join…) is ignored. */
const HUMAN_SUBTYPES = new Set(['file_share', 'thread_broadcast'])

export function normalizeMessage(body: unknown): NormalizedMessage {
  const inner = (body as { event?: unknown })?.event
  const m = message.parse(inner && typeof inner === 'object' ? inner : body)
  const text = (m.text ?? '').trim()
  return {
    provider: 'slack',
    externalId: `${m.channel}:${m.ts}`,
    channel: m.channel,
    ts: m.ts,
    text,
    author: m.user ?? null,
    ignore: Boolean(m.bot_id) || Boolean(m.subtype && !HUMAN_SUBTYPES.has(m.subtype)) || !text,
  }
}

export function normalize(_kind: string, body: unknown): Normalized {
  return { type: 'intake', items: [normalizeMessage(body)] }
}

export function idempotencyKey(_kind: string, body: unknown, fallback: string) {
  try {
    return `msg:${normalizeMessage(body).externalId}`
  } catch {
    return fallback
  }
}
