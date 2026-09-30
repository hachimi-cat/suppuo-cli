import { CredentialsError, resolveBearer } from './credentials.js';

/**
 * Thin Bearer-auth API helper for CLI commands.
 *
 * Token resolution order (lib/credentials.ts):
 *   1. `SUPPUO_TOKEN` env (explicit override, CI-friendly — an sk_live_… API key)
 *   2. the API key saved by `suppuo auth login --api-key <key>`
 *   3. the Huudis session saved by `suppuo auth login` (~/.suppuo/session.json),
 *      refreshed when it is about to expire.
 *
 * Unwraps the Forjio `{ data, error, meta }` envelope and throws
 * `CliApiError` carrying the envelope's `error.code`.
 */

export class CliApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestId: string | undefined;

  constructor(status: number, code: string, message: string, requestId?: string) {
    super(message);
    this.name = 'CliApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
  }
}

export function baseUrl(): string {
  return (process.env.SUPPUO_BASE_URL ?? 'https://suppuo.com').replace(/\/+$/, '');
}

export async function resolveToken(): Promise<string> {
  let resolved;
  try {
    resolved = await resolveBearer();
  } catch (e) {
    if (e instanceof CredentialsError) throw new CliApiError(0, e.code, e.message);
    throw e;
  }
  if (!resolved) {
    throw new CliApiError(
      0,
      'AUTH_REQUIRED',
      'Not signed in. Run `suppuo auth login` (or `suppuo auth login --api-key <key>`), or set SUPPUO_TOKEN.',
    );
  }
  return resolved.token;
}

interface Envelope<T> {
  data: T | null;
  error: { code: string; message: string } | null;
  meta?: { requestId: string };
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export async function apiRequest<T>(
  method: HttpMethod,
  path: string,
  opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const token = await resolveToken();
  const url = new URL(baseUrl() + path);
  for (const [k, v] of Object.entries(opts.query ?? {})) {
    if (v !== undefined) url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new CliApiError(0, 'NETWORK_ERROR', e instanceof Error ? e.message : String(e));
  }

  let envelope: Envelope<T>;
  try {
    envelope = (await res.json()) as Envelope<T>;
  } catch {
    throw new CliApiError(res.status, 'INVALID_RESPONSE', `non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok || envelope.error) {
    throw new CliApiError(
      res.status,
      envelope.error?.code ?? 'UNKNOWN',
      envelope.error?.message ?? `HTTP ${res.status}`,
      envelope.meta?.requestId,
    );
  }
  return envelope.data as T;
}
