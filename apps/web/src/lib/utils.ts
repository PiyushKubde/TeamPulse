import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistanceToNowStrict, isPast, isToday } from 'date-fns'

export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs))

export const fmtDate = (d?: string | Date | null, f = 'd MMM') => (d ? format(new Date(d), f) : '—')
export const fmtDateTime = (d?: string | Date | null) => (d ? format(new Date(d), 'd MMM yyyy, HH:mm') : '—')
export const ago = (d?: string | Date | null) => (d ? `${formatDistanceToNowStrict(new Date(d))} ago` : 'never')
export const isOverdue = (d?: string | null, status?: string) =>
  Boolean(d && isPast(new Date(d)) && !isToday(new Date(d)) && status !== 'COMPLETED' && status !== 'CANCELLED')
export const todayYmd = () => format(new Date(), 'yyyy-MM-dd')
export const pct = (v: number | null | undefined) => (v == null ? '—' : `${Math.round(v)}`)
export const minutes = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m}m`)
export const titleCase = (s: string) =>
  s
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase())
export const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase()
