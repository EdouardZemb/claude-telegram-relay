/**
 * @module result
 * @description Custom Result<T, E> type for explicit error paths.
 * Algebraic discriminant type — no monad chaining, no external dependency.
 *
 * Decision: custom rather than neverthrow — the codebase uses Supabase
 * { data, error } patterns and does not need monadic composition.
 * R1: Custom Result<T, E> as discriminant union type.
 * R2: Type guards isOk/isErr for narrowing.
 */

export type Result<T, E = Error> = { ok: true; value: T } | { ok: false; error: E };

/**
 * Construct an Ok result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/**
 * Construct an Err result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Type guard: narrows Result to Ok variant.
 */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok === true;
}

/**
 * Type guard: narrows Result to Err variant.
 */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return result.ok === false;
}
