export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<unknown> {
  const response = await fetch(`/api${path}`, {
    method,
    signal: AbortSignal.timeout(30000),
    credentials: 'same-origin',
    headers:
      body instanceof FormData
        ? undefined
        : body === undefined
          ? undefined
          : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  });
  if (response.status === 401 && !path.startsWith('/auth/'))
    window.dispatchEvent(new Event('brane:session-expired'));
  const data: unknown = await response.json().catch(() => {
    if (response.ok) throw new Error('Invalid server response');
    return { error: 'Request failed' };
  });
  if (!response.ok) throw new ApiError(response.status, errorMessage(data));
  return data;
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
