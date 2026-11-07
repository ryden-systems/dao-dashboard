# Star Atlas DAO Dashboard

A public dashboard for Star Atlas DAO governance, PIP funding, the Ecosystem Fund limit, and the DAO treasury.
It is a static website rebuilt by GitHub Actions. There is no server and no database, and visitors never need to log in.
Council editors sign in with Google to keep it up to date; every save goes into the Council's sheet.

## Manuals

- **[MANUAL_COUNCIL.md](MANUAL_COUNCIL.md)**: day-to-day use for Council editors: labels, PIPs, milestones and
  checklists, upcoming payments, wallets, members, minutes, Data health. Signed-in editors also see it on the
  dashboard's Help page.
- **[MANUAL_MAINTAINER.md](MANUAL_MAINTAINER.md)**: installation and upkeep: the repository, the Google Cloud project
  (including adding and removing editors), the sheet sync script, RPC endpoints, configuration, hosting, dependencies,
  troubleshooting, known limitations, the handover checklist, and how the figures are calculated.

## What it shows

| Page | Contents |
|---|---|
| Overview | headline figures, latest proposals, recent payouts |
| Council | members by term, elections, meetings with minutes and recordings, the Council's on-chain activity |
| Governance | PIPs per Council term, pass rate, participation and voting averages |
| Proposals | every PIP's outcome and vote split; per PIP: voting power over time, voter sizes, largest voters, payments, milestones |
| Balances | account balances and history, income (marketplace and SAGE fees), expenses per month, other wallets |
| Budget | running costs, the Foundation budget, upcoming payments, a projection (being built) |
| Ecosystem Fund | the 5% PIP limit, refills, the rules set by PIPs |
| Payments | every funded PIP: authorized, paid on chain, returned, remaining, milestones; payouts by purpose |
| Transactions | every token movement of the DAO accounts with what it was matched to and why |
| Data health | everything that disagrees or is missing (signed-in editors) |
| Help | the Council manual (signed-in editors) |

## Data sources

The Council's Google Sheet, the Star Atlas governance API, Solana mainnet, the Council's YouTube channel, and the
Jupiter price API in visitors' browsers. Details: MANUAL_MAINTAINER.md, section 1.

## Local development

Requires Node.js 20 or newer. There are no npm dependencies.

```sh
npm run build            # fetch everything and build dist/
npm run build:offline    # rebuild dist/ from data/ only, no network
npm test                 # every test, as the workflow runs them
npm run serve            # preview at http://localhost:8787
```

A `config.local.json` (git-ignored) with another `sheet.id` builds against a copy of the sheet and writes to
`data.local/`, so local test data never reaches the repository.

| Path | What it is |
|---|---|
| `config.json` | accounts, tokens, sheet tabs, Council multisigs, DAO rules, thresholds |
| `scripts/` | the build (`build.mjs`) and its modules (`lib/`) |
| `site/` | the website (HTML, CSS, JavaScript; no libraries) |
| `integrations/sheet-sync.gs` | the Apps Script that rebuilds the site when the sheet changes |
| `test/` | the tests run before every publish |
| `data/` | the build's committed state: ledger, snapshots, the sheet's CSV backup, vote cache |
