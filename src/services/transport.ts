import { errorCodes, isErrorCode, statusErrorCode, type ErrorCode } from '../../shared/errors';
export class ApiError extends Error {
  readonly retryable: boolean;
  constructor(
    public status: number,
    message: string,
    public code: ErrorCode = statusErrorCode(status),
    public requestId?: string,
  ) {
    super(message);
    this.retryable = errorCodes[code];
  }
}
export async function networkApi(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
  expectedLibrary?: string,
  expectedPrincipal?: string,
): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    method,
    signal: AbortSignal.timeout(30000),
    credentials: 'same-origin',
    headers: {
      ...(expectedLibrary ? { 'X-Mem-Brane-Library': expectedLibrary } : {}),
      ...(expectedPrincipal ? { 'X-Mem-Brane-Actor': expectedPrincipal } : {}),
      ...(body === undefined || body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (response.status === 401 && !path.startsWith('/auth/'))
    window.dispatchEvent(new Event('brane:session-expired'));
  const data: unknown = await response.json().catch(() => {
    if (response.ok) throw new Error('Invalid server response');
    return { error: 'Request failed' };
  });
  if (!response.ok) throw failure(response.status, data);
  return data;
}
function failure(status: number, data: unknown): ApiError {
  const body = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  const code = isErrorCode(body.code) ? body.code : statusErrorCode(status);
  const requestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  const message = errorMessage(data);
  return new ApiError(
    status,
    requestId ? `${message} (reference ${requestId.slice(0, 8)})` : message,
    code,
    requestId,
  );
}
function errorMessage(data: unknown): string {
  if (!data || typeof data !== 'object') return 'Request failed';
  if ('error' in data) {
    if (typeof data.error === 'string') return data.error;
    if (
      data.error &&
      typeof data.error === 'object' &&
      'message' in data.error &&
      typeof data.error.message === 'string'
    )
      return data.error.message;
  }
  return 'message' in data && typeof data.message === 'string' ? data.message : 'Request failed';
}
