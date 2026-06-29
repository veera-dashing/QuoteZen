import type { z } from 'zod';
import { AppError } from '../errors.js';

/** Parse input with a Zod schema, throwing a 422 `validation_error` with field details on failure. */
export const parse = <S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> => {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new AppError(
      'validation_error',
      'Request validation failed',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
};
