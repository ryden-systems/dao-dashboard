# Star Atlas DAO Dashboard

A public dashboard for Star Atlas DAO governance, PIP funding, the Ecosystem Fund limit, and the DAO treasury.
It is a static website rebuilt by GitHub Actions. There is no server and no database, and visitors never need to log in.
Council editors can optionally sign in with Google to edit the sheet from the dashboard.

---

## For the Council maintainer

**You maintain one thing: the Council's PIP tracker sheet.** Everything else updates itself. You can always edit the
sheet directly. With two-way editing switched on, some of it can also be edited from the dashboard, and those saves
go straight into the same sheet.

| What | Where it comes from | Who maintains it | Edit from the dashboard? |
|---|---|---|---|
| Completed and total milestones, DAO ROI, notes | The PIP tracker sheet | You | Yes |
| PIP names, amounts, currency, category, SAC term, phase | The PIP tracker sheet | You | No, sheet only |
| Council activity per month | The sheet's "Goes into Dashboard" tab | You | No, sheet only |
| Council activity on chain per month | Transactions on the Council's Squads multisigs (`councilMultisigs` in config.json) | Nobody | Yes, every build |
| Council meetings (recordings) | The Council's YouTube channel (public feed, `youtube` in config.json) | You (by posting the recording) | Yes, every build |
| Meeting minutes | The sheet's "Meeting minutes" tab (see below) | You, on the dashboard or in the sheet | Yes, live |
| Current and incoming Council members | A "Council members" tab in the sheet | You | Create the tab and add members; changing or hiding a member is sheet only |
| Other wallets: names, automatic payout labels, tracked balances (optional tab) | A "Wallets" tab in the sheet | You | Yes, see *Wallets* |
| Labels for payouts the dashboard could not match (optional tab) | A "Payment labels" tab in the sheet | You | Yes, see *Payment labels* |
| Documents on payouts, e.g. invoices (optional tab) | A "Payment documents" tab in the sheet, files in the owner account's Google Drive | You | Upload by the owner account only, see *Payment documents* |
| Vote results, voting power, participation | Star Atlas governance API | Automatic | n/a |
| Treasury and Ecosystem Fund balances | Solana mainnet | Automatic | n/a |
| Payments to PIPs and running costs (e.g. the Foundation), returns, fee income | Solana mainnet; the purpose of a non-PIP payout comes from a payment label | Automatic | n/a |
| The 5% Ecosystem Fund limit | Solana mainnet (fund balance each quarter) | Automatic | n/a |

**Fixing problems.** Sign in as an editor and open the **Data health** page. Maintenance items (the Data health page
and tile, "Payouts to label") are shown to signed-in editors only, tinted blue so editors can tell them apart; with
editing switched off they are public. Every entry says what is wrong and where. Sheet issues are fixed in the sheet;
the entry disappears on the next build once the sheet is corrected.

**When does the site update?** Once a day (scheduled for 03:17 UTC, though GitHub can start it hours later), and within about five minutes of a change to the sheet if
*Instant updates* (below) is installed. Anyone with access to the GitHub repository can also trigger an update now:
*Actions* tab → *Build and publish dashboard* → *Run workflow*.

**The sheet must stay viewable by anyone with the link.** The dashboard reads it through Google's public CSV export.

**PIPs paid in both USDC and ATLAS** (e.g. PIP-33: 75% USDC, 25% ATLAS) get two optional columns in the PIP tab,
**Authorized USDC** and **Authorized ATLAS**, as token amounts. When either is filled, that PIP's paid and remaining
amounts are worked out per currency instead of from the single Amount. Where the ATLAS part is fixed in dollars and
converted on payment day, enter the ATLAS actually paid per tranche once it is known, and add each later tranche.

### Council members (optional, recommended)

The Council page shows the current Council, any incoming Council, and every past Council.
To manage those lists, add a tab named **Council members** to the sheet, one row per member per term, with these
column headers (only **Name** is required; any order):

