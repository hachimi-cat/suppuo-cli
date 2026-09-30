import { spawn } from 'node:child_process';
import { Command } from 'commander';
import chalk from 'chalk';
import { pollDeviceToken, startDeviceFlow } from '@forjio/sdk';
import { clearSession, loadSession, saveSession, sessionPath, type StoredSession } from '../lib/session.js';
import {
  CLI_NAME,
  TOKEN_ENV,
  DEFAULT_SCOPE,
  cliClientId,
  envToken,
  fetchUserinfo,
  isApiKey,
  isStale,
  issuerUrl,
  keyHint,
  refreshSession,
} from '../lib/credentials.js';
import { apiRequest, CliApiError } from '../lib/api.js';

/**
 * `suppuo auth login | whoami | logout`.
 *
 *   auth login                 Huudis OIDC device flow (RFC 8628): prints a code,
 *                              opens the browser, waits for approval, saves the
 *                              session to ~/.suppuo/session.json.
 *   auth login --api-key <k>   saves an API key (`sk_live_…`) instead — for machines
 *                              and CI. `--api-key -` reads the key from stdin.
 *   auth whoami                what the CLI is signed in as, and what suppuo.com makes
 *                              of it (GET /api/v1/me: the account it acts on).
 *   auth logout                deletes the saved session or key.
 *
 * `SUPPUO_TOKEN` in the environment still wins over anything saved.
 */

interface JsonOpt {
  json?: boolean;
}

function print(json: boolean | undefined, value: unknown, lines: string[]): void {
  if (json) console.log(JSON.stringify(value, null, 2));
  else for (const l of lines) console.log(l);
}

function failWith(json: boolean | undefined, code: string, message: string): void {
  if (json) console.error(JSON.stringify({ error: { code, message } }));
  else console.error(chalk.red(`Error [${code}]: ${message}`));
  process.exitCode = 1;
}

function errorCode(e: unknown): string {
  const c = (e as { code?: unknown }).code;
  return typeof c === 'string' ? c : 'AUTH_FAILED';
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/** Best effort: the URL is printed either way. */
function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser here — the user opens the URL
  }
}

interface ServerView {
  accountId?: string;
  /** Set when suppuo.com could not be asked, or refused the credential. */
  serverError?: string;
  /** suppuo.com answered 401/403: the credential does not work there. */
  rejected?: boolean;
}

/** What suppuo.com makes of the credential: GET /api/v1/me → the account it acts on. */
async function serverView(): Promise<ServerView> {
  try {
    const me = await apiRequest<{ sub?: string; accountId?: string }>('GET', '/api/v1/me');
    return { accountId: me.accountId };
  } catch (e) {
    const code = e instanceof CliApiError ? e.code : 'ERROR';
    const status = e instanceof CliApiError ? e.status : 0;
    return { serverError: `${code}: ${(e as Error).message}`, rejected: status === 401 || status === 403 };
  }
}

function serverLines(v: ServerView): string[] {
  if (!v.serverError) return [`Account:        ${v.accountId ?? '–'}`];
  return v.rejected
    ? [chalk.red(`Account:        suppuo.com rejected this credential (${v.serverError})`)]
    : [chalk.yellow(`Account:        could not check with suppuo.com (${v.serverError})`)];
}

/** A credential the API refuses is not a working sign-in. */
function exitOnReject(v: ServerView): void {
  if (v.rejected) process.exitCode = 1;
}

const envNote = (): string => chalk.yellow(`Note: ${TOKEN_ENV} is set in this shell and takes precedence.`);

export const auth = new Command('auth').description('Sign in with Huudis (browser) or an API key (CI)');

