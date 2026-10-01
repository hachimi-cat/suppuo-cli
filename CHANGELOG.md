# Changelog

## 0.4.0
- `suppuo api webhook-subscriptions deliveries` (`--subscription-id`, `--status`, `--type`, `--limit`, `--cursor`), `get-deliveries <id>`, `deliveries-retry <id>` and `event-types`: the webhook delivery log, with every attempt, and a retry.
- `suppuo api webhook-subscriptions update <id>` takes `--url` and `--events` too (it only took `--active`).

## 0.3.0
- A route read by id next to its list is named `get` + the list's name: `suppuo api help get-articles` (was `suppuo api help articles-2`), `suppuo api requester get-tickets` (was `suppuo api requester tickets-2`). Each old name still works, hidden from help.

## 0.2.3
- `suppuo auth login` now signs in for real: the Huudis device flow (prints a code, opens the browser, saves the session to `~/.suppuo/session.json` and refreshes it when it expires), or `--api-key <key>` (`-` reads stdin) to save an `sk_live_…` API key for machines and CI.
- `suppuo auth whoami` shows the Huudis user or which key is in use, plus the workspace the API resolves it to (`GET /api/v1/me`); `suppuo auth logout` deletes the saved credentials. All three take `--json`.
- `SUPPUO_TOKEN` still wins over the saved sign-in.

## 0.2.1
- Package metadata now points at the public mirror repo (github.com/hachimi-cat/suppuo-cli).
