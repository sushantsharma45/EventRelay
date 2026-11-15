export interface ApiOptions {
  token?: string | null;
  apiKey?: string;
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
}

export class ApiError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function apiRequest<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const credential = options.apiKey ?? options.token;
  if (credential) headers.authorization = 'Bearer ' + credential;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

  const response = await fetch('/v1' + path, {
    method: options.method ?? 'GET',
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    const error =
      data && typeof data === 'object' && 'error' in data
        ? (data as { error?: { code?: string; message?: string } }).error
        : undefined;
    throw new ApiError(
      response.status,
      error?.code ?? 'REQUEST_FAILED',
      error?.message ?? 'The request could not be completed.',
    );
  }

  return data as T;
}
