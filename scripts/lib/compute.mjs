// The dashboard's calculation: sheet + governance + ledger in, everything the page shows out.
// Pure (no file or network access), so it runs in the build and, with the sheet read live, in the
// browser: an edit in the sheet then shows on the next page load without waiting for a build.
import { reconcile } from "./reconcile.mjs";
import { fundLimits } from "./limit.mjs";
import { healthChecks } from "./health.mjs";
import { councilTerms } from "./members.mjs";
import { rebuildSeries, fullyIndexed } from "./series.mjs";

const round2 = (n) => Math.round(n * 100) / 100;

// votesOf(pip) returns a proposal's per-voter file or null (the browser passes null: it keeps the
// built largest-voters table, which does not depend on the sheet's editable tabs).
export function compute({ config, sources, proposals, ledger, history, now, nowAt, tracked = {}, seedLabels = [], councilHistory = { terms: [] }, imported = {}, votesOf = () => null, editingPreview = false, generatedAt = new Date().toISOString() }) {
  const nowTs = Date.parse(nowAt) / 1000;

  // Sheet labels override seed labels for the same payout.
  const labels = [...seedLabels.filter((s) => !sources.labels.some((l) => l.signature === s.signature)), ...sources.labels];
  const recon = reconcile({ pips: sources.pips, ledger, labels, wallets: sources.wallets ?? [], config });
  const limit = fundLimits({ ledger, fundNow: now.fund.ATLAS, percent: config.fundLimit.percent, nowTs });
  const flags = healthChecks({ pips: sources.pips, missingColumns: sources.missingColumns, proposals, recon, ledger, history, now, config, nowTs });
  // A payout labelled in more than one row: the last row is used, which is easy to miss in the sheet.
  const labelCount = new Map();
  for (const l of sources.labels) labelCount.set(`${l.signature}:${l.recipient}`, (labelCount.get(`${l.signature}:${l.recipient}`) ?? 0) + 1);
  for (const [k, n] of labelCount) {
    if (n > 1) flags.push({ severity: "warning", area: "payments", message: `Payment labels: payout ${k.slice(0, 8)}… is labelled in ${n} rows; the last one is used. Delete the others, or relabel it from the dashboard (that removes them).` });
  }
  const council = councilTerms({ sheetMembers: sources.members ?? [], proposals, history: councilHistory });
  for (const w of council.warnings) flags.push({ severity: "warning", area: "council", message: w });
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  flags.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || (a.pip ?? 0) - (b.pip ?? 0));

  // Balance history: exact series where the ledger is complete, daily snapshots elsewhere. Where
  // snapshots started late, a one-time import of earlier daily balances (balance_history_import.json)
  // fills the time before the first snapshot.
  const series = {};
  for (const account of Object.keys(config.accounts)) {
    for (const symbol of ["ATLAS", "USDC"]) {
      const key = `${account}${symbol}`;
      if (fullyIndexed(config, account, symbol)) {
        series[key] = { source: "ledger", points: rebuildSeries(ledger, now[account][symbol], account, symbol, nowTs) };
        continue;
      }
      const snaps = Object.entries(history.days).sort().map(([d, s]) => [d, s[account]?.[symbol] ?? null]).filter(([, v]) => v != null);
      const before = (imported[account]?.[symbol] ?? []).filter(([d]) => !snaps.length || d < snaps[0][0]);
      series[key] = { source: before.length ? "import+snapshots" : "snapshots", snapshotsFrom: snaps[0]?.[0] ?? null, points: [...before, ...snaps] };
    }
  }

  // One record per PIP: sheet + governance API + payment summary.
  const api = new Map(proposals.map((p) => [p.pip, p]));
  const pay = new Map(recon.summary.map((s) => [s.pip, s]));
  const pipNums = [...new Set([...sources.pips.map((p) => p.pip), ...proposals.map((p) => p.pip)])].sort((a, b) => a - b);
  const pips = pipNums.map((n) => {
    const s = sources.pips.find((p) => p.pip === n);
    const a = api.get(n);
    return {
      pip: n,
      name: s?.name || a?.title,
      title: a?.title ?? s?.name,
      id: a?.id ?? null,
      url: a ? `${config.governance.site}${a.id}` : null,
      categories: a?.categories ?? [],
      category: s?.category ?? null,
      sacTerm: s?.sacTerm ?? null,
      phase: s?.phase ?? null,
      outcome: a?.outcome ?? (s?.voteResult || "").toLowerCase(),
      votingStartsAt: a?.votingStartsAt ?? null,
      votingEndsAt: a?.votingEndsAt ?? null,
      options: a?.options ?? [],
      totalVotes: a?.totalVotes ?? s?.sheetVotes ?? null,
      totalPvp: a?.totalPvp ?? null,
      daoPvpM: s?.sheetTotalPvpM ?? null,
      ranked: Boolean(a?.ranked),
      seats: a?.ranked ? a.winners : null,
      distinctBallots: a?.distinctBallots ?? null,
      candidates: a?.candidates ?? null,
      amount: s?.amount?.value ?? null,
      currency: s?.currency ?? null,
      ecosystemFund: s?.ecosystemFund ?? false,
      roi: s?.roi ?? "",
      note: s?.note ?? "",
      funding: pay.get(n) ?? null,
    };
  });

  // Recurring inflow sources (e.g. marketplace fee sweeps) are summarised per month;
  // every other movement is listed individually.
  const incomeLegs = recon.legs.filter((l) => l.direction === "in" && l.confidence === "income");
  const perOwner = new Map();
  for (const l of incomeLegs) perOwner.set(l.owner, (perOwner.get(l.owner) ?? 0) + 1);
  const known = config.knownWallets ?? {};
  const recurring = new Set([...perOwner].filter(([o, n]) => n >= (config.income?.recurringMinTransfers ?? 20) || known[o]).map(([o]) => o));
  const monthly = new Map();
  const sourceTotals = new Map();
  for (const l of incomeLegs) {
    if (!recurring.has(l.owner)) continue;
    const m = new Date(l.t * 1000).toISOString().slice(0, 7);
    const row = monthly.get(m) ?? { month: m, ATLAS: 0, USDC: 0, transfers: 0 };
    row[l.symbol] = (row[l.symbol] ?? 0) + l.amount;
    row.transfers++;
    monthly.set(m, row);
    const s = sourceTotals.get(l.owner) ?? { owner: l.owner, label: known[l.owner] ?? null, transfers: 0, totals: {} };
    s.transfers++;
    s.totals[l.symbol] = round2((s.totals[l.symbol] ?? 0) + l.amount);
    sourceTotals.set(l.owner, s);
  }
  // Crafting fees: every SAGE crafting transaction pays a small ATLAS fee straight into the
  // Treasury's ATLAS account (tens of thousands a day), so that account is not scanned. Per month
  // they are what remains of the balance change after every movement the ledger did record
  // (payouts, transfers, marketplace fees): change of month-end balance minus recorded deltas.
  // A movement the ledger missed therefore shows up inside this figure.
  const tAtlas = series.treasuryATLAS?.points ?? [];
  const monthEnd = new Map();
  for (const [d, v] of tAtlas) monthEnd.set(d.slice(0, 7), v);
  const recordedAtlas = new Map();
  for (const r of ledger.rows) {
    if (r.account !== "treasury" || r.symbol !== "ATLAS") continue;
    const m = new Date(r.t * 1000).toISOString().slice(0, 7);
    recordedAtlas.set(m, (recordedAtlas.get(m) ?? 0) + r.delta);
  }
  // Before the crafting stream began, the account's history is scanned in full, so nothing is left
  // to derive there: crafting fees start with the month of indexTokensBefore.
  const craftFrom = (config.accounts.treasury?.indexTokensBefore?.ATLAS ?? "0000-00").slice(0, 7);
  const allEnds = [...monthEnd.keys()].sort();
  const endMonths = allEnds.filter((m, i) => m >= craftFrom || allEnds[i + 1] >= craftFrom);
  let craftingTotal = 0;
  for (let i = 1; i < endMonths.length; i++) {
    const m = endMonths[i];
    const crafting = monthEnd.get(m) - monthEnd.get(endMonths[i - 1]) - (recordedAtlas.get(m) ?? 0);
    const row = monthly.get(m) ?? { month: m, ATLAS: 0, USDC: 0, transfers: 0 };
    row.crafting = round2(crafting);
    monthly.set(m, row);
    craftingTotal += crafting;
  }

  // Every month from the first to the last income, so a month without income shows as an empty bar.
  const mkeys = [...monthly.keys()].sort();
  if (mkeys.length) {
    for (let [y, mo] = mkeys[0].split("-").map(Number); ; mo === 12 ? (y++, mo = 1) : mo++) {
      const k = `${y}-${String(mo).padStart(2, "0")}`;
      if (k > mkeys[mkeys.length - 1]) break;
      if (!monthly.has(k)) monthly.set(k, { month: k, ATLAS: 0, USDC: 0, transfers: 0, crafting: null });
    }
  }
  // Health: crafting fees are what remains of the balance change, so a transfer the ledger missed
  // lands in them. Each complete month is compared with the average of the months on either side
  // (a gradual change moves both together, a one-off transfer stands out); beyond the tolerance
  // it is flagged. The current month is still running and is skipped.
  const tol = config.income?.craftingTolerance ?? 0.25;
  const cm = [...monthly.values()].filter((r) => r.crafting != null).sort((a, b) => a.month.localeCompare(b.month));
  const thisMonth = new Date(nowTs * 1000).toISOString().slice(0, 7);
  const complete = cm.filter((r) => r.month < thisMonth);
  complete.forEach((r, i) => {
    const nb = [complete[i - 1], complete[i + 1]].filter(Boolean).map((x) => x.crafting);
    if (!nb.length) return;
    const base = nb.reduce((a, b) => a + b, 0) / nb.length;
    const dev = base > 0 ? (r.crafting - base) / base : 0;
    if (Math.abs(dev) > tol) flags.push({ severity: "warning", area: "income", message: `Crafting fees ${r.month}: ${Math.round(r.crafting).toLocaleString("en-US")} ATLAS, ${dev > 0 ? "+" : ""}${Math.round(dev * 100)}% against the months around it (tolerance ${Math.round(tol * 100)}%). Crafting fees are the Treasury's ATLAS balance change minus recorded movements, so a transfer the ledger missed shows up here. Check the Treasury's ATLAS transfers that month on Solscan; a missed sender can be added to the scan.` });
  });

  const income = {
    sources: [...sourceTotals.values()],
    crafting: endMonths.length > 1 ? { total: round2(craftingTotal), from: endMonths[1] } : null,
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({ ...r, ATLAS: round2(r.ATLAS), USDC: round2(r.USDC) })),
  };

  // Largest voters: each wallet's voting power at its most recent vote (PVP changes with the lock,
  // so the latest vote is the best reading), as a share of the DAO's total PVP for that proposal.
  const voterMap = new Map();
  for (const p of pips) {
    const v = votesOf(p.pip);
    if (!v?.votes) continue;
    for (const x of v.votes) {
      const w = voterMap.get(x.wallet) ?? { wallet: x.wallet, pips: 0, t: 0 };
      w.pips++;
      if (x.t > w.t) Object.assign(w, { t: x.t, pvp: x.pvp, pip: p.pip, lockedUntil: x.lockedUntil ?? null, polis: x.polis ?? null, daoPvp: p.daoPvpM ? p.daoPvpM * 1e6 : null });
      voterMap.set(x.wallet, w);
    }
  }
  const voterList = [...voterMap.values()].sort((a, b) => b.pvp - a.pvp);
  const voters = {
    count: voterList.length,
    top: voterList.slice(0, 15).map((w) => ({ ...w, pvp: round2(w.pvp), polis: w.polis == null ? null : round2(w.polis), share: w.daoPvp ? w.pvp / w.daoPvp : null })),
  };

  const out = {
    generatedAt,
    dataAt: nowAt,
    sources: {
      sheet: `https://docs.google.com/spreadsheets/d/${config.sheet.id}`,
      governance: config.governance.api,
      sheetFetchedAt: sources.fetchedAt,
    },
    accounts: Object.fromEntries(Object.entries(config.accounts).map(([k, a]) => [k, { label: a.label, wallet: a.wallet, now: now[k] }])),
    pips,
    knownWallets: known,
    // Names for counterparties: the Council's "Wallets" tab, plus known income sources from config.
    walletNames: { ...known, ...Object.fromEntries((sources.wallets ?? []).filter((w) => w.name).map((w) => [w.wallet, w.name])) },
    wallets: (sources.wallets ?? []).map((w) => ({ ...w, now: w.track ? tracked[w.wallet] ?? null : null })),
    income,
    voters,
    payments: recon.legs
      .filter((l) => l.amount > 0 && !(l.confidence === "income" && recurring.has(l.owner)))
      .map((l) => ({ sig: l.sig, t: l.t, account: l.account, symbol: l.symbol, amount: round2(l.amount), direction: l.direction, owner: l.owner, confidence: l.confidence, pip: l.pip, category: l.category ?? null, labelled: Boolean(l.labelled), reason: l.reason, isReturn: Boolean(l.isReturn) }))
      .sort((a, b) => b.t - a.t),
    limit,
    series,
    council: sources.council,
    councilTerms: { source: council.source, note: council.note, terms: council.terms },
    testNotice: config.sheet.testNotice || null,
    // Two-way editing: public identifiers only. Off unless enabled and a client ID is set.
    // EDITING_PREVIEW=1 (evaluation previews only) shows the sign-in button with an explanation
    // instead of a working sign-in, so no preview can write to any sheet.
    editing: config.editing?.enabled && config.editing.googleClientId
      ? {
          googleClientId: config.editing.googleClientId,
          sheetId: config.sheet.id,
          tabs: Object.fromEntries(Object.entries(sources.tabs ?? {}).map(([k, t]) => [k, t.name])),
          // Payment documents: only this account may upload (named on the disabled button for everyone else).
          documents: config.editing.documents?.owner ? { owner: config.editing.documents.owner, folder: config.editing.documents.folder || "Payment documents" } : null,
        }
      : editingPreview ? { preview: true } : null,
    health: flags,
  };
  return { out, recon, flags };
}
