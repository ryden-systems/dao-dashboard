# Star Atlas DAO Dashboard: maintainer manual

For whoever installs and looks after the dashboard: the GitHub repository, the Google Cloud project, the sheet's
sync script and the Solana RPC endpoint. No programming is needed for any of it. How the Council uses the dashboard
day to day is in [MANUAL_COUNCIL.md](MANUAL_COUNCIL.md), which signed-in editors also see on the dashboard's Help page.

1. [Overview](#1-overview)
2. [Installation](#2-installation)
3. [Google Cloud project: editor sign-in](#3-google-cloud-project-editor-sign-in)
4. [Sheet sync script: instant updates](#4-sheet-sync-script-instant-updates)
5. [RPC endpoints](#5-rpc-endpoints)
6. Configuration (to be written)
7. Hosting and domain (to be written)
8. Recurring dependencies (to be written)
9. Troubleshooting (to be written)
10. Known limitations (to be written)
11. Handover checklist (to be written)

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