auth
  .command('login')
  .description('Sign in via the Huudis device flow, or save an API key with --api-key')
  .option('--api-key <key>', 'save an API key instead of signing in with a browser ("-" reads it from stdin)')
  .option('--issuer <url>', 'Huudis issuer URL (default: $SUPPUO_HUUDIS_ISSUER or https://huudis.com)')
  .option('--client-id <id>', 'OIDC client id (default: $SUPPUO_CLI_CLIENT_ID or suppuo-cli)')
  .option('--scope <scope>', 'OAuth scopes to request', DEFAULT_SCOPE)
  .option('--no-browser', 'print the sign-in URL without opening a browser')
  .option('--json', 'machine-readable output')
  .action(
    async (opts: JsonOpt & { apiKey?: string; issuer?: string; clientId?: string; scope: string; browser: boolean }) => {
      try {
        if (opts.apiKey !== undefined) {
          const key = (opts.apiKey === '-' ? await readStdin() : opts.apiKey).trim();
          if (!key || /\s/.test(key)) {
            failWith(opts.json, 'INVALID_API_KEY', 'The API key is empty or contains whitespace.');
            return;
          }
          saveSession({ kind: 'api_key', apiKey: key, savedAt: new Date().toISOString() });
          print(
            opts.json,
            { status: 'authenticated', mode: 'api_key', key: keyHint(key), credentials: sessionPath() },
            [chalk.green(`✓ API key ${keyHint(key)} saved to ${sessionPath()}.`)],
          );
          if (!opts.json && envToken()) console.error(envNote());
          return;
        }

        const issuer = (opts.issuer ?? issuerUrl()).replace(/\/+$/, '');
        const clientId = opts.clientId ?? cliClientId();
        const scope = opts.scope;
        const start = await startDeviceFlow({ issuer, clientId, scope });
        const url = start.verificationUriComplete ?? start.verificationUri;
        // Prompts go to stderr so `--json` leaves stdout a single JSON document.
        console.error(`\nTo sign in, open ${chalk.cyan(start.verificationUri)} and enter the code:\n`);
        console.error(`  ${chalk.bold.green(start.userCode)}\n`);
        if (start.verificationUriComplete) console.error(chalk.dim(`Or open: ${start.verificationUriComplete}`));
        console.error(chalk.dim(`Waiting for approval (expires in ${Math.max(1, Math.floor(start.expiresIn / 60))} min)…`));
        if (opts.browser) openBrowser(url);

        const tokens = await pollDeviceToken({
          issuer,
          clientId,
          deviceCode: start.deviceCode,
          interval: start.interval,
        });
        const session: StoredSession = {
          kind: 'session',
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          accessTokenExpiresAt: new Date(tokens.expiresAt * 1000).toISOString(),
          scope: tokens.scope ?? scope,
          issuer,
          clientId,
        };
        saveSession(session);
        const info = await fetchUserinfo(issuer, tokens.accessToken).catch(() => null);
        const who = info?.email ?? info?.sub;
        print(
          opts.json,
          {
            status: 'authenticated',
            mode: 'session',
            sub: info?.sub,
            email: info?.email,
            issuer,
            clientId,
            expiresAt: session.accessTokenExpiresAt,
            credentials: sessionPath(),
          },
          [chalk.green(`\n✓ Signed in${who ? ` as ${who}` : ''}. Session saved to ${sessionPath()}.`)],
        );
        if (!opts.json && envToken()) console.error(envNote());
      } catch (e) {
        failWith(opts.json, errorCode(e), (e as Error).message);
      }
    },
  );

auth
  .command('whoami')
  .description('Show what the CLI is signed in as (session, API key, or $SUPPUO_TOKEN)')
  .option('--json', 'machine-readable output')
  .action(async (opts: JsonOpt) => {
    try {
      const env = envToken();
      if (env) {
        const v = await serverView();
        print(opts.json, { authenticated: true, mode: 'env', variable: TOKEN_ENV, token: keyHint(env), ...v }, [
          `Signed in with: ${TOKEN_ENV} (environment)`,
          `Token:          ${keyHint(env)}`,
          ...serverLines(v),
        ]);
        exitOnReject(v);
        return;
      }
      const stored = loadSession();
      if (!stored) {
        if (opts.json) console.log(JSON.stringify({ authenticated: false }, null, 2));
        else
          console.error(
            chalk.yellow(
              `Not signed in. Run \`${CLI_NAME} auth login\` (browser) or \`${CLI_NAME} auth login --api-key <key>\` (CI).`,
            ),
          );
        process.exitCode = 1;
        return;
      }
      if (isApiKey(stored)) {
        const v = await serverView();
        print(
          opts.json,
          { authenticated: true, mode: 'api_key', key: keyHint(stored.apiKey), savedAt: stored.savedAt, credentials: sessionPath(), ...v },
          [
            `Signed in with: API key`,
            `Key:            ${keyHint(stored.apiKey)}`,
            ...serverLines(v),
            `Saved:          ${stored.savedAt}`,
            `Credentials:    ${sessionPath()}`,
          ],
        );
        exitOnReject(v);
        return;
      }
      const session = isStale(stored) ? await refreshSession(stored) : stored;
      const info = await fetchUserinfo(session.issuer, session.accessToken);
      const v = await serverView();
      print(
        opts.json,
        {
          authenticated: true,
          mode: 'session',
          sub: info.sub,
          email: info.email,
          emailVerified: info.email_verified,
          name: info.name,
          issuer: session.issuer,
          clientId: session.clientId,
          scope: session.scope,
          expiresAt: session.accessTokenExpiresAt,
          credentials: sessionPath(),
          ...v,
        },
        [
          `Signed in with: Huudis session`,
          `User:           ${info.email ?? '–'}${info.email_verified ? ' (verified)' : ''}`,
          `User ID:        ${info.sub ?? '–'}`,
          ...(info.name ? [`Name:           ${info.name}`] : []),
          ...serverLines(v),
          `Issuer:         ${session.issuer} (client ${session.clientId})`,
          `Access token:   valid until ${session.accessTokenExpiresAt}`,
          `Credentials:    ${sessionPath()}`,
        ],
      );
      exitOnReject(v);
    } catch (e) {
      failWith(opts.json, errorCode(e), (e as Error).message);
    }
  });

auth
  .command('logout')
  .description('Delete the saved session or API key')
  .option('--json', 'machine-readable output')
  .action((opts: JsonOpt) => {
    const cleared = clearSession();
    const env = Boolean(envToken());
    print(opts.json, { status: 'logged_out', cleared, credentials: sessionPath(), envTokenSet: env }, [
      cleared ? chalk.green(`✓ Signed out — removed ${sessionPath()}.`) : chalk.dim('Nothing to clear — not signed in.'),
    ]);
    if (!opts.json && env) console.error(chalk.yellow(`Note: ${TOKEN_ENV} is still set in this shell.`));
  });
