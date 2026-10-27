// One error vocabulary for every API failure. The code tells a client what the user can
// do next; the message tells the user why. A retryable code means the same request may
// succeed later without any change by the user.
export const errorCodes = {
  invalid_request: false,
  unauthenticated: false,
  forbidden: false,
  not_found: false,
  conflict: false,
  too_large: false,
  // A stored-size allowance is used up; retrying the same request cannot succeed.
  quota: false,
  // The spend budget is committed; a later day or an operator reconciliation frees it.
  budget: false,
  guest_limit: false,
  // A shared queue or concurrency slot is full; it frees as other work finishes.
  capacity: true,
  rate_limited: true,
  unavailable: true,
  internal: true,
} as const satisfies Record<string, boolean>;
export type ErrorCode = keyof typeof errorCodes;
export interface ErrorBody {
  error: string;
  code: ErrorCode;
  retryable: boolean;
  // Present only for internal failures, so a report can be matched to the server log.
  requestId?: string;
  details?: { path: PropertyKey[]; message: string }[];
}
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && Object.hasOwn(errorCodes, value);
}
export function statusErrorCode(status: number): ErrorCode {
  if (status === 400 || status === 422) return 'invalid_request';
  if (status === 401) return 'unauthenticated';
  if (status === 402) return 'budget';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 503) return 'unavailable';
  if (status >= 500) return 'internal';
  return 'invalid_request';
}
export function errorBody(
  message: string,
  code: ErrorCode,
  extra?: Pick<ErrorBody, 'requestId' | 'details'>,
): ErrorBody {
  return { error: message, code, retryable: errorCodes[code], ...extra };
}