| Name | Role | Term | Start | End | Elected (PIP) | Wallet | Discord | X | Image | Show |
|---|---|---|---|---|---|---|---|---|---|---|
| ROME \| Earther | Council member | Term 4 | 10/11/2026 | 7/11/2027 | PIP-35 | | | handle | https://… | TRUE |

- Rows with the same **Term** form one Council (`4` and `Term 4` count as the same). **Start / End** decide whether it shows as current, incoming, or past
  (this is checked in the visitor's browser, so the page moves on by itself on those dates).
- **Image** must be an `https://` link (e.g. the candidate portrait on cdn.staratlas.com).
- **Show = FALSE** hides a row without deleting it.

The tab is found by its name automatically. With two-way editing switched on, an editor can create it from the
dashboard in one click, pre-filled with the full Council history, and add members there. Changing or hiding an
existing member is done in the sheet.

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
| the transaction signature (copy it from the dashboard's payment list) | optional: the recipient wallet, if one transaction paid several people | e.g. `PIP-28`, a cost category such as `Foundation`, or `internal`, `refund`, `not a payout` | `TRUE` once checked |

The tab is found by its name ("Payment labels") automatically. With two-way editing switched on, editors can label a
payout straight from the dashboard instead (a **Label** button next to every payout except transfers between the DAO's
own accounts); the tab is created on the first label. A payout that already has a label shows **Relabel**, with its
current label preselected, and saving again updates the same row. A label overrides the automatic match.

Labels with **Confirmed = TRUE** count as paid. Unconfirmed labels show as suggestions only.

**Running costs.** A label that is not a PIP (and not `internal`, `refund` or `not a payout`) is a cost category,
for example `Foundation` for the payments that keep the DAO's legal entity in good standing. The Payments page totals
every category under *By purpose*. Once one payout to a wallet is labelled, further payouts to that wallet are
suggested for the same category and only need confirming.

### Wallets (optional)

Other wallets the DAO deals with, such as the Foundation's, can be listed in a "Wallets" tab:

| Wallet | Name | Payout label | Track balance | Note |
|---|---|---|---|---|
| the Solana address | who owns the wallet, shown instead of the address everywhere; several wallets of one owner can share a name | optional: every payout to this wallet gets this label, e.g. `Foundation` or `PIP-36`; inflows from the wallet are not labelled by it | `TRUE` to show its ATLAS, USDC and SOL balances on the Balances page | optional |

Tabs created before November 2026 call the Payout label column "Label"; both are read. A label on a single
payout or inflow (see *Payment labels*) overrides the wallet's label. An inflow is labelled on its own, e.g.
`Initial funding`; it then appears under that name in Other income on Balances. Signed-in editors can add and change
wallets on the Balances page (**Add a wallet**, **Edit**); the tab is created on the first save.

### Payment documents (optional)

Invoices, receipts and other PDF files can be attached to any payout, several per payout. Signed-in editors see a
**Documents** button on every payout in the Payments page's movement list, with the files attached so far.

- **Who uploads.** Only the account named in `config.json` (`editing.documents.owner`) can upload. Everyone else
  sees the upload button disabled, with that account's name next to it. This keeps every file owned by the DAO's own
  account instead of by whichever member happened to upload it.
- **Where the files go.** Into a folder named "Payment documents" in that account's Google Drive, created on the first
  upload. On that first upload Google asks the owner once for permission to create files; the dashboard can only see
  the files it created itself, never the rest of the Drive.
- **Who can open them.** The files stay private to the owner account. To let other members open them, share the
  "Payment documents" folder with them in Google Drive. Never share it as "anyone with the link": invoices contain
  bank details.
- **What the sheet holds.** One row per file in a "Payment documents" tab: the payout's signature, the file name, its
  Drive link, when and by whom. The tab is created on the first upload. The sheet can be opened by anyone with its link
  and every tab is backed up into this repository, so the file names and links are public; the files themselves are not.
  The public site itself never lists documents.

### Meeting minutes (optional)

Minutes are written or pasted on the Council page (**Add minutes**, or **Add / Edit minutes** in a meeting's row) and
saved in a "Meeting minutes" tab, created on the first save:

| Date | Title | Minutes | Show |
|---|---|---|---|
| the meeting's day, YYYY-MM-DD | only needed for a meeting without a recording | the text, in Discord markdown | FALSE hides the row |

- **Format.** The text uses Discord's markdown (bold, italic, underline, strikethrough, headings, lists, quotes, code,
  links, spoilers), so it looks the same on Discord and on the dashboard. The form has a formatting toolbar, a preview,
  and **Copy for Discord**. A Discord post holds 2,000 characters; the form says when the minutes are longer. To bring a
  Discord post over, copy it from *Edit message* (plain copying drops the formatting).
- **Where they show.** Minutes attach to the recording of the same day (a grey **See minutes** link in its row).
  Minutes for a day without a recording are listed as a meeting of their own, marked "no recording". A PIP named in
  the minutes (PIP-36) lists the meeting on that proposal's page.
- **Public.** The tab, like every tab, can be read by anyone with the sheet's link and is backed up into this repository.

---

## Two-way editing (included, switchable)

Signed-in editors can change some human-maintained fields on the dashboard itself: payout labels, a PIP's milestones,
DAO ROI and note, meeting minutes, and adding Council members. Everything else is edited in the sheet (see the table under *For the
Council maintainer*). Every save goes straight into the Council's sheet; the dashboard never keeps
its own copy. It is off until it is configured, and the dashboard works the same without it.

- **Who can edit** is decided by the sheet's own sharing settings. Editors sign in with Google; a save succeeds only
  if their Google account can edit the sheet. The sheet's version history records every change and who made it.
- **Permission.** Editors grant Google's spreadsheet permission in the sign-in popup. Google words this as access to
  all of the account's spreadsheets; the dashboard only ever addresses the sheet in its configuration, and the sign-in is kept
  only in the open page and lasts about an hour. It works with several Google accounts signed in to the browser.
- **Conflicts.** Before saving, the dashboard re-reads the cells. If someone changed one in the sheet since the form
  was opened, it shows both values and lets the editor overwrite or take the sheet's value.
- **Update now.** Signed-in editors have an **Update now** button. It writes the time into a small "Dashboard" tab
  (created on first use), which makes *Instant updates* rebuild the site within about five minutes, e.g. after a
  failed nightly build. It needs *Instant updates* installed; no GitHub login is involved.
- **Visibility.** Saves are in the sheet immediately and appear for everyone after the next update: about five minutes
  with *Instant updates* below, otherwise the next daily build or *Run workflow*.

### Setup (once, on a DAO-owned Google account)

1. [Google Cloud console](https://console.cloud.google.com/) → create a project.
2. *APIs & Services → Library*: enable **Google Sheets API**, and **Google Drive API** if payment documents are used.
3. *Google Auth Platform*: audience **External**; under *Data access* add `.../auth/spreadsheets`, `openid`, `email` (and `.../auth/drive.file` if payment documents are used).
   The spreadsheet permission is classed as sensitive: while the app is in *Testing*, add each editor as a test user
   (they see an "unverified app" notice and continue). Opening it to anyone else requires Google's app verification.
4. *Clients → Create client*: type **Web application**; under *Authorized JavaScript origins* add the dashboard's
   address (e.g. `https://council.staratlas.com`, or `https://<org>.github.io`). The client secret is not used.
5. In `config.json`, set `editing.enabled` to `true` and fill in `googleClientId`. It is public by design.

All of this is free. Google may change console wording; the steps above describe it as of October 2026.

## Live sheet

The page reads the Council's sheet itself, straight from Google, every time it opens (and again after an editor saves,
when the tab comes back into view, and every few minutes). It then redoes the build's calculation in the browser with
the same code, so a change in the sheet (a label, a wallet name, a milestone, a Council member) shows on the next page
load, without waiting for a build. The header shows when the sheet was last read ("sheet live HH:MM UTC").

What still needs a build (daily, or *Update now*): new on-chain transactions and balances, a newly tracked wallet's
balance, and a tab that did not exist at the last build (e.g. the first "Wallets" row creates that tab). If Google
cannot be reached, the page shows the data of the last build. `test/live.test.mjs` checks that the browser's
calculation gives exactly what the build publishes.

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
| **Data health** | Everything the build found that disagrees or is missing (signed-in editors only) |

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
4. Custom domain, e.g. `council.staratlas.com` (see *Hosting on a Star Atlas domain* below).
5. *Actions → Build and publish dashboard → Run workflow* once, and open the published URL.
6. In `config.json`, make sure `sheet.id` is the Council's real sheet and remove `testNotice` if it is there.
7. If two-way editing stays on: repeat its *Setup* on a DAO-owned Google account and put the new client ID in `config.json`.
8. If instant updates stay on: install the script on the real sheet from a DAO account, with a new token owned by the
   DAO's organization and the repository's new name in `GITHUB_REPO`. Remove any earlier copy of the script and revoke its token.

### Hosting on a Star Atlas domain

The RFP has ATMTA hosting the site. The suggested way: GitHub Pages keeps serving and rebuilding it (free, no
server), and ATMTA provides the address. ATMTA only adds DNS records; nothing runs on ATMTA's servers.

1. **Repository first.** The site should be published from the Council's own GitHub organization (step 1 above), so
   the domain points at the Council, not at the developer's account.
2. **ATMTA, DNS for `staratlas.com`:** a `CNAME` record `council` → `<org>.github.io` (the Council organization's
   GitHub Pages host).
3. **GitHub, the Council organization:** *Settings → Pages → Add a domain* to verify `council.staratlas.com`; GitHub
   shows a `TXT` record for ATMTA to add. Verification stops anyone else from claiming the subdomain if the site is
   ever unpublished.
4. **GitHub, this repository:** *Settings → Pages → Custom domain* `council.staratlas.com`, then **Enforce HTTPS** once
   the certificate is issued (GitHub issues and renews it; this can take up to an hour). The site is published by a
   GitHub Actions workflow, so no `CNAME` file is needed in the repository.
5. **Editor sign-in:** in the Google Cloud project, add `https://council.staratlas.com` to the client's *Authorized
   JavaScript origins* (see *Setup*), or sign-in fails on the new address.
6. **Check on the new address:** the pages load, live prices appear in the footer, an editor can sign in and
   *Update now* works. The old `<org>.github.io/<repo>` address redirects to the custom domain by itself.

The daily build, the sheet sync script and the data are not affected by the address.

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
test/editor_preview.test.mjs  the sign-in explanation shown when a preview build has editing off
test/backup.test.mjs     the raw CSV backup of the sheet
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

### Income: marketplace fees and crafting fees

The Treasury earns ATLAS in two ways:

- **Marketplace fees.** The Galactic Marketplace collects its fee share in a fee wallet (`feesQYAa…`), which forwards
  it every few days, ATLAS and USDC, 33% to the DAO Treasury. These transfers are in the ledger and counted exactly.
- **Crafting fees.** Every SAGE crafting transaction pays a small ATLAS fee straight into the Treasury's ATLAS account,
  thousands of times a day since April 2024. That account is too busy to scan, so the build derives the fees per
  month: the change of the month-end ATLAS balance minus every movement the ledger recorded that month.

Before 2024-04-03 the same account had about one transaction a day, so that part of its history is scanned once in
full (`indexTokensBefore` in `config.json`). Crafting fees therefore start in April 2024, and every earlier inflow
(the initial funding and other one-off transfers) is recorded exactly and listed under **Other income** on Balances.

Because crafting fees are a remainder, a transfer the ledger missed lands in them. Data health flags any complete month
whose crafting fees differ from the average of the months on either side by more than `income.craftingTolerance`
(25%). If one is flagged, check the Treasury's ATLAS transfers that month on Solscan.

`data/balance_history_import.json` is a one-time import of the Treasury's daily ATLAS balance from 2023-05-16 until
the dashboard's own snapshots began (2026-10-09); its `_source` field says where it came from. The build never
changes it.

A local build with a `config.local.json` writes all of this to `data.local/` instead (git-ignored), starting from
the committed `data/` for anything it has not fetched yet. Local test data therefore never reaches the repository,
and a commit never changes what the local page shows.

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
