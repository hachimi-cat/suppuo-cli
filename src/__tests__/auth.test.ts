import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Command } from 'commander';

// `suppuo auth login | whoami | logout` end to end over a stubbed fetch: a fake
// Huudis (discovery → device_authorization → token → userinfo) and a fake API
// (GET /api/v1/me answers whoami).
// HOME points at a temp dir, so the credentials file is real.

const BRAND = 'suppuo';
const TOKEN_ENV = 'SUPPUO_TOKEN';
const API = 'https://suppuo.com/api/v1';
const ISSUER = 'https://idp.test';

interface Call {
  url: string;
  method: string;
  auth: string | null;
  body: string | undefined;
}

let home: string;
let calls: Call[];
let out: string[];
let err: string[];
let tokenPolls: number;
let exits: Array<number | undefined>;
const UP = BRAND.toUpperCase();
const ENV_KEYS = [TOKEN_ENV, `${UP}_BASE_URL`, UP, `${UP}_HUUDIS_ISSUER`, 'HOME'];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

function huudis(url: string, init: RequestInit): { status: number; body: unknown } | null {
  if (url === `${ISSUER}/.well-known/openid-configuration`) {
    return {
      status: 200,
      body: {
        issuer: ISSUER,
        device_authorization_endpoint: `${ISSUER}/device_authorization`,
        token_endpoint: `${ISSUER}/token`,
        userinfo_endpoint: `${ISSUER}/userinfo`,
        jwks_uri: `${ISSUER}/jwks`,
      },
    };
  }
  if (url === `${ISSUER}/device_authorization`) {
    return {
      status: 200,
      body: {
        device_code: 'dev_123',
        user_code: 'ABCD-EFGH',
        verification_uri: `${ISSUER}/device`,
        verification_uri_complete: `${ISSUER}/device?user_code=ABCD-EFGH`,
        expires_in: 600,
        interval: 0,
      },
    };
  }
  if (url === `${ISSUER}/token`) {
    const form = new URLSearchParams(String(init.body));
    if (form.get('grant_type') === 'refresh_token') {
      return { status: 200, body: { access_token: 'at_refreshed', refresh_token: 'rt_2', expires_in: 900, token_type: 'Bearer' } };
    }
    tokenPolls++;
    if (tokenPolls === 1) return { status: 400, body: { error: 'authorization_pending' } };
    return {
      status: 200,
      body: { access_token: 'at_device', refresh_token: 'rt_1', expires_in: 900, token_type: 'Bearer', scope: 'openid profile email' },
    };
  }
  if (url === `${ISSUER}/userinfo`) {
    return { status: 200, body: { sub: 'usr_1', email: 'dev@example.com', email_verified: true } };
  }
  return null;
}

