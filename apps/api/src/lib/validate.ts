import type { Request } from 'express'
import type { z } from 'zod'
import { badRequest } from './errors.js'

function parse<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    throw badRequest(details[0] ? `${details[0].path || 'input'}: ${details[0].message}` : 'Invalid input', details)
  }
  return result.data
}

export const body = <S extends z.ZodType>(req: Request, schema: S) => parse(schema, req.body ?? {})
export const query = <S extends z.ZodType>(req: Request, schema: S) => parse(schema, req.query ?? {})
export const param = (req: Request, key: string) => {
  const value = req.params[key]
  if (typeof value !== 'string' || !/^[0-9a-f-]{36}$/i.test(value)) throw badRequest(`Invalid ${key}`)
  return value
}
