# Star Atlas DAO Dashboard

A public dashboard for Star Atlas DAO governance, PIP funding, the Ecosystem Fund limit, and the DAO treasury.
It is a static website rebuilt once a day by GitHub Actions. There is no server, no database, and nothing to log in to.

---

## For the Council maintainer

**You edit one thing: the Council's PIP tracker sheet.** Everything else updates itself.

| What | Where it comes from | Who maintains it |
|---|---|---|
| PIP names, amounts, currency, category, SAC term, milestones, DAO ROI, notes | The PIP tracker sheet | You, in the sheet |
| Council activity per month | The sheet's "Goes into Dashboard" tab | You, in the sheet |
| Current and incoming Council members | A "Council members" tab in the sheet | You, in the sheet |
| Labels for payouts the dashboard could not match (optional tab) | A "Payment labels" tab in the sheet | You, in the sheet |
| Vote results, voting power, participation | Star Atlas governance API | Automatic |
| Treasury and Ecosystem Fund balances | Solana mainnet | Automatic |
| Payments to PIPs, returns, fee income | Solana mainnet | Automatic |
| The 5% Ecosystem Fund limit | Solana mainnet (fund balance each quarter) | Automatic |

**Fixing problems.** Open the **Data health** page. Every entry says what is wrong and where. Sheet issues are fixed in the sheet;
the entry disappears on the next build once the sheet is corrected.

**When does the site update?** Every day at 03:17 UTC. Anyone with access to the GitHub repository can trigger an update now:
*Actions* tab → *Build and publish dashboard* → *Run workflow*.

**The sheet must stay viewable by anyone with the link.** The dashboard reads it through Google's public CSV export.

### Council members (optional, recommended)

The Council page shows the current Council, any incoming Council, and every past Council.
To manage those lists, add a tab named **Council members** to the sheet, one row per member per term, with these
column headers (only **Name** is required; any order):

| Name | Role | Term | Start | End | Elected (PIP) | Wallet | Discord | X | Image | Show |
|---|---|---|---|---|---|---|---|---|---|---|
| ROME \| Earther | Council member | Term 4 | 10/11/2026 | 7/11/2027 | PIP-35 | | | handle | https://… | TRUE |

