// The event hub. Services emit after their transaction commits. With an outbox attached (the app does this), each
// event is first written to event_outbox, then its listeners run on the next tick; the row is marked DONE only when
// every listener finished. Rows still PENDING after a crash or restart are replayed by recoverOutbox() — safe because
// every listener is idempotent (dedupe keys on notifications, alerts, sends and flow dispatches).
import { randomUUID } from 'node:crypto'

const listeners = []
const pending = new Set()
let outboxDb = null

export function onEvent(fn) {
  listeners.push(fn)
  return () => listeners.splice(listeners.indexOf(fn), 1)
}

/** Attaches the durable outbox (one database per process; tests run one app at a time). */
export function useOutbox(db) { outboxDb = db }

function markDone(id, errors) {
  if (!outboxDb || !id) return
  const ts = new Date().toISOString()
  try {
    if (errors.length) outboxDb.prepare(`UPDATE event_outbox SET status = CASE WHEN attempts >= 5 THEN 'FAILED' ELSE 'PENDING' END, last_error = ?, updated_at = ? WHERE id = ?`).run(errors.join('; ').slice(0, 300), ts, id)
    else outboxDb.prepare(`UPDATE event_outbox SET status = 'DONE', last_error = NULL, updated_at = ? WHERE id = ?`).run(ts, id)
  } catch { /* the database was closed (shutdown): the row stays PENDING and is replayed */ }
}

function dispatch(event, outboxId) {
  const errors = []
  const runs = listeners.map((fn) => new Promise((resolve) => setImmediate(resolve))
    .then(() => fn(event))
    .catch((error) => { errors.push(`${event.type}: ${error?.message || error}`); console.error(`[events] ${event.type} listener failed:`, error?.message || error) }))
  const all = Promise.all(runs).then(() => markDone(outboxId, errors)).finally(() => pending.delete(all))
  pending.add(all)
}

export function emit(event) {
  let id = null
  if (outboxDb) {
    id = randomUUID()
    const ts = new Date().toISOString()
    try {
      outboxDb.prepare(`INSERT INTO event_outbox (id, type, payload, status, attempts, created_at, updated_at) VALUES (?, ?, ?, 'PENDING', 1, ?, ?)`).run(id, event.type, JSON.stringify(event), ts, ts)
    } catch (error) { console.error('[events] could not write the outbox:', error.message); id = null }
  }
  dispatch(event, id)
}

/** Replays events left PENDING (older than `olderThanMs`, so in-flight work is not doubled). Returns how many. */
export function recoverOutbox({ olderThanMs = 60000, limit = 200 } = {}) {
  if (!outboxDb) return 0
  const cutoff = new Date(Date.now() - olderThanMs).toISOString()
  const rows = outboxDb.prepare(`SELECT * FROM event_outbox WHERE status = 'PENDING' AND updated_at <= ? ORDER BY created_at LIMIT ?`).all(cutoff, limit)
  for (const r of rows) {
    outboxDb.prepare(`UPDATE event_outbox SET attempts = attempts + 1, updated_at = ? WHERE id = ?`).run(new Date().toISOString(), r.id)
    let event
    try { event = JSON.parse(r.payload) } catch { markDone(r.id, ['unreadable payload']); continue }
    dispatch(event, r.id)
  }
  if (rows.length) console.log(`[events] replayed ${rows.length} pending event(s) from the outbox`)
  // Keep the table small: done rows older than 14 days go.
  outboxDb.prepare(`DELETE FROM event_outbox WHERE status = 'DONE' AND updated_at < ?`).run(new Date(Date.now() - 14 * 86400000).toISOString())
  return rows.length
}

/** Resolves when every listener started so far has finished (tests and the scheduler use it). */
export async function settled() {
  while (pending.size) await Promise.all([...pending])
}
