// Small helpers shared by the source parsers. Untrusted message content only ever passes through these as text.
import { createHash } from 'node:crypto'

export const sha = (s) => createHash('sha256').update(String(s)).digest('hex')
export const first = (...vals) => vals.find((x) => typeof x === 'string' && x.trim())?.trim() ?? null
export const obj = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null)

// Headers arrive as a { Name: value } object (the Gmail trigger's rawPayloadHeaders) or as a [{ name, value }] list (payload.headers).
export const header = (headers, name) => {
  if (Array.isArray(headers)) return first(headers.find((h) => String(h?.name).toLowerCase() === name)?.value)
  const o = obj(headers)
  const key = o && Object.keys(o).find((k) => k.toLowerCase() === name)
  return key ? first(o[key]) : null
}
// A person is either a "Name <a@b.co>" string or an { name, email } object.
export const person = (x) => {
  const o = obj(x)
  if (!o) return first(x)
  const email = first(o.email, o.address)
  const name = first(o.name)
  return email ? (name && name.toLowerCase() !== email.toLowerCase() ? `${name} <${email}>` : email) : name
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
/** Email or chat HTML as plain text: scripts, styles and tags are dropped, never executed or kept as markup. */
export function htmlToText(html) {
  const raw = first(html)
  if (!raw) return null
  const text = raw.slice(0, 200000)
    .replace(/<(script|style|head)[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z]{2,6});/gi, (m, e) => {
      if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp > 31 && cp < 0x10ffff ? String.fromCodePoint(cp) : ' ' }
      return ENTITIES[e.toLowerCase()] ?? ' '
    })
    .split('').filter((c) => { const n = c.charCodeAt(0); return n > 31 || n === 9 || n === 10 || n === 13 }).join('')
    .replace(/[ \t]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return text || null
}
