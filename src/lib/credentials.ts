/**
 * Which credential the CLI sends as `Authorization: Bearer …`, in order:
 *
 *   1. `SUPPUO_TOKEN` in the environment (CI, scripts, one-off overrides);
 *   2. the API key saved by `suppuo auth login --api-key <key>`;
 *   3. the Huudis session saved by `suppuo auth login` (device flow),
 *      refreshed with its refresh token when the access token is about to
 *      expire, and saved back.
 *
 * Only `loadSession` / `saveSession` come from lib/session.ts, so tests that
 * stub the session store keep working.
 */
import { fetchDiscovery, refreshAccessToken } from '@forjio/sdk';
import { loadSession, saveSession, type StoredApiKey, type StoredCredentials, type StoredSession } from './session.js';

export const CLI_NAME = 'suppuo';
export const TOKEN_ENV = 'SUPPUO_TOKEN';
export const ISSUER_ENV = 'SUPPUO_HUUDIS_ISSUER';
export const CLIENT_ID_ENV = 'SUPPUO_CLI_CLIENT_ID';
export const DEFAULT_ISSUER = 'https://huudis.com';
export const DEFAULT_CLIENT_ID = 'suppuo-cli';
export const DEFAULT_SCOPE = 'openid profile email';

/** Huudis issuer: $SUPPUO_HUUDIS_ISSUER, then $FORJIO_OIDC_ISSUER, then huudis.com. */
export function issuerUrl(): string {
  return (process.env[ISSUER_ENV] || process.env.FORJIO_OIDC_ISSUER || DEFAULT_ISSUER).replace(/\/+$/, '');
}

/** The CLI's public OIDC client: $SUPPUO_CLI_CLIENT_ID, else `suppuo-cli`. */
export function cliClientId(): string {
  return process.env[CLIENT_ID_ENV] || DEFAULT_CLIENT_ID;
}

export type TokenSource = 'env' | 'api_key' | 'session';

export interface Bearer {
  token: string;
  source: TokenSource;
}

/** No usable credential, or a session that could not be refreshed. */
export class CredentialsError extends Error {
  constructor(
    message: string,
    readonly code: 'AUTH_REQUIRED' | 'TOKEN_EXPIRED',
  ) {
    super(message);
    this.name = 'CredentialsError';
  }
}

export function envToken(): string | undefined {
  const v = process.env[TOKEN_ENV]?.trim();
  return v ? v : undefined;
}

export function isApiKey(c: StoredCredentials | null | undefined): c is StoredApiKey {
  return !!c && (c as StoredApiKey).kind === 'api_key';
}

/** An access token within a minute of expiry is refreshed first. No expiry recorded → use as is. */
export function isStale(s: StoredSession, now: number = Date.now()): boolean {
  const t = Date.parse(s.accessTokenExpiresAt);
  return Number.isFinite(t) && t - now < 60_000;
}

/** Exchange the refresh token for a new access token and save the rotated pair. */
export async function refreshSession(s: StoredSession): Promise<StoredSession> {
  if (!s.refreshToken) {
    throw new CredentialsError(`Session expired. Run \`${CLI_NAME} auth login\` again.`, 'TOKEN_EXPIRED');
  }
  let t: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    t = await refreshAccessToken({ issuer: s.issuer, clientId: s.clientId, refreshToken: s.refreshToken });
  } catch (e) {
    throw new CredentialsError(
      `Session expired and could not be refreshed (${(e as Error).message}). Run \`${CLI_NAME} auth login\` again.`,
      'TOKEN_EXPIRED',
    );
  }
  const next: StoredSession = {
    ...s,
    kind: 'session',
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? s.refreshToken,
    accessTokenExpiresAt: new Date(t.expiresAt * 1000).toISOString(),
    scope: t.scope ?? s.scope,
  };
  saveSession(next);
  return next;
}

/** The bearer to send, or null when nothing is configured. */
export async function resolveBearer(): Promise<Bearer | null> {
  const env = envToken();
  if (env) return { token: env, source: 'env' };
  const stored = loadSession();
  if (!stored) return null;
  if (isApiKey(stored)) return stored.apiKey ? { token: stored.apiKey, source: 'api_key' } : null;
  if (!stored.accessToken) return null;
  const fresh = isStale(stored) ? await refreshSession(stored) : stored;
  return { token: fresh.accessToken, source: 'session' };
}

/** `sk_live_…wxyz` — enough to recognise a key without printing it. */
export function keyHint(key: string): string {
  if (key.length <= 12) return `${key.slice(0, 3)}…`;
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export interface Userinfo {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [claim: string]: unknown;
}

/** Huudis's OIDC userinfo for an access token (endpoint from discovery). */
export async function fetchUserinfo(issuer: string, accessToken: string): Promise<Userinfo> {
  const disco = await fetchDiscovery(issuer);
  const url = disco.userinfo_endpoint ?? `${issuer}/api/v1/oidc/userinfo`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new CredentialsError(
      `Huudis rejected the session (HTTP ${res.status}). Run \`${CLI_NAME} auth login\` again.`,
      'TOKEN_EXPIRED',
    );
  }
  return (await res.json()) as Userinfo;
}
