/** An error with an HTTP status and a stable code, safe to show to the user. */
export class AppError extends Error {
  constructor(status, code, message, details) {
    super(message)
    this.status = status
    this.code = code
    if (details !== undefined) this.details = details
  }
}

export const notFound = (what = 'That record') => new AppError(404, 'not_found', `${what} was not found.`)
export const forbidden = (message = 'You do not have permission to do that.') => new AppError(403, 'forbidden', message)
export const invalid = (message, details) => new AppError(400, 'validation_failed', message, details)
export const conflict = (message, code = 'conflict') => new AppError(409, code, message)
