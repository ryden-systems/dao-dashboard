# Star Atlas DAO Dashboard: Council manual

How the Council keeps the dashboard up to date. Everything here is done on the dashboard after signing in; the
Council's sheet stores it. Buttons are written in bold, exactly as they appear on the dashboard.

1. [Signing in](#1-signing-in)
2. [Where the figures come from](#2-where-the-figures-come-from)
3. [Payments: labels and documents](#3-payments-labels-and-documents)
4. [PIPs](#4-pips)
5. [Milestones and checklists](#5-milestones-and-checklists)
6. [Upcoming and recurring payments](#6-upcoming-and-recurring-payments)
7. [Wallets](#7-wallets)
8. [Council members and meeting minutes](#8-council-members-and-meeting-minutes)
9. [Data health](#9-data-health)
10. [The sheet](#10-the-sheet)

---

## 1. Signing in

**Editor sign-in** is at the top right. Sign in with the Google account the Council's sheet is shared with for
editing; the maintainer adds new editors (both the sheet sharing and Google's list of allowed accounts).

- The first time, Google shows an "unverified app" notice: continue. Then tick the box that allows access to Google
  Sheets, or the dashboard cannot save.
- While signed in, the header shows "Editing as" and your address, **Update now** and **Sign out**. Editing controls
  appear on the pages, and items only editors see are tinted blue.
- Every save goes straight into the Council's sheet under your own Google account, and the sheet's version history
  records it.
- If someone changed the same value in the sheet since you opened a form, the dashboard shows both values instead of
  overwriting: **Overwrite with mine** or **Use the sheet's values**.
- Your changes show for everyone on their next page load: the page reads the sheet live. New transactions and
  balances need an update: **Update now** refreshes the whole site within about five minutes; otherwise it updates
  once a day.

---

## 2. Where the figures come from

| Figure | Source | Your part |
|---|---|---|
| Amounts paid, received, returned; balances | Solana, read on every update | none; label what the dashboard cannot match (section 3) |
| Votes, results, voting power, participation | the Star Atlas governance API | none |
| PIP details: name, amount, currency, phase, category, Council term | the Tracker tab of the sheet | keep them current (section 4) |
| Milestones, checklists, upcoming payments, wallets, members, minutes | the sheet | add and update them here |
| The Ecosystem Fund limit and refills | Solana and the rules set by the PIPs | none |

> [!NOTE]
> Figures from the chain or the governance API are calculated, never typed in, so they cannot be edited. If one looks
> wrong, the cause is usually a missing label or a sheet value that disagrees with the chain: the Data health page
> lists both (section 9).

---

## 3. Payments: labels and documents

### Labelling a payout

The dashboard matches most payouts to a PIP by itself: by the sheet's paid figure, by the PIP's authorized amount, or
by an earlier payout to the same wallet. What it cannot match is shown as "needs a label", and the Payments page counts
these under "Payouts to label".

Every payout has **Label** (or **Relabel**, once labelled) in its row on the Transactions and Payments pages and on
the proposal pages, except transfers between the DAO's own accounts. In the form:

- Paid for: a PIP, a cost category such as Foundation, "Not known yet", internal (between DAO accounts), refund, or
  not a payout.
- Or a new cost category: type one, e.g. Hosting.
- Fiscal year: only when the payout belongs to another year than it was paid in, e.g. a January payment for last
  year's costs.
- Confirmed: only a confirmed label counts the payout as paid.

**Save label** stores it; **Remove label** takes it off again, and the payout is matched automatically again.
Money received can be labelled the same way, e.g. as Initial funding, or as a PIP whose money came back.

A cost category (anything that is not a PIP) appears on the Payments page under "By purpose". Use Foundation only for
the Foundation's own costs; give other running costs their own category.

### Documents

**Documents** on a payout lists its invoices and receipts. Only the Council's documents account can upload (**Upload**,
PDF files, several at once) and **Remove** them; everyone else sees the list. The files go into a folder in that
account's Google Drive and stay private: the public site never lists them.

> [!WARNING]
> Never put any private details or names into the sheet itself: anyone with its link can read it.

---

## 4. PIPs

### Adding a PIP

On the Proposals page, signed in: **Add PIP**, below the list. A PIP can be added while it is still drafted: leave the
PIP number empty. Fill in what is known (name, phase, status, draft date, step, amount, currency, the Council term)
and press **Add to the Tracker**. A PIP without a number appears under "Not numbered yet", visible to editors only.

### Editing a PIP

**Edit PIP** is on each proposal's page and in each funded PIP's row on the Payments page. It covers the process
fields (phase, status, draft date, step, PDF sent, Markdown sent), the funding fields (amount, currency, authorized
USDC and ATLAS for a PIP paid in both, Ecosystem Fund, category, Council term) and the results (DAO ROI, note).
Press **Save to sheet**.

- A numbered PIP's name and number are not edited here: the name comes from the governance API.
- When a drafted PIP goes to vote, open it under "Not numbered yet", enter its PIP number and save. From then on it is
  listed with the proposals, with its votes from the governance API.
- The milestone counts are not in this form: they follow the PIP's milestone list (section 5).

### Filters

**Filter** at the top right of the Proposals and Funded PIPs tables opens a search field and selects (result, status;
for editors also the PIP phase). Closing it clears the filters.

---

## 5. Milestones and checklists

Each PIP can have named payment milestones, and checklists such as the KPIs a milestone must meet before it is paid.
They are managed on the proposal's page and in the PIP's row on the Payments page.

### Milestones

**Add milestone**: number, name, amount and currency (optional). A milestone has two separate steps:

1. **Complete**: the Council signs the milestone off (the work is delivered). The date and your account are saved;
   **Reopen** takes it back.
2. **Mark paid**: link the payout that paid it (pick it from the list or paste its transaction) with **Link payout**.
   That payout then counts as this PIP's. **Remove link** undoes it.

Either step without the other is listed on the Data health page: completed but not paid is a reminder to pay (or to
link the payout that already paid it), paid but not completed is a reminder to sign it off.

> [!NOTE]
> Every milestone change also updates the Tracker's "Completed Milestones" and "Total Payment Milestones" columns;
> they are no longer typed in.

> [!IMPORTANT]
> One-time setup: **Create the milestone lists** at the top of the Payments page, or
> **Create the list from the Tracker** on a single PIP, turns the Tracker's old milestone counts into milestones
> named "Milestone 1", "Milestone 2" and so on, the completed ones marked completed per the Tracker and none paid.
> Rename them with **Edit**, and link their payouts with **Mark paid**.

### Checklists

**Add checklist item**: the checklist's name (e.g. KPIs, Deliverables), the milestone it is a condition for (or none),
the item, and a link as evidence (optional). **Tick** saves the date and your account; **Untick** clears both.

A checklist tied to a milestone shows on it, e.g. "KPIs 2/3". Completing or paying a milestone while its checklist
still has open items is a warning on the Data health page.

---

## 6. Upcoming and recurring payments

Payments the DAO knows are coming, such as an invoice that is due, are listed on the Payments and Budget pages, for
signed-in editors only.
**Add upcoming payment**: due date, which account pays it, what it is for (a cost category or a PIP), the fiscal year,
amount, currency and a short description.

- **Repeats** (monthly, quarterly, yearly) with an end date (**Until**) makes it recurring: each payment made moves its
  next due date on by one period.
- **Mark paid** links it to its payout; the payout then carries its category and fiscal year. A one-off payment leaves
  the list.
- **Documents** attaches the invoice, as on payouts.
- **Edit** and **Delete** in its row.

---

## 7. Wallets

Other wallets the DAO deals with (the Foundation's, a PIP's multisig) are listed on the Balances page under "Other
wallets". **Add a wallet**: its address, a name (shown instead of the address everywhere), a payout label (every payout
to it gets this label, e.g. Foundation or PIP-36) and whether to track its balance.

- **Edit** changes the wallet's current entry; **Delete** removes it.
- **Reuse**: when a multisig gets a new purpose, add the new purpose instead of overwriting the old one. Enter the PIP
  it serves now in **Since** (e.g. PIP-36; the new purpose starts when that PIP's vote ended) or a date. Earlier
  payouts keep the earlier purpose. Deleting one purpose keeps the others.
- Wallets that pay out through a Squads multisig are tagged **Multisig** automatically.
- Untracked wallets are listed for editors only.

---

## 8. Council members and meeting minutes

### Council members

On the Council page, "Edit the Council list":

- **Create the Council members tab**, once: it fills the tab with the full Council history.
- **Add a member**: name, role, term, start and end, the PIP that elected them, X handle, Discord, image link.
- **Edit existing members** lists every entry, hidden ones too, with **Edit** and **Delete**. To hide an entry
  without deleting it, untick **Shown on the site**.

> [!NOTE]
> The start and end dates decide whether a Council shows as current, incoming or past.

### Meeting minutes

**Add minutes**, or **Edit minutes** in a meeting's row: the meeting's date, a title (only for a meeting without
a recording) and the text. The text uses Discord's formatting, with a toolbar, a preview, and **Copy for Discord**. To
bring a Discord post over, copy it from Discord's "Edit message" so the formatting comes along. **Save minutes**
stores them; **Delete minutes** removes them (a recording of that day stays listed).

Minutes show with the recording of the same day; a PIP named in them (e.g. PIP-36) lists the meeting on its page.
**Share** copies a link that opens that meeting.

---

## 9. Data health

The Data health page (editors only) lists everything the dashboard found that is wrong or missing, most serious first:

- critical: a figure on the dashboard is probably wrong, e.g. a transaction that could not be read, or a balance
  that disagrees with the transactions.
- warning: the sheet and the chain disagree, or something is missing, e.g. a payout that needs a label, a sheet "paid"
  figure that differs from what was paid on chain, a milestone paid with open checklist items.
- info: worth a look, e.g. a milestone completed but not paid yet.

Each entry says what is wrong and where. Fix it where it says (usually a label or a sheet value), and the entry
disappears on the next page load or update.

> [!NOTE]
> Entries about the chain itself (critical, "ledger") are for the maintainer.

---

## 10. The sheet

The sheet is where the dashboard keeps everything; editing on the dashboard is the normal way. Some things to know:

- The dashboard adds tabs and columns by itself the first time a save needs them. Do not rename tabs or column
  headers.
- Tabs that hold IDs (PIP milestones, Checklists, Upcoming payments, the Tracker's Draft ID) need them: do not change
  or reuse an ID by hand.
- Every update saves a copy of every tab into the dashboard's repository, so earlier versions stay available.

> [!WARNING]
> The sheet must stay viewable by anyone with its link: the dashboard reads it that way. So never enter any private
> information in it.

> [!NOTE]
> The Budget page is still being built; its section will follow.