/** GET /api/v1/me: the product's view of the bearer (a key named `sk_live_revoked…` is refused). */
function me(init: RequestInit): { status: number; body: unknown } {
  const auth = new Headers(init.headers).get('authorization') ?? '';
  if (auth.includes('revoked')) {
    return { status: 401, body: { data: null, error: { code: 'INVALID_TOKEN', message: 'Invalid API key' }, meta: {} } };
  }
  return { status: 200, body: { data: { sub: 'usr_1', accountId: 'acc_1' }, error: null, meta: {} } };
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      calls.push({
        url,
        method: init.method ?? 'GET',
        auth: new Headers(init.headers).get('authorization'),
        body: init.body === undefined ? undefined : String(init.body),
      });
      const r =
        huudis(url, init) ??
        (url === `${API}/me`
          ? me(init)
          : url.startsWith(API)
            ? { status: 200, body: { data: [], error: null, meta: {} } }
            : null);
      if (!r) return new Response('not found', { status: 404 });
      return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

/** A fresh CLI per run: commander keeps option values on its Command objects. */
async function run(args: string[]): Promise<number> {
  vi.resetModules();
  const { auth } = await import('../commands/auth.js');
  const { buildApiCommand } = await import('../commands/api.generated.js');
  const program = new Command(BRAND).exitOverride();
  program.addCommand(auth);
  program.addCommand(buildApiCommand());
  process.exitCode = undefined;
  exits = [];
  await program.parseAsync(['node', BRAND, ...args]);
  const code = exits.length ? (exits[0] ?? 0) : Number(process.exitCode ?? 0);
  process.exitCode = undefined;
  return code;
}

/** A GET route with no path parameters or required query, to prove which bearer is sent. */
async function simpleGet(): Promise<{ args: string[]; path: string }> {
  const { API_ROUTES } = await import('../commands/api.generated.js');
  for (const area of API_ROUTES) {
    for (const r of area.routes) {
      if (r.method === 'GET' && r.pathParams.length === 0 && r.query.every((q) => !q.required)) {
        return { args: ['api', area.area, r.name], path: r.path };
      }
    }
  }
  throw new Error('no simple GET route');
}

const credFile = (): string => path.join(home, `.${BRAND}`, 'session.json');
const saved = (): Record<string, unknown> => JSON.parse(fs.readFileSync(credFile(), 'utf8')) as Record<string, unknown>;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), `${BRAND}-auth-`));
  process.env.HOME = home;
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  delete process.env[TOKEN_ENV];
  delete process.env[`${UP}_BASE_URL`];
  delete process.env[UP];
  process.env[`${UP}_HUUDIS_ISSUER`] = ISSUER;
  calls = [];
  out = [];
  err = [];
  tokenPolls = 0;
  stubFetch();
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  // Recorded, not thrown: some commands call process.exit(0) inside a try.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exits.push(code);
    return undefined as never;
  }) as typeof process.exit);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe(`${BRAND} auth login --api-key`, () => {
  it('saves the key (0600) and the next api call sends it as the bearer', async () => {
    expect(await run(['auth', 'login', '--api-key', 'sk_live_abcdef123456'])).toBe(0);
    expect(saved()).toMatchObject({ kind: 'api_key', apiKey: 'sk_live_abcdef123456' });
    expect(fs.statSync(credFile()).mode & 0o777).toBe(0o600);
    expect(out.join('\n')).toContain('sk_live_…3456');
    expect(out.join('\n')).not.toContain('sk_live_abcdef123456');

    const { args, path: routePath } = await simpleGet();
    expect(await run(args)).toBe(0);
    const apiCall = calls.find((c) => c.url.startsWith(API))!;
    expect(apiCall.url).toBe(`${API}${routePath.replace(/^\/api\/v1/, '')}`);
    expect(apiCall.auth).toBe('Bearer sk_live_abcdef123456');
  });

  it('reads the key from stdin with --api-key -', async () => {
    const stdin = Object.getOwnPropertyDescriptor(process, 'stdin')!;
    Object.defineProperty(process, 'stdin', { value: Readable.from(['sk_live_fromstdin99\n']), configurable: true });
    try {
      expect(await run(['auth', 'login', '--api-key', '-'])).toBe(0);
    } finally {
      Object.defineProperty(process, 'stdin', stdin);
    }
    expect(saved()).toMatchObject({ kind: 'api_key', apiKey: 'sk_live_fromstdin99' });
  });

  it(`still lets ${TOKEN_ENV} win over the saved key`, async () => {
    await run(['auth', 'login', '--api-key', 'sk_live_saved000000']);
    process.env[TOKEN_ENV] = 'sk_live_fromenv00000';
    const { args } = await simpleGet();
    await run(args);
    expect(calls.find((c) => c.url.startsWith(API))!.auth).toBe('Bearer sk_live_fromenv00000');
  });
});

