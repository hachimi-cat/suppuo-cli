import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * On-disk session store for the CLI. Ported from saas-huudis.
 *
 * Lives at `~/.SUPPUO/session.json` with 0600 perms. Holds the
 * tokens from `auth login` so subsequent commands don't re-prompt.
 *
 * The actual wiring into `auth login/whoami/logout` lands once Huudis
 * M1 ships the device-flow endpoints — until then this is a pure
 * utility waiting for its caller.
 */

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accessTokenExpiresAt: string; // ISO
  scope: string;
  issuer: string;
  clientId: string;
}

function brand(): string {
  return process.env.SUPPUO ?? 'suppuo';
}

function sessionPath(): string {
  return path.join(os.homedir(), `.${brand()}`, 'session.json');
}

export function saveSession(s: StoredSession): void {
  const file = sessionPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function loadSession(): StoredSession | null {
  const file = sessionPath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredSession;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  const file = sessionPath();
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/** Treat "stale" as <60s until expiry — gives the refresh call
 *  headroom before the access token is actually rejected upstream. */
export function isAccessTokenStale(s: StoredSession): boolean {
  return new Date(s.accessTokenExpiresAt).getTime() - Date.now() < 60_000;
}
