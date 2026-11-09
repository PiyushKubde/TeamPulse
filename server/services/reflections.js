import { now, uuid } from '../db.js'
import * as v from '../validate.js'

const today = () => new Date().toISOString().slice(0, 10)

export function getReflection(db, ctx, day = today()) {
  const d = v.dateOnly(day, 'Day') || today()
  const r = db.prepare('SELECT * FROM reflections WHERE user_id = ? AND day = ?').get(ctx.user.id, d)
  return { day: d, contribution: r?.contribution ?? '', changeMade: r?.change_made ?? '', blockedBy: r?.blocked_by ?? '', learned: r?.learned ?? '', tomorrow: r?.tomorrow ?? '', savedAt: r?.updated_at ?? null }
}

export function saveReflection(db, ctx, body) {
  const d = v.dateOnly(body?.day, 'Day') || today()
  const f = {
    contribution: v.text(body?.contribution, 'Most important contribution', { max: 2000 }),
    change_made: v.text(body?.changeMade, 'What changed', { max: 2000 }),
    blocked_by: v.text(body?.blockedBy, 'What blocked me', { max: 2000 }),
    learned: v.text(body?.learned, 'What I learned', { max: 2000 }),
    tomorrow: v.text(body?.tomorrow, 'Focus for tomorrow', { max: 2000 })
  }
  const ts = now()
  db.prepare(`INSERT INTO reflections (id, org_id, user_id, day, contribution, change_made, blocked_by, learned, tomorrow, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT (user_id, day) DO UPDATE SET contribution = excluded.contribution, change_made = excluded.change_made, blocked_by = excluded.blocked_by,
              learned = excluded.learned, tomorrow = excluded.tomorrow, updated_at = excluded.updated_at`)
    .run(uuid(), ctx.orgId, ctx.user.id, d, f.contribution, f.change_made, f.blocked_by, f.learned, f.tomorrow, ts, ts)
  return getReflection(db, ctx, d)
}

export function recentReflections(db, ctx, limit = 7) {
  return db.prepare('SELECT * FROM reflections WHERE user_id = ? ORDER BY day DESC LIMIT ?').all(ctx.user.id, limit)
    .map((r) => ({ day: r.day, contribution: r.contribution, changeMade: r.change_made, blockedBy: r.blocked_by, learned: r.learned, tomorrow: r.tomorrow }))
}