describe(`${BRAND} auth login (device flow)`, () => {
  it('discovery → device_authorization → pending → token, then saves the session', async () => {
    expect(await run(['auth', 'login', '--no-browser', '--json'])).toBe(0);

    const urls = calls.map((c) => `${c.method} ${c.url}`);
    expect(urls).toEqual([
      `GET ${ISSUER}/.well-known/openid-configuration`,
      `POST ${ISSUER}/device_authorization`,
      `POST ${ISSUER}/token`,
      `POST ${ISSUER}/token`,
      `GET ${ISSUER}/userinfo`,
    ]);
    const start = new URLSearchParams(calls[1]!.body);
    expect(start.get('client_id')).toBe(`${BRAND}-cli`);
    expect(start.get('scope')).toBe('openid profile email');
    expect(new URLSearchParams(calls[3]!.body).get('device_code')).toBe('dev_123');
    expect(err.join('\n')).toContain('ABCD-EFGH');

    expect(saved()).toMatchObject({
      kind: 'session',
      accessToken: 'at_device',
      refreshToken: 'rt_1',
      issuer: ISSUER,
      clientId: `${BRAND}-cli`,
    });
    expect(JSON.parse(out.join('\n'))).toMatchObject({ status: 'authenticated', mode: 'session', email: 'dev@example.com' });

    calls = [];
    const { args } = await simpleGet();
    await run(args);
    expect(calls.find((c) => c.url.startsWith(API))!.auth).toBe('Bearer at_device');
  });

  it('refreshes a stale session before calling the API and saves the rotated tokens', async () => {
    fs.mkdirSync(path.dirname(credFile()), { recursive: true });
    fs.writeFileSync(
      credFile(),
      JSON.stringify({
        kind: 'session',
        accessToken: 'at_old',
        refreshToken: 'rt_old',
        accessTokenExpiresAt: new Date(Date.now() - 1000).toISOString(),
        issuer: ISSUER,
        clientId: `${BRAND}-cli`,
      }),
    );
    const { args } = await simpleGet();
    await run(args);
    const refresh = calls.find((c) => c.url === `${ISSUER}/token`)!;
    expect(new URLSearchParams(refresh.body).get('grant_type')).toBe('refresh_token');
    expect(new URLSearchParams(refresh.body).get('refresh_token')).toBe('rt_old');
    expect(calls.find((c) => c.url.startsWith(API))!.auth).toBe('Bearer at_refreshed');
    expect(saved()).toMatchObject({ accessToken: 'at_refreshed', refreshToken: 'rt_2' });
  });
});

describe(`${BRAND} auth whoami / logout`, () => {
  it('whoami names the Huudis user for a session', async () => {
    await run(['auth', 'login', '--no-browser']);
    out = [];
    expect(await run(['auth', 'whoami', '--json'])).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      authenticated: true,
      mode: 'session',
      sub: 'usr_1',
      email: 'dev@example.com',
      issuer: ISSUER,
      accountId: 'acc_1',
    });
    const meCall = calls.find((c) => c.url === `${API}/me`)!;
    expect(meCall.auth).toBe('Bearer at_device');
  });

  it('whoami shows only a hint of a saved API key', async () => {
    await run(['auth', 'login', '--api-key', 'sk_live_abcdef123456']);
    out = [];
    expect(await run(['auth', 'whoami'])).toBe(0);
    expect(out.join('\n')).toContain('API key');
    expect(out.join('\n')).toContain('sk_live_…3456');
    expect(out.join('\n')).toContain('acc_1');
    expect(out.join('\n')).not.toContain('sk_live_abcdef123456');
    expect(calls.find((c) => c.url === `${API}/me`)!.auth).toBe('Bearer sk_live_abcdef123456');
  });

  it('whoami fails when the API refuses the key', async () => {
    await run(['auth', 'login', '--api-key', 'sk_live_revoked00000']);
    out = [];
    expect(await run(['auth', 'whoami', '--json'])).toBe(1);
    expect(JSON.parse(out.join('\n'))).toMatchObject({
      mode: 'api_key',
      rejected: true,
      serverError: expect.stringContaining('INVALID_TOKEN'),
    });
  });

  it('logout deletes the credentials, after which whoami says not signed in', async () => {
    await run(['auth', 'login', '--api-key', 'sk_live_abcdef123456']);
    expect(await run(['auth', 'logout'])).toBe(0);
    expect(fs.existsSync(credFile())).toBe(false);
    out = [];
    expect(await run(['auth', 'whoami', '--json'])).toBe(1);
    expect(JSON.parse(out.join('\n'))).toEqual({ authenticated: false });
    expect(await run(['auth', 'logout'])).toBe(0); // nothing left: still fine
  });

  it('an api call with no credentials fails with AUTH_REQUIRED', async () => {
    const { args } = await simpleGet();
    expect(await run(args)).toBe(1);
    expect(err.join('\n')).toContain('AUTH_REQUIRED');
    expect(calls.some((c) => c.url.startsWith(API))).toBe(false);
  });
});
