import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { nextOccurrence, statusEffects } from '../src/modules/tasks.js'
import { keyResultProgress } from '../src/modules/goals.js'
import { addDays, dayBounds, todayIn, weekStart } from '../src/lib/dates.js'
import { strictJsonSchema } from '../src/ai/provider.js'
import { toCsv } from '../src/services/reports.js'
import { decrypt, encrypt } from '../src/lib/crypto.js'
import { taskCreateSchema, weightsSchema } from '@workpulse/shared'

describe('task rules', () => {
  const base = { status: 'TODO' as const, startedAt: null, completedAt: null, reopenCount: 0 }
  it('sets timestamps and counts reopens', () => {
    const now = new Date('2026-11-01T00:00:00Z')
    expect(statusEffects(base, 'IN_PROGRESS', now)).toMatchObject({ status: 'IN_PROGRESS', startedAt: now })
    expect(statusEffects(base, 'COMPLETED', now)).toMatchObject({ completedAt: now, startedAt: now })
    expect(statusEffects({ ...base, status: 'COMPLETED', completedAt: now }, 'IN_PROGRESS', now)).toMatchObject({ completedAt: null, reopenCount: 1 })
    expect(statusEffects({ ...base, status: 'COMPLETED', completedAt: now }, 'CANCELLED', now).reopenCount).toBeUndefined()
  })
  it('computes recurrences', () => {
    expect(nextOccurrence('DAILY', new Date('2026-11-06T09:00:00Z')).toISOString()).toBe('2026-11-07T09:00:00.000Z')
    expect(nextOccurrence('WEEKDAYS', new Date('2026-11-06T09:00:00Z')).toISOString()).toBe('2026-11-09T09:00:00.000Z') // Fri → Mon
    expect(nextOccurrence('MONTHLY', new Date('2026-11-06T09:00:00Z')).toISOString()).toBe('2026-12-06T09:00:00.000Z')
  })
  it('validates task input', () => {
    expect(taskCreateSchema.safeParse({ title: '' }).success).toBe(false)
    expect(taskCreateSchema.safeParse({ title: 'x', complexity: 9 }).success).toBe(false)
    expect(taskCreateSchema.safeParse({ title: 'x', status: 'DONE' }).success).toBe(false)
    expect(taskCreateSchema.safeParse({ title: 'Valid', priority: 'HIGH', dueAt: '2026-11-20' }).success).toBe(true)
  })
})

describe('goal progress', () => {
  it('averages key results, clipped, independent of task counts', () => {
    expect(keyResultProgress([])).toBeNull()
    expect(
      keyResultProgress([
        { start: 0, target: 10, current: 5 },
        { start: 100, target: 50, current: 75 },
      ]),
    ).toBe(50)
    expect(keyResultProgress([{ start: 0, target: 10, current: 50 }])).toBe(100)
  })
  it('requires weights to add up to 100', () => {
    expect(weightsSchema.safeParse({ impact: 30, quality: 25, alignment: 20, reliability: 15, evidence: 10 }).success).toBe(true)
    expect(weightsSchema.safeParse({ impact: 30, quality: 25, alignment: 20, reliability: 15, evidence: 11 }).success).toBe(false)
  })
})

describe('dates', () => {
  it('computes day bounds in a time zone', () => {
    const [s, e] = dayBounds('2026-11-15', 'Asia/Kolkata')
    expect(s.toISOString()).toBe('2026-11-14T18:30:00.000Z')
    expect(e.toISOString()).toBe('2026-11-15T18:30:00.000Z')
    expect(todayIn('Asia/Kolkata', new Date('2026-11-14T19:00:00Z'))).toBe('2026-11-15')
    expect(weekStart('2026-11-15')).toBe('2026-11-09')
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
  })
})

describe('security helpers', () => {
  it('encrypts integration ids with AES-GCM and detects tampering', () => {
    const c = encrypt('auth_123')
    expect(c).not.toContain('auth_123')
    expect(decrypt(c)).toBe('auth_123')
    const tampered = Buffer.from(c, 'base64')
    tampered[tampered.length - 1]! ^= 1
    expect(() => decrypt(tampered.toString('base64'))).toThrow()
  })
  it('neutralises spreadsheet formulas in CSV exports', () => {
    const csv = toCsv({
      title: 't',
      subjectName: 's',
      period: { start: '', end: '' },
      metrics: {},
      sections: [{ heading: 'Delivered', items: ['=HYPERLINK("evil")', 'a,b'] }],
    })
    expect(csv).toContain(`'=HYPERLINK`)
    expect(csv).toContain('"a,b"')
  })
  it('produces OpenAI strict-mode schemas', () => {
    const s = strictJsonSchema(z.object({ a: z.string(), b: z.number().nullable(), c: z.object({ d: z.boolean() }) })) as {
      required: string[]
      additionalProperties: boolean
      properties: { c: { additionalProperties: boolean } }
    }
    expect(s.required).toEqual(['a', 'b', 'c'])
    expect(s.additionalProperties).toBe(false)
    expect(s.properties.c.additionalProperties).toBe(false)
  })
})
