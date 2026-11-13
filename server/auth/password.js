// Passwords: Argon2id (OWASP parameters: 19 MiB, 2 iterations, 1 lane) via hash-wasm (WebAssembly; no native build).
// Only the encoded hash is stored; plaintext never leaves this module and is never logged.
import { argon2id, argon2Verify } from 'hash-wasm'
import { randomBytes } from 'node:crypto'
import { invalid } from '../errors.js'

const PARAMS = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32, outputType: 'encoded' }
const COMMON = new Set(['password', 'password1', 'password123', '123456789012', 'qwertyuiop12', 'letmein12345', 'iloveyou1234', 'welcome12345', 'teampulse123', 'konvo1234567', 'admin1234567', 'changeme1234'])

export const hashPassword = (password) => argon2id({ password, salt: randomBytes(16), ...PARAMS })

export async function verifyPassword(password, hash) {
  if (typeof hash !== 'string' || !hash.startsWith('$argon2id$')) return false
  try { return await argon2Verify({ password, hash }) } catch { return false }
}

// A real hash checked when no account matches, so a wrong email takes as long as a wrong password (no enumeration by timing).
let dummy = null
export async function burnTime(password) {
  dummy ||= await hashPassword('timing-equaliser-not-a-password')
  await verifyPassword(String(password || ''), dummy)
}

/** 12–128 characters; 3 of 4 character kinds unless it is a long passphrase (20+); not common; not the email or name. */
export function checkPasswordPolicy(password, { email = '', name = '' } = {}) {
  if (typeof password !== 'string') throw invalid('Enter a password.', { field: 'password' })
  if (password.length < 12) throw invalid('Use at least 12 characters.', { field: 'password' })
  if (password.length > 128) throw invalid('Use at most 128 characters.', { field: 'password' })
  const kinds = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(password)).length
  if (password.length < 20 && kinds < 3) throw invalid('Mix at least three of: lowercase, uppercase, numbers, symbols — or use a passphrase of 20+ characters.', { field: 'password' })
  const lower = password.toLowerCase()
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) throw invalid('That password is too common. Choose another.', { field: 'password' })
  const local = String(email).split('@')[0].toLowerCase()
  if (local.length >= 4 && lower.includes(local)) throw invalid('Your password must not contain your email address.', { field: 'password' })
  const first = String(name).trim().split(/\s+/)[0]?.toLowerCase() || ''
  if (first.length >= 4 && lower.includes(first)) throw invalid('Your password must not contain your name.', { field: 'password' })
}
