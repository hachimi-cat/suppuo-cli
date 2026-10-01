import { Command } from 'commander';
import { auth } from './commands/auth.js';
import { tickets } from './commands/tickets.js';
import { billing } from './commands/billing.js';
import { reports } from './commands/reports.js';
import { buildApiCommand } from './commands/api.generated.js';

const brand = process.env.SUPPUO ?? 'suppuo';

const program = new Command()
  .name(brand)
  .description(`CLI for ${brand} — part of the Forjio commerce suite.`)
  .version('0.4.0');

program.addCommand(auth);
program.addCommand(tickets);
program.addCommand(billing);
program.addCommand(reports);
program.addCommand(buildApiCommand());

program.parseAsync(process.argv).catch((e) => {
  console.error(e);
  process.exit(1);
});
