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
