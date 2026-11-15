export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message)
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'bad_request', message, details)
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'unauthorized', message)
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message)
/** Out-of-scope records answer 404 so their existence is not revealed. */
export const notFound = (what = 'Record') => new HttpError(404, 'not_found', `${what} not found.`)
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details)
export const unavailable = (code: string, message: string) => new HttpError(503, code, message)
