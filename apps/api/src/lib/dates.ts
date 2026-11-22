/** Offset of a time zone from UTC at a given instant, in ms (e.g. Asia/Kolkata → +19800000). */
export function tzOffsetMs(tz: string, at: Date) {
  const local = new Date(at.toLocaleString('en-US', { timeZone: tz }))
  const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }))
  return local.getTime() - utc.getTime()
}

/** [start, end) instants of a calendar day (YYYY-MM-DD) in a time zone. */
export function dayBounds(ymd: string, tz = 'UTC'): [Date, Date] {
  const midnightUtc = Date.parse(`${ymd}T00:00:00Z`)
  const start = new Date(midnightUtc - tzOffsetMs(tz, new Date(midnightUtc)))
  const nextUtc = midnightUtc + 864e5
  const end = new Date(nextUtc - tzOffsetMs(tz, new Date(nextUtc)))
  return [start, end]
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export const todayIn = (tz = 'UTC', at = new Date()) => new Date(at.getTime() + tzOffsetMs(tz, at)).toISOString().slice(0, 10)

export const addDays = (ymd: string, days: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10)

/** Monday (YYYY-MM-DD) of the ISO week containing ymd. */
export const weekStart = (ymd: string) => {
  const d = new Date(`${ymd}T00:00:00Z`)
  return addDays(ymd, -((d.getUTCDay() + 6) % 7))
}

export const isValidTz = (tz: string) => {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}
