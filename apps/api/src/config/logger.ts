import { pino } from 'pino'
import { env, isTest } from './env.js'

// Secrets never reach a log line: these paths are redacted wherever they appear.
export const logger = pino({
  level: isTest ? 'silent' : env.LOG_LEVEL,
  redact: {
    paths: [
      'password',
      '*.password',
      'token',
      '*.token',
      'authId',
      '*.authId',
      'scriptId',
      '*.scriptId',
      'req.headers.authorization',
      'req.headers.cookie',
      'headers.authorization',
      'secret',
      '*.secret',
    ],
    censor: '[redacted]',
  },
})
