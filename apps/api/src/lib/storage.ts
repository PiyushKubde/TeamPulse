// Evidence and attachment files: S3-compatible storage when S3_BUCKET is set, local disk (DATA_DIR/uploads) otherwise.
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { env } from '../config/env.js'
import { randomToken } from './crypto.js'
import { badRequest } from './errors.js'

const s3 = env.S3_BUCKET
  ? new S3Client({
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY ?? '' } : undefined,
    })
  : null
const localDir = resolve(env.DATA_DIR, 'uploads')

/** Allowed upload types, checked against both the declared type and the file's magic bytes. */
const ALLOWED: Record<string, (b: Buffer) => boolean> = {
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/gif': (b) => b.subarray(0, 4).toString('ascii') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('ascii') === '%PDF-',
  'text/plain': (b) => !b.subarray(0, 4096).includes(0),
  'text/csv': (b) => !b.subarray(0, 4096).includes(0),
  'text/markdown': (b) => !b.subarray(0, 4096).includes(0),
  // Office Open XML documents are zip containers.
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': (b) => b.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])),
}

export function validateUpload(mimeType: string, data: Buffer) {
  const check = ALLOWED[mimeType]
  if (!check) throw badRequest('This file type is not allowed. Use an image, PDF, text, CSV or Office document.')
  if (!check(data)) throw badRequest('The file content does not match its type.')
}

export async function putFile(orgId: string, fileName: string, mimeType: string, data: Buffer) {
  validateUpload(mimeType, data)
  const safe = fileName.replace(/[^\w.-]+/g, '_').slice(-80)
  const key = `${orgId}/${randomToken(12)}-${safe}`
  if (s3) await s3.send(new PutObjectCommand({ Bucket: env.S3_BUCKET, Key: key, Body: data, ContentType: mimeType }))
  else {
    await mkdir(join(localDir, orgId), { recursive: true })
    await writeFile(join(localDir, key), data)
  }
  return key
}

/** A short-lived URL (S3) or null when files are local (then the API streams it after an auth check). */
export async function signedUrl(key: string, fileName: string) {
  if (!s3) return null
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key, ResponseContentDisposition: `attachment; filename="${fileName.replace(/"/g, '')}"` }),
    { expiresIn: 300 },
  )
}

export async function readLocal(key: string) {
  const path = resolve(localDir, key)
  if (!path.startsWith(localDir)) throw badRequest('Invalid file key')
  return readFile(path)
}

export async function deleteFile(key: string) {
  if (s3) await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }))
  else await unlink(resolve(localDir, key)).catch(() => undefined)
}
