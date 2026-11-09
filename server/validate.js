// Small, explicit validators. Every value from the browser goes through one of these.
import { invalid } from './errors.js'

export const PRIORITIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']
export const TASK_STATUSES = ['SUGGESTED', 'ASSIGNED', 'IN_PROGRESS', 'BLOCKED', 'SUBMITTED_FOR_REVIEW', 'COMPLETED', 'CANCELLED']
export const IMPACT_CATEGORIES = ['REVENUE_GROWTH', 'CUSTOMER_EXPERIENCE', 'TIME_SAVED', 'RELIABILITY', 'COST_REDUCTION', 'OPERATIONAL_EFFICIENCY', 'KNOWLEDGE_INNOVATION']
export const OUTCOME_TYPES = ['DELIVERED', 'PREVENTION', 'RESEARCH', 'LEARNING']
export const VALUE_TYPES = ['MEASURED', 'ESTIMATED', 'NONE']
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function text(value, field, { required = false, max = 2000, min = 0 } = {}) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    if (required) throw invalid(`${field} is required.`, { field })
    return null
  }
  if (typeof value !== 'string') throw invalid(`${field} must be text.`, { field })
  const v = value.trim()
  if (v.length < min) throw invalid(`${field} must be at least ${min} characters.`, { field })
  if (v.length > max) throw invalid(`${field} must be at most ${max} characters.`, { field })
  return v
}

export function oneOf(value, field, allowed, { required = false, fallback = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(`${field} is required.`, { field })
    return fallback
  }
  const v = String(value).toUpperCase()
  if (!allowed.includes(v)) throw invalid(`${field} must be one of ${allowed.join(', ')}.`, { field })
  return v
}

export function id(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(`${field} is required.`, { field })
    return null
  }
  if (typeof value !== 'string' || !UUID_RE.test(value)) throw invalid(`${field} is not a valid id.`, { field })
  return value
}

/** An ISO date (YYYY-MM-DD) or date-time; returned as an ISO string in UTC. */
export function dateTime(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(`${field} is required.`, { field })
    return null
  }
  if (typeof value !== 'string') throw invalid(`${field} must be a date.`, { field })
  const v = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:00.000Z` : value
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw invalid(`${field} is not a valid date.`, { field })
  const year = new Date(t).getUTCFullYear()
  if (year < 2000 || year > 2100) throw invalid(`${field} is out of range.`, { field })
  return new Date(t).toISOString()
}

export function dateOnly(value, field, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(`${field} is required.`, { field })
    return null
  }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value))) throw invalid(`${field} must be a date (YYYY-MM-DD).`, { field })
  return value
}

export function bool(value, field) {
  if (value === true || value === false) return value
  if (value === 1 || value === 0) return Boolean(value)
  throw invalid(`${field} must be true or false.`, { field })
}

export function int(value, field, { min = -Infinity, max = Infinity, required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw invalid(`${field} is required.`, { field })
    return null
  }
  const n = Number(value)
  if (!Number.isInteger(n) || n < min || n > max) throw invalid(`${field} must be a whole number between ${min} and ${max}.`, { field })
  return n
}

export function number(value, field) {
  if (value === undefined || value === null || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) throw invalid(`${field} must be a number.`, { field })
  return n
}

/** http(s) links only: never javascript:, data: or other schemes. */
export function url(value, field) {
  const v = text(value, field, { required: true, max: 2000 })
  let u
  try { u = new URL(v) } catch { throw invalid(`${field} must be a full link starting with https://`, { field }) }
  if (!['http:', 'https:'].includes(u.protocol)) throw invalid(`${field} must start with http:// or https://`, { field })
  return u.toString()
}

export function links(value, field = 'Links') {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw invalid(`${field} must be a list.`, { field })
  if (value.length > 20) throw invalid(`At most 20 ${field.toLowerCase()}.`, { field })
  return value.map((l, i) => {
    const raw = typeof l === 'string' ? { url: l } : l
    return { url: url(raw?.url, `${field} #${i + 1}`), label: text(raw?.label, `${field} #${i + 1} label`, { max: 200 }) }
  })
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/
export function email(value, field = 'Email') {
  const v = text(value, field, { required: true, max: 254 })
  if (!EMAIL_RE.test(v)) throw invalid(`${field} is not a valid email address.`, { field })
  return v.toLowerCase()
}
