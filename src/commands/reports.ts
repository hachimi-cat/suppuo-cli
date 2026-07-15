import { Command } from 'commander';
import chalk from 'chalk';
import { apiRequest, CliApiError } from '../lib/api.js';

/**
 * `suppuo reports` — support analytics from the terminal.
 *
 *   reports summary [--days 7|30|90]
 */

interface ReportsSummary {
  periodDays: number;
  createdTotal: number;
  byChannel: Array<{ channel: string; count: number }>;
  byStatus: Array<{ status: string; count: number }>;
  openNow: number;
  resolvedInPeriod: number;
  firstResponse: { medianSeconds: number | null; p90Seconds: number | null; count: number };
  resolution: { medianSeconds: number | null; p90Seconds: number | null; count: number };
  csat: { average: number | null; count: number };
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

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86_400).toFixed(1)}d`;
}

export const reports = new Command('reports').description('Support analytics');

reports
  .command('summary', { isDefault: true })
  .description('Show the support summary for a window')
  .option('--days <n>', 'window: 7, 30, or 90 (default 30)', (v) => parseInt(v, 10))
  .action(async (opts: { days?: number }) => {
    try {
      const s = await apiRequest<ReportsSummary>('GET', '/api/v1/reports/summary', {
        query: { days: opts.days },
      });

      console.log(chalk.bold(`Support summary — last ${s.periodDays} days`));
      console.log(`tickets created:    ${s.createdTotal}`);
      console.log(`resolved in period: ${s.resolvedInPeriod}`);
      console.log(`open now:           ${s.openNow}`);

      if (s.byChannel.length > 0) {
        const channels = s.byChannel.map((c) => `${c.channel}: ${c.count}`).join('  ');
        console.log(`by channel:         ${channels}`);
      }
      if (s.byStatus.length > 0) {
        const statuses = s.byStatus.map((c) => `${c.status}: ${c.count}`).join('  ');
        console.log(`by status (now):    ${statuses}`);
      }

      console.log(
        `first response:     median ${formatDuration(s.firstResponse.medianSeconds)}, ` +
          `p90 ${formatDuration(s.firstResponse.p90Seconds)} ` +
          chalk.dim(`(${s.firstResponse.count} tickets)`),
      );
      console.log(
        `resolution:         median ${formatDuration(s.resolution.medianSeconds)}, ` +
          `p90 ${formatDuration(s.resolution.p90Seconds)} ` +
          chalk.dim(`(${s.resolution.count} tickets)`),
      );
      console.log(
        `csat:               ${s.csat.average !== null ? `${s.csat.average} / 3` : '—'} ` +
          chalk.dim(`(${s.csat.count} responses)`),
      );
    } catch (e) {
      fail(e);
    }
  });
