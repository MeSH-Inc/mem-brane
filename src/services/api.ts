export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T = any>(
  path: string,
  body?: unknown,
  method = body === undefined ? 'GET' : 'POST',
): Promise<T> {
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
  const data = await response.json().catch(() => {
    if (response.ok) throw new Error('Invalid server response');
    return { error: 'Request failed' };
  });
  if (!response.ok)
    throw new ApiError(
      response.status,
      data.error?.message ?? data.error ?? data.message ?? 'Request failed',
    );
  return data;
}