- Rows with the same **Term** form one Council. **Start / End** decide whether it shows as current, incoming, or past
  (this is checked in the visitor's browser, so the page moves on by itself on those dates).
- **Image** must be an `https://` link (e.g. the candidate portrait on cdn.staratlas.com).
- **Show = FALSE** hides a row without deleting it.

The tab is found by its name automatically. With two-way editing switched on, an editor can create it from the
dashboard in one click, pre-filled with the full Council history, and add members there.

Until that tab exists, the lists come from `data/council_history.json`, a record of past terms in which every term
cites its source (official API result, the DAO Knowledge Base, or who provided it), with names and portraits taken from
that term's election. Elections after the record are added automatically, but only when the result is certain: the
governance API published it, or there were no more candidates than seats. A contested election without a published
result is shown as "result not published", never guessed, because seats are decided by single transferable vote,
which the site does not recount. If the record ever disagrees with an official API result, the Data health page says so.

### Payment labels (optional)

Most payouts are matched to PIPs automatically. A payout stays "needs label" when the dashboard cannot be sure, usually because
one wallet was paid for several PIPs. To label them, add a tab to the sheet with these column headers:

| Signature | Recipient | PIP | Confirmed |
|---|---|---|---|
| the transaction signature (copy it from the dashboard's payment list) | optional: the recipient wallet, if one transaction paid several people | e.g. `PIP-28`, or `internal`, `refund`, `not a payout` | `TRUE` once checked |

The tab is found by its name ("Payment labels") automatically. With two-way editing switched on, editors can label a
payout straight from the dashboard instead (a **Label** button next to each payout that needs one); the tab is
created on the first label.

Labels with **Confirmed = TRUE** count as paid. Unconfirmed labels show as suggestions only.

---

## Two-way editing (included, switchable)

Signed-in editors can change the human-maintained fields on the dashboard itself: payout labels, a PIP's milestones,
DAO ROI and note, and Council members. Every save goes straight into the Council's sheet; the dashboard never keeps
its own copy. It is off until it is configured, and the dashboard works the same without it.

- **Who can edit** is decided by the sheet's own sharing settings. Editors sign in with Google; a save succeeds only
  if their Google account can edit the sheet. The sheet's version history records every change and who made it.
- **Narrow permission.** The dashboard asks for Google's `drive.file` permission, which covers only files the editor
  opens with this app. On first sign-in the editor selects the Council's sheet once in a Google file picker.
- **Conflicts.** Before saving, the dashboard re-reads the cells. If someone changed one in the sheet since the form
  was opened, it shows both values and lets the editor overwrite or take the sheet's value.
- **Visibility.** Saves appear for everyone after the next update (see *Instant updates* below, about five minutes).

### Setup (once, on a DAO-owned Google account)

1. [Google Cloud console](https://console.cloud.google.com/) → create a project.
2. *APIs & Services → Library*: enable **Google Sheets API** and **Google Picker API**.
3. *OAuth consent screen*: type **External**; add the scopes `.../auth/drive.file`, `openid`, `email`. These are
   non-sensitive scopes, so no security review is needed; while the app is in *Testing*, add each editor as a test user,
   or publish the app.
4. *Credentials → Create credentials → OAuth client ID*: type **Web application**; under *Authorized JavaScript
   origins* add the dashboard's address (e.g. `https://council.staratlas.com`, or `https://<org>.github.io`).
5. *Credentials → Create credentials → API key*: restrict it to the **Google Picker API** and to the dashboard's address.
6. Note the project's **project number** (*IAM & Admin → Settings*).
7. In `config.json`, set `editing.enabled` to `true` and fill in `googleClientId`, `googleApiKey` (the key from step 5)
   and `googleAppId` (the project number). These values are public by design; they identify the app and grant nothing.

All of this is free. Google may change console wording; the steps above describe it as of October 2026.

## Instant updates from the sheet

`integrations/sheet-sync.gs` is a small Google Apps Script attached to the Council's sheet. Every five minutes it
checks whether anything in the sheet changed (edits made in the sheet and saves from the dashboard alike) and, if so,
starts the GitHub workflow, exactly like pressing *Run workflow*. Google's edit triggers would miss saves made through
the API, which is why it checks a fingerprint of the contents instead.

1. In the sheet: *Extensions → Apps Script*; paste the file's contents and save.
2. Create a GitHub token: *GitHub → Settings → Developer settings → Fine-grained tokens → Generate*. Resource owner:
   the DAO's organization; repository access: **only this repository**; permissions: **Actions: Read and write**,
   nothing else; expiry: up to one year.
3. In Apps Script, *Project Settings → Script Properties*: add `GITHUB_REPO` (e.g. `star-atlas-dao/dashboard`) and
   `GITHUB_TOKEN`.
4. Run the `install` function once and approve the permissions Google asks for. `rebuildNow` tests the connection.

The token can only start workflow runs. Renew it before it expires (GitHub emails a reminder); paste the new one into
the same Script Property. Several edits in a row cause at most two builds, because the workflow runs one build at a
time and keeps only the latest waiting request.

---

## What the dashboard shows

| Page | Contents |
|---|---|
| **Overview** | Headline figures, latest proposals, recent payouts |
| **PIP payments** (MVP 1) | Every funded PIP: authorized, paid on-chain, returned, remaining, milestones, and what the sheet says. Below it, every on-chain movement with its match and confidence |
| **Council** (MVP 2) | PIPs per Council term, pass rate, participation per PIP, Council activity per month, elections |
| **Fund limit** (MVP 3) | The current quarter's 5% limit, what it would be today, the limit for every past quarter, refills |
| **Balance sheet** (MVP 4) | Account balances, balance history, recurring income (marketplace fee sweeps), payouts per month |
| **Vote results** (optional) | Every PIP's outcome and split; per-PIP detail with voting power over time, voter-size buckets, largest voters |
| **Data health** | Everything the build found that disagrees or is missing |

---

## How it works

```
  Council sheet (CSV) ─┐
  Governance API ──────┼─▶ scripts/build.mjs ─▶ data/   (committed: ledger, snapshots, vote cache)
  Solana mainnet RPC ──┘          │
                                  └──────────▶ dist/   (static site + data/dashboard.json) ─▶ GitHub Pages
```

1. **Fetch.** Read the sheet, the governance API, and new on-chain transactions.
2. **Ledger.** For a small set of low-volume addresses (the DAO wallets, the Treasury USDC account, the Fund's token accounts),
   list only the signatures newer than the last run, fetch those transactions, and append the token movements to `data/ledger.json`.
   The repository therefore *is* the index: no external indexing service.
3. **Reconcile.** Match each payout to a PIP and give it a confidence level (below).
4. **Compute.** Balances, quarterly limits, income, data-health flags.
5. **Publish.** Write `dist/`, run the smoke test, deploy to Pages, and commit the updated `data/` folder.

A typical daily run takes under 10 seconds and about 20 RPC calls.

### Payout matching

| Confidence | Meaning | Counts as paid |
|---|---|---|
| confirmed | a Council label says so | yes |
| matches sheet | the payout, or all payouts to one recipient, equal the PIP's "paid" figure in the sheet | yes |
| matches amount | the payout equals the PIP's authorized amount (PIPs sharing an amount in one transaction get one leg each) | yes |
| inferred | same recipient as a payout already matched to exactly one PIP | no, shown as a suggestion |
| internal | a transfer between DAO accounts (e.g. a Fund refill) | n/a |
| needs label | nothing matched | no |

Inflows from a known PIP recipient are treated as **returns**: paid stays the gross amount sent, and the return is shown
separately, so money sent and later returned is not counted as "still owed".

### The 5% limit

For each calendar quarter: 5% of the Ecosystem Fund's ATLAS balance at the start of the quarter, held for the whole quarter.
The fund's complete transaction history is in the ledger, so its balance at any past quarter boundary is exact.
Percent and cadence are set in `config.json` (`fundLimit`).

---

## Handover checklist

1. Transfer this repository to the DAO's GitHub organization (or push it to a new repository there).
2. *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
3. Optional: *Settings → Secrets and variables → Actions* → add `RPC_URL` and/or `SIGNATURES_RPC_URL` (see below).
4. Optional custom domain (e.g. `council.staratlas.com`): *Settings → Pages → Custom domain*, then a DNS `CNAME` record pointing to `<org>.github.io`.
5. *Actions → Build and publish dashboard → Run workflow* once, and open the published URL.

### RPC endpoints

| Variable | Used for | Requirement |
|---|---|---|
| `RPC_URL` | balances and transaction lookups | any Solana mainnet RPC |
| `SIGNATURES_RPC_URL` | listing each address's transaction history | **must be archive-complete** |

Both default to the public endpoint `https://api.mainnet-beta.solana.com`, which is sufficient for a daily run.

> **Why the second one matters.** While building this, one commercial RPC returned 34 of the Treasury wallet's 277 signatures
> (a gap from February 2025 to May 2026) with no error. The public endpoint returned all 277. A ledger built from an
> incomplete history silently misses payouts. The data-health page checks for this: every daily balance snapshot is
> compared with the balance the ledger implies for that moment, and any difference is a critical flag.

---

## Local development

Requires Node.js 20 or newer. There are no npm dependencies.

```sh
npm run build            # fetch everything and build dist/
npm run build:offline    # rebuild dist/ from data/ only, no network
npm test                 # render every page; editor core against a simulated Sheets API; editor UI
npm run serve            # preview at http://localhost:8787
```

Set `RPC_URL` / `SIGNATURES_RPC_URL` in the environment to use other endpoints.

### Files

```
config.json              accounts, mints, sheet tabs, thresholds (developers only)
scripts/build.mjs        entry point (fetch phase + compute phase)
scripts/lib/sheet.mjs    Council sheet importer (columns found by header text)
scripts/lib/governance.mjs  governance API + vote cache
scripts/lib/ledger.mjs   incremental on-chain ledger
scripts/lib/balances.mjs balances, snapshots, historical balances
scripts/lib/reconcile.mjs  payout to PIP matching
scripts/lib/limit.mjs    quarterly 5% limit
scripts/lib/health.mjs   data-health checks
scripts/lib/members.mjs  Council terms (sheet tab, sourced record, published results)
site/                    the static site (HTML, CSS, JS; no libraries)
site/sheetmap.js         maps dashboard fields to sheet cells; validation (two-way editing)
site/editor.js           Google sign-in and Sheets API writes (two-way editing)
integrations/sheet-sync.gs  Apps Script for the sheet: rebuild when the sheet changes
data/council_history.json   sourced record of Council terms (until the sheet tab exists)
test/smoke.mjs           renders every page against real data
test/editor.test.mjs     editor core against a simulated Google Sheets API, with round trips through the importers
test/editor_ui.test.mjs  editing controls: sign-in, label, edit with conflict, Council tab, add member
data/                    committed build state, updated by every run
dist/                    build output (not committed)
```

`data/sheet/` is a raw backup of the Council's sheet: every tab (including ones the dashboard does not use) saved
cell for cell as Google's CSV export on every build, with `index.json` listing the tabs. Git keeps every version, so
the sheet's full value history survives even if Google Sheets became unavailable (formulas and formatting are not
included; the export only has values). A tab that fails to download keeps its previous copy.

`data/` also holds the ledger (`ledger.json`), per-address cursors (`cursors.json`), daily balance snapshots (`balances.json`),
the last fetched sheet and governance data, and cached votes of closed proposals (`votes/`). Deleting `ledger.json` and
`cursors.json` triggers a full backfill on the next run (a few minutes).

---

## Known limitations

- **Treasury ATLAS history.** The Treasury's ATLAS account receives tens of thousands of fee transfers a day, so it is not
  scanned. Its *payouts* are still captured (the Treasury wallet signs every one), but its balance history is recorded as one
  snapshot per build, starting from the first run.
- **Elections.** Ranked Council elections allocate seats by single transferable vote. The dashboard shows first preferences
  per candidate and does not recount the election.
- **Matching needs labels where the chain is ambiguous**, most often when one wallet is paid for several PIPs.
- **USD-denominated PIPs paid in ATLAS.** Remaining is shown only in the authorized currency; a PIP paid in another token
  shows what was paid and relies on its milestones for completion.
