/**
 * Typed application errors mapped to a consistent JSON envelope:
 * `{ error: { code, message, details? } }`.
 */
export type ErrorCode =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_error'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_error: 422,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.statusCode = STATUS_BY_CODE[code];
    this.details = details;
  }
}

export const notFound = (entity: string, id?: unknown): AppError =>
  new AppError('not_found', id === undefined ? `${entity} not found` : `${entity} ${id} not found`);

export const unauthorized = (message = 'Invalid credentials'): AppError =>
  new AppError('unauthorized', message);

export const conflict = (message: string): AppError => new AppError('conflict', message);
