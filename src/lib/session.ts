import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * On-disk credentials for the CLI: `~/.suppuo/session.json` (0600, in a
 * 0700 directory). It holds ONE of:
 *
 *   - a Huudis session from `suppuo auth login` (OIDC device flow):
 *     access + refresh token, expiry, issuer and client id;
 *   - an API key from `suppuo auth login --api-key <key>` (machines, CI).
 *
 * Signing in either way replaces what was there; `auth logout` deletes the
 * file. `SUPPUO_TOKEN` in the environment beats both — the resolution
 * order lives in `lib/credentials.ts`.
 */

export interface StoredSession {
  kind?: 'session';
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accessTokenExpiresAt: string; // ISO
  scope?: string;
  issuer: string;
  clientId: string;
}

export interface StoredApiKey {
  kind: 'api_key';
  apiKey: string;
  savedAt: string; // ISO
}

export type StoredCredentials = StoredSession | StoredApiKey;

function brand(): string {
  return process.env.SUPPUO ?? 'suppuo';
}

export function sessionPath(): string {
  return path.join(os.homedir(), `.${brand()}`, 'session.json');
}

export function saveSession(s: StoredCredentials): void {
  const file = sessionPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
  // writeFileSync's mode only applies when it creates the file.
  fs.chmodSync(file, 0o600);
}

export function loadSession(): StoredCredentials | null {
  const file = sessionPath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredCredentials;
  } catch {
    return null;
  }
}

/** Delete the stored credentials. Returns whether there was anything to delete. */
export function clearSession(): boolean {
  const file = sessionPath();
  if (!fs.existsSync(file)) return false;
  fs.unlinkSync(file);
  return true;
}

/** Treat "stale" as <60s until expiry — gives the refresh call
 *  headroom before the access token is actually rejected upstream. */
export function isAccessTokenStale(s: StoredSession): boolean {
  return new Date(s.accessTokenExpiresAt).getTime() - Date.now() < 60_000;
}
