import { Command } from 'commander';
import chalk from 'chalk';
import { apiRequest, CliApiError } from '../lib/api.js';

/**
 * `suppuo tickets …` — the agent workspace surface from the terminal.
 *
 *   tickets list [--status open|pending|resolved|closed|all] [--limit N]
 *                [--q "…"] [--tag <tag>] [--channel web|email|whatsapp|telegram]
 *                [--assignee <sub>|me|unassigned]
 *   tickets show <id>
 *   tickets reply <id> --message "…" [--internal] [--author-name "…"]
 *   tickets close <id>
 *
 * Auth = the Huudis access token from `auth login` (or SUPPUO_TOKEN),
 * sent as Bearer against suppuo.com.
 */

export interface Ticket {
  id: string;
  number: number;
  subject: string;
  status: string;
  priority: string;
  channel: string;
  requesterEmail: string | null;
  requesterName: string | null;
  requesterPhone?: string | null;
  requesterExternalId?: string | null;
  assigneeSub: string | null;
  tags: string[];
  lastMessageAt: string;
  createdAt: string;
}

interface TicketMessage {
  id: string;
  authorType: string;
  authorName: string | null;
  body: string;
  isInternal: boolean;
  createdAt: string;
}

const STATUS_COLORS: Record<string, (s: string) => string> = {
  open: chalk.green,
  pending: chalk.yellow,
  resolved: chalk.blue,
  closed: chalk.dim,
};

function paintStatus(status: string): string {
  return (STATUS_COLORS[status] ?? chalk.white)(status);
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

export const tickets = new Command('tickets').description('Manage helpdesk tickets');

tickets
  .command('list')
  .description('List tickets (newest activity first)')
  .option('--status <status>', 'filter: open|pending|resolved|closed|all')
  .option('--limit <n>', 'max tickets to return (1-100)', (v) => parseInt(v, 10))
  .option('--q <text>', 'free-text search: subject + requester + message bodies')
  .option('--tag <tag>', 'filter to tickets carrying the tag (exact, lowercase)')
  .option('--channel <channel>', 'filter: web|email|whatsapp|telegram')
  .option('--assignee <sub>', "filter: a Huudis sub, 'me', or 'unassigned'")
  .action(
    async (opts: {
      status?: string;
      limit?: number;
      q?: string;
      tag?: string;
      channel?: string;
      assignee?: string;
    }) => {
    try {
      const { tickets: rows, counts } = await apiRequest<{
        tickets: Ticket[];
        counts: Record<string, number>;
      }>('GET', '/api/v1/tickets', {
        query: {
          status: opts.status,
          limit: opts.limit,
          q: opts.q,
          tag: opts.tag,
          channel: opts.channel,
          assignee: opts.assignee,
        },
      });

      if (rows.length === 0) {
        console.log(chalk.dim('No tickets.'));
      } else {
        for (const t of rows) {
          const requester = t.requesterName ?? t.requesterEmail ?? '—';
          const tags = t.tags?.length ? ` ${chalk.cyan(t.tags.map((x) => `[${x}]`).join(''))}` : '';
          console.log(
            [
              chalk.bold(`#${t.number}`.padEnd(6)),
              paintStatus(t.status).padEnd(18), // padded incl. color codes
              chalk.dim(t.priority.padEnd(7)),
              t.subject + tags,
              chalk.dim(`(${requester}, ${t.id})`),
            ].join(' '),
          );
        }
      }
      const summary = Object.entries(counts)
        .map(([s, n]) => `${s}: ${n}`)
        .join('  ');
      if (summary) console.log(chalk.dim(`\n${summary}`));
    } catch (e) {
      fail(e);
    }
  });

tickets
  .command('show <id>')
  .description('Show a ticket with its full message thread')
  .action(async (id: string) => {
    try {
      const t = await apiRequest<Ticket & { messages: TicketMessage[] }>(
        'GET',
        `/api/v1/tickets/${encodeURIComponent(id)}`,
      );
      console.log(chalk.bold(`#${t.number} ${t.subject}`));
      console.log(
        `${paintStatus(t.status)} · ${t.priority} · ${t.channel} · ${chalk.dim(t.id)}`,
      );
      const requester = t.requesterName
        ? `${t.requesterName} <${t.requesterEmail ?? '—'}>`
        : (t.requesterEmail ?? '—');
      console.log(`requester: ${requester}`);
      if (t.tags?.length) console.log(`tags:      ${t.tags.join(', ')}`);
      if (t.assigneeSub) console.log(`assignee:  ${t.assigneeSub}`);
      console.log(chalk.dim(`created:   ${t.createdAt}`));
      for (const m of t.messages) {
        const who = m.authorName ?? m.authorType;
        const tag = m.isInternal ? chalk.yellow(' [internal]') : '';
        console.log(`\n${chalk.bold(who)} ${chalk.dim(`(${m.authorType}, ${m.createdAt})`)}${tag}`);
        console.log(m.body);
      }
    } catch (e) {
      fail(e);
    }
  });

tickets
  .command('reply <id>')
  .description('Reply to a ticket (public by default)')
  .requiredOption('--message <text>', 'reply body')
  .option('--internal', 'post as an internal note (not visible to the requester)')
  .option('--author-name <name>', 'display name shown to the requester')
  .action(async (id: string, opts: { message: string; internal?: boolean; authorName?: string }) => {
    try {
      const out = await apiRequest<{ message: { id: string }; status: string }>(
        'POST',
        `/api/v1/tickets/${encodeURIComponent(id)}/messages`,
        {
          body: {
            body: opts.message,
            ...(opts.internal ? { isInternal: true } : {}),
            ...(opts.authorName ? { authorName: opts.authorName } : {}),
          },
        },
      );
      const kind = opts.internal ? 'Internal note' : 'Reply';
      console.log(
        chalk.green(`${kind} posted`),
        chalk.dim(`(${out.message.id})`),
        `— ticket is now ${paintStatus(out.status)}`,
      );
    } catch (e) {
      fail(e);
    }
  });

tickets
  .command('close <id>')
  .description('Close a ticket')
  .action(async (id: string) => {
    try {
      const t = await apiRequest<Ticket>('PATCH', `/api/v1/tickets/${encodeURIComponent(id)}`, {
        body: { status: 'closed' },
      });
      console.log(chalk.green(`Ticket #${t.number} closed.`));
    } catch (e) {
      fail(e);
    }
  });
