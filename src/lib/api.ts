import { loadSession, isAccessTokenStale } from './session.js';

/**
 * Thin Bearer-auth API helper for CLI commands.
 *
 * Token resolution order:
 *   1. `SUPPUO_TOKEN` env (explicit override, CI-friendly)
 *   2. the Huudis access token stored by `auth login`
 *      (~/.suppuo/session.json) — used as Bearer against suppuo.com.
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

export function resolveToken(): string {
  const envToken = process.env.SUPPUO_TOKEN;
  if (envToken) return envToken;
  const session = loadSession();
  if (!session) {
    throw new CliApiError(
      0,
      'AUTH_REQUIRED',
      'Not signed in. Run `suppuo auth login` or set SUPPUO_TOKEN.',
    );
  }
  if (isAccessTokenStale(session)) {
    throw new CliApiError(
      0,
      'TOKEN_EXPIRED',
      'Session expired. Run `suppuo auth login` again (or set SUPPUO_TOKEN).',
    );
  }
  return session.accessToken;
}

interface Envelope<T> {
  data: T | null;
  error: { code: string; message: string } | null;
  meta?: { requestId: string };
}

export async function apiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  opts: { body?: unknown; query?: Record<string, string | number | undefined> } = {},
): Promise<T> {
  const token = resolveToken();
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
