// Organization-timezone date helpers (IANA zones through Intl; no dependency). A date without a time means the end of
// that day in the organization's timezone, never in the server's.
import { json } from './db.js'

export const DEFAULT_TIMEZONE = 'UTC'

export function validTimezone(tz) {
  if (typeof tz !== 'string' || !tz || tz.length > 64) return false
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true } catch { return false }
}

export function orgTimezone(db, orgId) {
  const tz = json(db.prepare('SELECT settings FROM organizations WHERE id = ?').get(orgId)?.settings, {}).timezone
  return validTimezone(tz) ? tz : DEFAULT_TIMEZONE
}

/** Wall-clock parts of an instant in a zone. */
export function zonedParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' })
  const p = Object.fromEntries(f.formatToParts(new Date(ms)).map((x) => [x.type, x.value]))
  return { year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second, weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday) }
}

const offsetMs = (ms, tz) => {
  const p = zonedParts(ms, tz)
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000
}

/** The instant (ms) at which the wall clock in `tz` reads the given date and time. */
export function zonedTimeToMs({ year, month, day, hour = 0, minute = 0 }, tz) {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  let ms = guess - offsetMs(guess, tz)
  ms = guess - offsetMs(ms, tz)
  return ms
}

/** "YYYY-MM-DD" → ISO instant of 23:59 that day in `tz`. */
export function endOfDayIso(dateStr, tz = DEFAULT_TIMEZONE) {
  const [year, month, day] = dateStr.split('-').map(Number)
  return new Date(zonedTimeToMs({ year, month, day, hour: 23, minute: 59 }, tz)).toISOString()
}

/** Adds whole calendar days to a y/m/d triple (calendar arithmetic, so DST never shifts the date). */
export function addDays({ year, month, day }, n) {
  const d = new Date(Date.UTC(year, month - 1, day + n))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() }
}

// ---------- working calendar ----------
export const DEFAULT_CALENDAR = { days: [1, 2, 3, 4, 5], start: '09:00', end: '18:00' }

const hm = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + m }

export function validCalendar(c) {
  return Boolean(c) && Array.isArray(c.days) && c.days.length > 0 && c.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
    && /^([01]\d|2[0-3]):[0-5]\d$/.test(c.start || '') && /^([01]\d|2[0-3]):[0-5]\d$/.test(c.end || '') && hm(c.end) > hm(c.start)
}

export function orgCalendar(db, orgId) {
  const c = json(db.prepare('SELECT settings FROM organizations WHERE id = ?').get(orgId)?.settings, {}).workingCalendar
  return validCalendar(c) ? c : DEFAULT_CALENDAR
}

/** Start (ms) of the first working window at or after `ms` in `tz`, and the end (ms) of the window containing/after it. */
function windowAt(ms, calendar, tz) {
  let day = (() => { const p = zonedParts(ms, tz); return { year: p.year, month: p.month, day: p.day } })()
  for (let i = 0; i < 400; i++) {
    const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay()
    if (calendar.days.includes(weekday)) {
      const [sh, sm] = calendar.start.split(':').map(Number)
      const [eh, em] = calendar.end.split(':').map(Number)
      const start = zonedTimeToMs({ ...day, hour: sh, minute: sm }, tz)
      const end = zonedTimeToMs({ ...day, hour: eh, minute: em }, tz)
      if (end > ms) return { start: Math.max(start, ms), end }
    }
    day = addDays(day, 1)
  }
  throw new Error('No working time found in the calendar.')
}

/**
 * The moment `amount` of working time has passed since `startMs`, counting only the organization's working days and hours
 * (a working day is the length of its working window). Used for suggested response targets, never for confirmed deadlines.
 */
export function addWorkingTime(startMs, amount, unit, calendar = DEFAULT_CALENDAR, tz = DEFAULT_TIMEZONE) {
  const dayMs = (hm(calendar.end) - hm(calendar.start)) * 60000
  let remaining = unit === 'working_days' ? amount * dayMs : amount * 3600000
  let cursor = startMs
  for (let guard = 0; guard < 2000 && remaining > 0; guard++) {
    const w = windowAt(cursor, calendar, tz)
    const take = Math.min(remaining, w.end - w.start)
    cursor = w.start + take
    remaining -= take
    if (remaining > 0) cursor = w.end
  }
  return cursor
}
