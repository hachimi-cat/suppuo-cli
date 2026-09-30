/**
 * How the generated `suppuo api <area> <action>` commands (commands/api.generated.ts)
 * make their call: this CLI's own token resolution and request helper (lib/api.ts —
 * SUPPUO_TOKEN or the `auth login` session, sent as Bearer), its own error output.
 */
import type { Command } from 'commander';
import chalk from 'chalk';
import { apiRequest, CliApiError, type HttpMethod } from './api.js';

export async function callRoute(
  _cmd: Command,
  method: string,
  path: string,
  query: Record<string, unknown>,
  body: Record<string, unknown> | undefined,
): Promise<void> {
  try {
    const q = Object.fromEntries(
      Object.entries(query).map(([k, v]): [string, string] => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
    );
    const data = await apiRequest<unknown>(method as HttpMethod, path, { query: q, body });
    console.log(JSON.stringify(data, null, 2));
    process.exit(0);
  } catch (err) {
    fail(err);
  }
}

/** Bad input to a generated command (a missing field, a value the spec does not allow). */
export async function failRoute(_cmd: Command, err: unknown): Promise<never> {
  fail(err);
}

// The same error output as the hand-written commands (tickets, billing, reports).
function fail(e: unknown): never {
  if (e instanceof CliApiError) {
    console.error(chalk.red(`error [${e.code}]`), e.message);
    if (e.requestId) console.error(chalk.dim(`requestId: ${e.requestId}`));
  } else {
    console.error(chalk.red('error'), e instanceof Error ? e.message : String(e));
  }
  process.exit(1);
}
