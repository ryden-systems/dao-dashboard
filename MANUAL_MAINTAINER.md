# Star Atlas DAO Dashboard: maintainer manual

For whoever installs and looks after the dashboard: the GitHub repository, the Google Cloud project, the sheet's
sync script and the Solana RPC endpoint. No programming is needed for any of it. How the Council uses the dashboard
day to day is in [MANUAL_COUNCIL.md](MANUAL_COUNCIL.md), which signed-in editors also see on the dashboard's Help page.

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Google Cloud project: editor sign-in](#3-google-cloud-project-editor-sign-in)
4. [Sheet sync script: instant updates](#4-sheet-sync-script-instant-updates)
5. [RPC endpoints](#5-rpc-endpoints)
6. [Configuration](#6-configuration)
7. [Hosting and domain](#7-hosting-and-domain)
8. [Recurring dependencies](#8-recurring-dependencies)
9. [Troubleshooting](#9-troubleshooting)
10. [Known limitations](#10-known-limitations)
11. [Handover checklist](#11-handover-checklist)
12. [Reference: how the figures are calculated](#12-reference-how-the-figures-are-calculated)
13. [Reference: the sheet's tabs](#13-reference-the-sheets-tabs)

---

## 1. Overview

The dashboard is a static website. A scheduled job on GitHub reads its sources, calculates everything, and publishes
the result to GitHub Pages. There is no server and no database to run, and visitors never log in. Council editors can
sign in with Google to change the Council's sheet from the dashboard.

### Where the data comes from

| Source | What it provides | Read by |
|---|---|---|
| The Council's Google Sheet | PIPs (the Tracker tab), payment labels, wallets, milestones and checklists, upcoming payments, Council members, meeting minutes, payment documents | the build, and every visitor's browser (live, see below) |
| Star Atlas governance API | proposals, votes, voting power | the build |
| Solana mainnet, through an RPC endpoint | balances, every transaction of the DAO accounts, the Council multisigs' activity | the build |
| The Council's YouTube channel (public feed) | meeting recordings | the build |
| Jupiter price API | live token prices for the USD values | each visitor's browser |

The sheet stays the place where everything the Council decides is stored. Figures that come from the chain or the
governance API (amounts paid, vote results, balances) are calculated, never typed in.

### The build

```
  Council sheet ───────┐
  Governance API ──────┼─▶ scripts/build.mjs ─▶ data/   (committed: ledger, snapshots, sheet backup, vote cache)
  Solana mainnet RPC ──┘          │
                                  └──────────▶ dist/   (the website + data/dashboard.json) ─▶ GitHub Pages
```

1. **Fetch:** read the sheet, the governance API and the new on-chain transactions.
2. **Ledger:** for the DAO's own addresses, read only the transactions since the last run and add their token
   movements to `data/ledger.json`. Over time the repository itself becomes the index; no outside indexing service
   is used.
3. **Reconcile:** match every payout to a PIP or a cost category, with a confidence level.
4. **Compute:** balances, the Ecosystem Fund limit, income, the Budget page, the Data health checks.
5. **Test and publish:** run every test, then publish `dist/` to GitHub Pages and commit the updated `data/` folder.

A daily run takes about one minute.

### When the site updates

- **Daily** at 03:17 UTC (GitHub can start scheduled runs late, sometimes by hours).
- **When the code changes:** a push to `main` that touches `site/`, `scripts/`, `config.json`, `test/` or the
  workflow.
- **When the sheet changes,** within about five minutes, if the sheet sync script is installed (section 4). The
  editors' **Update now** button uses the same script.
- **By hand:** *Actions* tab → *Build and publish dashboard* → *Run workflow*.

Only one build runs at a time; further requests wait, and only the latest waiting one is kept.

### What the page does on its own

Each visitor's browser also reads the sheet directly when the page opens, and redoes the build's calculation with the
same code. A change in the sheet (a label, a wallet name, a milestone, a Council member) therefore shows on the next
page load, without waiting for a build. The header shows when the sheet was last read ("sheet live HH:MM UTC").
New on-chain transactions and balances still need a build.

### When something fails

A failed build or a failed test publishes nothing: the last good version stays online. The failed run is listed in the
*Actions* tab with its log, and GitHub sends a notification: for the daily run, to whoever last changed the workflow
file; for a manual run, to whoever started it. Problems with the data itself (the sheet disagreeing with the chain, a payout nobody labelled)
never stop a build; they are listed on the dashboard's **Data health** page for signed-in editors.

### The repository

| Path | What it is |
|---|---|
| `config.json` | accounts, token mints, sheet tabs, Council multisigs, DAO rules, thresholds (section 6) |
| `scripts/` | the build |
| `site/` | the website (HTML, CSS, JavaScript; no libraries) |
| `integrations/sheet-sync.gs` | the sheet sync script (section 4) |
| `test/` | the tests run before every publish |
| `data/` | the build's state, committed by every run: ledger, balance snapshots, a backup of every sheet tab as CSV (`data/sheet/`), cached votes |
| `.github/workflows/build.yml` | the scheduled build and deploy |

---

## 2. Installation

You need: a GitHub organization for the Council, a Google account owned by the DAO (for the Google Cloud project and,
if documents are used, their Drive folder), and edit access to the Council's sheet.

1. **Repository.** Transfer the repository to the Council's GitHub organization, or push it to a new repository
   there. Keep it public: GitHub Actions and Pages are free for public repositories, and a public repository suits a
   DAO transparency tool.
2. **Workflow permissions.** *Settings → Actions → General → Workflow permissions:* **Read and write permissions**.
   The build commits the updated `data/` folder; an organization that only allows read access blocks that step.
3. **Pages.** *Settings → Pages → Build and deployment → Source:* **GitHub Actions**.
4. **Sheet.** In `config.json`, `sheet.id` must be the Council's sheet (the long id in its address), and `testNotice`
   must not be there (it shows a test banner on every page). The sheet must stay viewable by anyone with the link:
   the build and the page read it through Google's public export.
5. **RPC endpoint** (optional, recommended): see section 5.
6. **First run.** *Actions → Build and publish dashboard → Run workflow*. When it is green, open the address shown
   under *Settings → Pages*.
7. **Editor sign-in:** section 3. **Instant updates:** section 4. **Own address** (e.g. `council.staratlas.com`):
   section 7.

### Building on your own computer

Needs Node.js 20 or newer; there is nothing else to install.

```sh
npm run build            # fetch everything and build dist/
npm run build:offline    # rebuild dist/ from data/ only, without network
npm test                 # every test, as the workflow runs them
npm run serve            # preview at http://localhost:8787
```

To try changes against a copy of the sheet without touching the Council's, create `config.local.json` (git-ignored)
with the copy's `sheet.id`. A local build then reads the copy and writes its data to `data.local/` (also git-ignored),
so nothing it fetches reaches the repository.

---

## 3. Google Cloud project: editor sign-in

Editing from the dashboard uses Google sign-in. Google requires a Google Cloud project for that. It holds no data,
only the setup below, and it costs nothing. Without it the dashboard works the same, read-only.

### Setup (once)

Do this on the DAO-owned Google account.

1. [Google Cloud console](https://console.cloud.google.com/) → create a project.
2. *APIs & Services → Library:* enable **Google Sheets API**, and **Google Drive API** if payment documents are used.
3. *Google Auth Platform:* audience **External**. Under *Data access* add `.../auth/spreadsheets`, `openid` and
   `email` (and `.../auth/drive.file` if payment documents are used).
4. *Clients → Create client:* type **Web application**. Under *Authorized JavaScript origins* add the dashboard's
   address (e.g. `https://council.staratlas.com`, or `https://<org>.github.io`). The client secret is not used.
5. In `config.json`, set `editing.enabled` to `true` and `editing.googleClientId` to the new client's ID. The ID is
   public by design: it names the app and grants nothing.

Google changes the console's wording now and then; these steps describe it as of November 2026.

### Ownership

The project must belong to the DAO-owned account and have at least one second owner (*IAM & Admin → IAM → Grant
access*, role *Owner*). A project owned by one personal account is lost to the DAO if that account is. If the project
is lost anyway, create a new one with the five steps above and put its client ID into `config.json`. A deleted
project can be restored by its owners for 30 days.

### Adding an editor

An editor needs two things; one without the other is not enough.

1. **Edit access to the sheet:** share the Council's sheet with their Google account as *Editor*. This decides what
   they can change: every save goes into the sheet under their own account, and the sheet's version history shows it.
2. **The test-user list:** *Google Auth Platform → Audience → Test users → Add users*, their Google address. While
   the app is in *Testing* (up to 100 test users, plenty for a Council), only accounts on this list can sign in.

On their first sign-in Google shows an "unverified app" notice (continue), then asks for the spreadsheet permission:
the box must be ticked, or the dashboard reports "Sheets permission missing" and asks again on the next sign-in.
Google words that permission as access to all of the account's spreadsheets; the dashboard only ever addresses the
sheet in its configuration, and the sign-in lasts only while the page is open (about an hour).

Keeping the app in *Testing* is fine for the Council. Moving it to *In production* only matters beyond 100 users and
needs Google's verification (a privacy policy, a verified domain and a review of several weeks).

### Removing an editor

1. **Remove their edit access to the sheet.** This is what stops them: without it, every save is refused by Google.
2. Remove them from the test-user list, so they cannot sign in at all.

A sign-in lasts at most about an hour in the open page, so nothing else needs revoking.

### Payment documents

Invoices and receipts are uploaded by one account only, `editing.documents.owner` in `config.json`, into a "Payment
documents" folder in its Google Drive. The dashboard can only see the files it created itself, never the rest of that
Drive. To let other members open the files, share that folder with them in Google Drive, never as "anyone with the
link": invoices contain bank details. A changed owner account means changing `editing.documents.owner`; files
uploaded by the old account stay in its Drive.

### Sign-in messages

| The dashboard says | Cause | Fix |
|---|---|---|
| Access refused | the account is not on the test-user list | add it (above) |
| No edit rights | the account can view the sheet but not edit it | share the sheet with it as Editor |
| Sheets permission missing | the spreadsheet box was not ticked | sign in again and tick it |
| Pop-up blocked | the browser blocked Google's sign-in window | allow pop-ups for the dashboard |
| No access to sheet / Sheet not found | the account cannot open the sheet at all | share the sheet with it |

Hovering over the message shows the full explanation. A sign-in failing on a new address means that address is
missing from the client's *Authorized JavaScript origins* (step 4).

---

## 4. Sheet sync script: instant updates

`integrations/sheet-sync.gs` is a small Google Apps Script attached to the Council's sheet. Every five minutes it
checks whether anything in the sheet changed, edits made in the sheet and saves from the dashboard alike, and if so
starts the GitHub workflow, exactly like *Run workflow*. Without it the site still updates daily, and the editors'
**Update now** button has no effect.

### Install

1. In the sheet: *Extensions → Apps Script*; paste the contents of `integrations/sheet-sync.gs` and save.
2. Create a GitHub token: *GitHub → Settings → Developer settings → Fine-grained tokens → Generate*.
   - Resource owner: the Council's organization.
   - Repository access: **only this repository**.
   - Permissions: **Actions: Read and write**, nothing else.
   - Expiry: up to one year.
3. In Apps Script, *Project Settings → Script Properties:* add `GITHUB_REPO` (e.g. `star-atlas-dao/dashboard`) and
   `GITHUB_TOKEN`.
4. Run the `install` function once and approve the permissions Google asks for. Run `rebuildNow` to test it: a new
   run appears in the repository's *Actions* tab.

Do this from a DAO-owned Google account: the script runs as the account that installed it.

### Renewing the token

The token can do nothing except start a build. GitHub emails a reminder before it expires: create a new one with the
same settings and paste it into the `GITHUB_TOKEN` Script Property. Until then, instant updates and **Update now** stop
working, and the site still updates daily.

### Moving or removing it

To move the script to another account or sheet, run `uninstall` in the old copy, delete it, and revoke its token
(*GitHub → Settings → Developer settings → Fine-grained tokens*). After the repository is renamed or transferred,
update `GITHUB_REPO`.

### Update now

**Update now** writes the current time into a small "Dashboard" tab of the sheet (created on first use). The script
sees that change on its next check and starts a build, so the site refreshes within about five minutes. No GitHub
login is involved for the editor.

---

## 5. RPC endpoints

The build reads Solana mainnet through an RPC endpoint. Two settings, both optional, set as *Settings → Secrets and
variables → Actions → New repository secret*:

| Secret | Used for | Requirement |
|---|---|---|
| `RPC_URL` | balances and single transactions | any Solana mainnet RPC |
| `SIGNATURES_RPC_URL` | listing each address's transaction history | **must be archive-complete** |

Without them the build uses the public endpoint `https://api.mainnet-beta.solana.com`, which is enough for a daily run.

### Recommended: the Council's own endpoint from ATMTA

The public endpoint is shared, rate-limited and comes without guarantees. An endpoint provided to the Council by
ATMTA, set as both secrets, makes the build independent of public limits. Ask for an archive-complete endpoint (below)
and test it once before switching:

```sh
RPC_URL=https://... SIGNATURES_RPC_URL=https://... npm run build
```

The build should finish without "could not be read" warnings, and the Data health page should show no new critical
entries.

### Why archive-complete matters

While the dashboard was built, one commercial endpoint returned 34 of the Treasury wallet's 277 transactions (a gap
from February 2025 to May 2026), with no error. A ledger built from such a list silently misses payouts. The Data
health page checks for this: every daily balance snapshot is compared with the balance the ledger implies for that
moment, and any difference is a critical entry. The public endpoint returned all 277.

### Transaction format

Transactions are requested with `maxSupportedTransactionVersion: 1`, Solana's newer transaction format (seen on
mainnet from November 2026); an endpoint must accept that setting. A transaction the endpoint cannot return never
stops the build: it is read again on every update and shown on the Data health page ("could not be read") until it is.
If such an entry stays for days, the endpoint is the likely cause.

---

## 6. Configuration

Everything the dashboard needs to know that is not in the sheet lives in `config.json`. It changes rarely, and only
through a commit (which also rebuilds the site). Keys starting with `_` are notes for the reader and are ignored.

| Key | What it holds | When it changes |
|---|---|---|
| `accounts` | the DAO's accounts: `treasury`, `fund` (Ecosystem Fund), `oldTreasury` (before the multisig, retired 2023-05-16), each with its wallet and which token accounts the ledger reads (`indexTokens`) | a new DAO account |
| `councilMultisigs` | the Council's Squads multisig accounts, for the Council's on-chain activity and the wallets' **Multisig** tag | a new or retired multisig |
| `multisigs` | further addresses whose transactions the ledger reads (empty today) | rarely |
| `knownWallets` | fixed names for wallets, e.g. the marketplace fee wallet as "Marketplace fees"; a known sender counts as an income stream from its first transfer | a new income source |
| `income` | `recurringMinTransfers`: transfers from one sender before they are summed per month (20); `craftingTolerance`: the Data health threshold for the monthly SAGE fees (25%) | rarely |
| `mints` | the tokens read (ATLAS, USDC, POLIS) | never |
| `sheet` | `id` of the Council's sheet; `tabs`: each tab by name or number; `testNotice`: a banner for a test copy (remove for the real sheet) | moving to another sheet |
| `editing` | `enabled`, `googleClientId` (section 3), `documents.owner` and `documents.folder` (the documents account and its Drive folder) | a new Google Cloud project or documents account |
| `youtube` | the Council's channel for the meeting recordings | a new channel |
| `governance` | the governance API and the proposals site | if Star Atlas moves them |
| `rpc` | the default RPC endpoints; the repository secrets override them (section 5) | rarely |
| `daoRules` | the rules set by PIPs: `fund` (Ecosystem Fund limit and refills), `foundation` (the Foundation's yearly budget) | a PIP that changes a rule (below) |
| `budget` | the Budget page: averaging window (12 months), which cost categories count as Foundation, how many refills to project | rarely |
| `reconcile` | payouts below these amounts are not listed as needing a label (100 USDC, 10,000 ATLAS) | rarely |

### When a PIP changes a rule

Add a new version to `daoRules.fund` (or `daoRules.foundation`) with `from` set to the day the PIP passed, its `pip`
number and `title`, and every field: copy the previous version and change what the PIP changed. Keep the old versions:
past figures are calculated with the rules of their time, and the Ecosystem Fund page lists every version under
*Rules*.

### A new income source

A sender with only a few transfers is listed under Other income on its own; from 20 transfers on it is summed per month.
For a fixed name or to count it as a stream from the first transfer, add it to `knownWallets`. A sender of thousands of
transfers a day into the Treasury's ATLAS account cannot be read one by one (section 10).

---

## 7. Hosting and domain

The site is served by GitHub Pages from the Council's repository: free, no server, and rebuilt by the workflow. The
RFP has ATMTA hosting it; the suggested way is that ATMTA provides the address and GitHub keeps serving it, so ATMTA
only adds DNS records and nothing runs on ATMTA's servers.

1. **Repository first.** Publish from the Council's own GitHub organization (section 2), so the address points at the
   Council, not at the developer's account.
2. **ATMTA, DNS for `staratlas.com`:** a `CNAME` record `council` → `<org>.github.io` (the Council organization's
   GitHub Pages host).
3. **GitHub, the Council organization:** *Settings → Pages → Add a domain* to verify `council.staratlas.com`. GitHub
   shows a `TXT` record for ATMTA to add. Verification stops anyone else from claiming the subdomain if the site is
   ever unpublished.
4. **GitHub, the repository:** *Settings → Pages → Custom domain* `council.staratlas.com`, then **Enforce HTTPS** once
   the certificate is issued (GitHub issues and renews it; this can take up to an hour). The workflow publishes the
   site, so no `CNAME` file is needed in the repository.
5. **Editor sign-in:** add `https://council.staratlas.com` to the Google client's *Authorized JavaScript origins*
   (section 3), or sign-in fails on the new address.
6. **Check on the new address:** the pages load, live prices appear in the footer, an editor can sign in, and
   **Update now** works. The old `<org>.github.io/<repository>` address forwards to the new one by itself.

The daily build, the sheet sync script and the data are not affected by the address.

---

## 8. Recurring dependencies

Nothing is paid. Every service runs on accounts the DAO owns, and each can be replaced.

| Service | Used for | Cost | Owned by | Upkeep |
|---|---|---|---|---|
| GitHub (repository, Actions, Pages) | code, data history, the daily build, hosting | free for a public repository | the Council's organization | none |
| Google Sheets | the Council's sheet, the data store | free | the DAO's Google account | keep it viewable by link |
| Google Cloud project | editor sign-in, Sheets and Drive access | free | the DAO's Google account, with a second owner | add and remove editors as test users (section 3) |
| Google Drive | payment documents | free (the account's storage) | the documents account | share its folder with members as needed |
| Google Apps Script | the sheet sync script | free | the account that installed it | renew its GitHub token yearly (section 4) |
| Solana RPC endpoint | chain data | free (public endpoint, or one provided by ATMTA) | the provider | none; check after a provider change (section 5) |
| Star Atlas governance API | proposals and votes | free | Star Atlas | none |
| YouTube | meeting recordings (public feed) | free | the Council's channel | none |
| Jupiter price API | live token prices in visitors' browsers | free, no key | Jupiter | none |
| A domain (optional) | e.g. `council.staratlas.com` | ATMTA's existing domain | ATMTA | none |

There are no code packages to update: the build uses Node.js alone, and the site uses no libraries. The workflow uses
GitHub's own actions (`checkout`, `setup-node`, `upload-pages-artifact`, `deploy-pages`), which GitHub maintains.

---

## 9. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| The site does not update | the build failed (red run in *Actions*) | open the run's log; the failing step says why. A failed **Tests** step means a code change broke something: fix it, or revert the last commit. The last good site stays online meanwhile |
| A build fails at **Build** with an RPC error | the RPC endpoint is down or rate-limiting | *Run workflow* again later; if it repeats, switch or remove the RPC secrets (section 5) |
| A build fails at **Commit updated data** | the workflow may not push | workflow permissions: **Read and write** (section 2) |
| Data health: "could not be read" (critical) | the RPC endpoint could not return a transaction | it is retried on every update; if it stays for days, test another endpoint (section 5) |
| Data health: a balance differs from the ledger (critical) | a transaction is missing from the ledger, usually an incomplete signature list | check `SIGNATURES_RPC_URL` is archive-complete (section 5); deleting `data/ledger.json` and `data/cursors.json` rebuilds the ledger from scratch on the next run (a few minutes) |
| Data health: SAGE fees of a month off by more than 25% | an inflow into the Treasury's ATLAS account that the ledger does not read | check that month's Treasury ATLAS transfers on Solscan; add a low-volume sender to the scan (section 6) |
| Sheet edits do not show | the page reads the sheet live, so usually only a reload is needed; a newly created tab needs one build | reload; or **Update now** |
| **Update now** does nothing | the sheet sync script is missing or its GitHub token expired | section 4 |
| An editor cannot sign in | not a test user, no edit access, or the Sheets box not ticked | the sign-in messages in section 3 |
| Sign-in fails on a new address | the address is not an authorized origin | section 3, step 4 |
| Prices missing in the footer | the Jupiter price API did not answer | nothing; USD values show "—" until it answers again |

To look at a problem without waiting for GitHub, build on your own computer (section 2): `npm run build` shows the
same log, and `npm run serve` the result.

---

## 10. Known limitations

- **SAGE fees are a remainder.** The SAGE program pays them in about 20,000 small transfers a day into the Treasury's
  ATLAS account, too many to read one by one. They are therefore the account's balance change minus every recorded
  movement, so any other inflow into that account counts as SAGE fees. A one-off transfer is flagged on Data health
  (a month more than 25% off its neighbours). A second high-volume stream, such as a new SAGE fee, is flagged only in
  the month it starts and then stays inside SAGE fees, because the months around it rise with it. Separating it needs
  its own source, such as a fee account with a running total or an outside index.
- **Treasury ATLAS history.** For the same reason, that account's balance history is one snapshot per build since the
  dashboard's first run (2026-10-09), plus a one-time import of the earlier daily balance. Its payouts are still read
  exactly: the Treasury wallet signs every one.
- **Ledger checks start 2026-10-09.** Data health compares each daily balance snapshot with the ledger, and snapshots
  exist from that day. Earlier history was read in full from the chain, but is not re-checked automatically.
- **Elections.** Ranked Council elections allocate seats by single transferable vote. The dashboard shows first
  preferences per candidate and does not recount the election.
- **Matching needs labels where the chain is ambiguous,** most often when one wallet is paid for several PIPs.
- **USD-denominated PIPs paid in ATLAS.** Remaining is shown only in the authorized currency; a PIP paid in another
  token shows what was paid and relies on its milestones for completion.
- **Sign-in in Testing.** While the Google app stays in *Testing*, at most 100 accounts can be editors, and each must be
  added by hand (section 3).

---

## 11. Handover checklist

1. **Repository:** transfer it to the Council's GitHub organization; workflow permissions **Read and write**; Pages
   source **GitHub Actions** (section 2).
2. **Sheet:** `sheet.id` in `config.json` is the Council's real sheet, `testNotice` removed, the sheet viewable by
   link.
3. **RPC:** the Council's own endpoint from ATMTA as both repository secrets, tested once (section 5), or the public
   endpoint by default.
4. **First run:** *Run workflow*, open the published address.
5. **Google Cloud project:** set up on the DAO's account with a second owner; the new client ID in `config.json`;
   every editor shared on the sheet and added as a test user (section 3).
6. **Documents:** `editing.documents.owner` is the DAO's documents account, and the Drive API is enabled.
7. **Sheet sync script:** installed on the real sheet from a DAO account, with a new token owned by the Council's
   organization and the repository's new name in `GITHUB_REPO`; any earlier copy removed and its token revoked
   (section 4).
8. **Domain:** if a Star Atlas address is used, section 7.
9. **On the dashboard, once, by an editor:** **Create the milestone lists** (top of the Payments page); enter the
   Council's multisig vaults in the Wallets tab with balance tracking on.
10. **In the sheet, once:** add "Completed" to the PIP Phase dropdown (the dashboard cannot change dropdowns).
11. **Walkthrough:** go through MANUAL_COUNCIL.md with the editors.

---

## 12. Reference: how the figures are calculated

### Payout matching

Every payout from a DAO account is matched to a PIP or a cost category, with a confidence level:

| Confidence | Meaning | Counts as paid |
|---|---|---|
| confirmed | a Council label says so | yes |
| matches sheet | the payout, or all payouts to one recipient, equal the PIP's "paid" figure in the sheet | yes |
| matches amount | the payout equals the PIP's authorized amount (PIPs sharing an amount in one transaction get one each) | yes |
| inferred | same recipient as a payout already matched to exactly one PIP | no, shown as a suggestion |
| internal | a transfer between DAO accounts, e.g. a Fund refill | n/a |
| needs label | nothing matched | no |

A wallet's payout label (Wallets tab) labels every payout to it, using the purpose in force at each payout's date. A
Council label on a single payout always wins. Inflows from a known PIP recipient count as returns: paid stays the gross
amount sent, and the return is shown separately.

### The Ecosystem Fund rules

From `daoRules.fund`, one version per PIP, each in force from the day its PIP passed:

- **PIP limit** (PIP-23, since 2025-11-18): no single PIP may exceed 5% of the fund's ATLAS balance right after its
  latest refill, until the next refill. Before that (PIP-4): 5% of the fund's initial funding. The fund's complete
  history is in the ledger, so the balance after every refill is exact.
- **Refills:** quarterly, the Treasury tops the fund up to 20% of the ATLAS in Treasury and fund together, plus 20% of
  the Treasury's USDC above 500,000.

### Income

- **Marketplace fees:** the Galactic Marketplace's fee wallet forwards 33% of its fees, ATLAS and USDC, to the Treasury
  every few days. These transfers are in the ledger and counted exactly.
- **SAGE fees:** the SAGE program pays a small ATLAS fee into the Treasury for every crafting job, in the transaction
  that claims the job's output. They are derived per month as a remainder (section 10). Before 2024-04-03 the account
  was quiet enough to be read in full, so SAGE fees start in April 2024 and earlier inflows are listed one by one.
- **Other income:** any other inflow, listed individually, or by its income label.

### The Budget page (being built)

Averages over the last 12 complete months. Income is SAGE fees plus income transfers; running costs are Treasury
payouts with a cost category plus those not labelled yet; PIP payouts are shown but not projected. The Foundation
budget (PIP-2) compares payouts and upcoming payments labelled Foundation per fiscal year with the yearly cap of
100,000 USD. The projection runs Treasury and Fund forward to the next refill dates.

### The data folder

`data/` is the build's memory, committed by every run: `ledger.json` (every token movement of the DAO accounts) and
`cursors.json` (where each address was last read), `balances.json` (daily snapshots since 2026-10-09),
`balance_history_import.json` (the earlier Treasury ATLAS history, imported once), `wallet_kinds.json` (the multisig
check), `multisig_activity.json` (the Council's multisig transactions), `votes/` (closed proposals' votes) and
`sheet/` (every tab of the sheet as CSV, so its history survives even without Google; values only, no formulas or
formatting). Deleting `ledger.json` and `cursors.json` makes the next run read the full history again.

---

## 13. Reference: the sheet's tabs

The dashboard finds tabs by name and columns by their header text, so column order does not matter. It creates every
tab and column it needs the first time a save needs it; editors normally never type into these tabs.

| Tab | One row per | Columns |
|---|---|---|
| Tracker | PIP (or drafted PIP) | the Council's own columns, plus `Draft ID`, `Authorized USDC`, `Authorized ATLAS` (added when used) |
| Payment labels | labelled payout | Signature, Recipient, PIP (a PIP, a cost category, `internal`, `refund`, `not a payout`), Confirmed, Fiscal year |
| Wallets | wallet and purpose | Wallet, Name, Payout label, Track balance, Note, Since (a PIP or a date, for a reused wallet's later purposes) |
| PIP milestones | milestone | ID, PIP, #, Milestone, Amount, Currency, Paid by (tx), Completed on, Completed by |
| Checklists | checklist item | ID, PIP, Checklist, Milestone, Item, Done on, Done by, Evidence |
| Upcoming payments | known payment | ID, Due, Paid from, For, Fiscal year, Amount, Currency, Description, Paid by (tx), Repeats, Until |
| Council members | member and term | Name, Role, Term, Start, End, Elected (PIP), Wallet, Discord, X, Image, Show |
| Meeting minutes | meeting day | Date, Title, Minutes (Discord formatting), Show |
| Payment documents | uploaded file | Signature, Recipient, File, Link, Uploaded (UTC), By |
| Dashboard | (one row) | the time of the last **Update now**, and who pressed it |
| Accomplishment Numbers | (the Council's own) | read as history only |

**Authorized USDC / Authorized ATLAS** are for a PIP paid in both currencies (e.g. PIP-33: 75% USDC, 25% ATLAS), as
token amounts. When either is filled, that PIP's paid and remaining amounts are worked out per currency instead of from
the single Amount. Where the ATLAS part is fixed in dollars and converted on payment day, enter the ATLAS actually paid
per tranche once it is known. **Image** in Council members must be an `https://` link.

**Before the Council members tab exists,** the Council page comes from `data/council_history.json`, a record of past
terms in which every term cites its source (the official API result, the DAO Knowledge Base, or who provided it).
Elections after the record are added automatically, but only when the result is certain: the governance API
published it, or there were no more candidates than seats. A contested election without a published result shows as
"result not published", never guessed. Once the tab exists (**Create the Council members tab**), the tab is the
source.

IDs are set by the dashboard and must not be changed or reused by hand. `Show = FALSE` hides a member or minutes
without deleting them. Dates written by the dashboard are text (`'2026-11-07`), so the sheet's locale can never turn
them into an ambiguous date.
