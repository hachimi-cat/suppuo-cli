import { Command } from 'commander';
import chalk from 'chalk';
import { apiRequest, CliApiError } from '../lib/api.js';

/**
 * `suppuo billing` — the workspace's plan from the terminal.
 *
 *   billing show    current subscription + the tier table
 *
 * Tier ids are English: free / starter / growth / business.
 */

interface TierDef {
  id: string;
  name: string;
  priceIdr: number;
  blurb: string;
  features: string[];
  agentLimit: number;
  waNumberLimit: number;
}

interface BillingInfo {
  subscription: {
    id: string | null;
    accountId: string;
    tier: string;
    status: string;
    currentPeriodEnd: string | null;
  };
  earlyAccess: boolean;
  tiers: TierDef[];
}

function fail(e: unknown): never {
  if (e instanceof CliApiError) {
    console.error(chalk.red(`error [${e.code}]`), e.message);
    if (e.requestId) console.error(chalk.dim(`requestId: ${e.requestId}`));
  } else {
    console.error(chalk.red('error'), e instanceof Error ? e.message : String(e));
  }
  process.exit(1);
}

function formatIdr(priceIdr: number): string {
  return priceIdr === 0 ? 'Free' : `Rp ${priceIdr.toLocaleString('en-US')}/mo`;
}

export const billing = new Command('billing').description('Workspace plan + tiers');

billing
  .command('show', { isDefault: true })
  .description('Show the current plan and the tier table')
  .action(async () => {
    try {
      const info = await apiRequest<BillingInfo>('GET', '/api/v1/billing');
      const { subscription: sub, tiers } = info;
      const current = tiers.find((t) => t.id === sub.tier);

      console.log(
        chalk.bold('Current plan:'),
        chalk.green(current?.name ?? sub.tier),
        chalk.dim(`(${sub.status})`),
      );
      if (sub.currentPeriodEnd) {
        console.log(chalk.dim(`period ends: ${sub.currentPeriodEnd}`));
      }
      if (info.earlyAccess) {
        console.log(chalk.yellow('Early access — no plan limits are enforced yet.'));
      }

      console.log('');
      for (const tier of tiers) {
        const marker = tier.id === sub.tier ? chalk.green('● ') : '  ';
        console.log(
          [
            marker + chalk.bold(tier.name.padEnd(9)),
            formatIdr(tier.priceIdr).padEnd(16),
            chalk.dim(`${tier.agentLimit} agents, ${tier.waNumberLimit} WA numbers`),
          ].join(' '),
        );
        console.log(`    ${chalk.dim(tier.blurb)}`);
      }
      console.log(
        chalk.dim('\nUpgrade from the dashboard: https://suppuo.com/dashboard/billing'),
      );
    } catch (e) {
      fail(e);
    }
  });
