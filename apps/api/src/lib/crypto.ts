import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { env } from '../config/env.js'

const key = Buffer.from(env.APP_ENCRYPTION_KEY, 'base64')

export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')
export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url')

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). Used for viaSocket auth_id and script_id values. */
export function encrypt(plain: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64')
}

export function decrypt(blob: string): string {
  const raw = Buffer.from(blob, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12))
  decipher.setAuthTag(raw.subarray(12, 28))
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
}

export function safeEqualHex(a: string, b: string) {
  const ab = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ab.length === bb.length && timingSafeEqual(ab, bb)
}
