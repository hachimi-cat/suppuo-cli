import { Command } from 'commander';
import chalk from 'chalk';

/**
 * `auth login` / `auth whoami` / `auth logout` — OIDC device flow.
 *
 * Real implementation once Huudis M1 lands. For the template, stubs
 * print clear "not yet wired" messages so cargo-culting into a product
 * doesn't accidentally ship a fake login.
 */

export const auth = new Command('auth').description('Authenticate against Huudis');

auth
  .command('login')
  .description('Sign in via OIDC device flow')
  .action(async () => {
    const issuer = process.env.FORJIO_OIDC_ISSUER ?? 'https://huudis.com';
    console.log(chalk.dim(`Would initiate device flow against ${issuer}.`));
    console.log(chalk.yellow('Not yet wired — implement once Huudis ships M1 (device flow endpoints).'));
  });

auth
  .command('whoami')
  .description('Show the currently signed-in identity')
  .action(async () => {
    console.log(chalk.yellow('Not signed in. Run `auth login` after Huudis M1 ships.'));
  });

auth
  .command('logout')
  .description('Clear the local session')
  .action(async () => {
    console.log(chalk.dim('No session to clear.'));
  });
