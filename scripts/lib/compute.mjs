// The dashboard's calculation: sheet + governance + ledger in, everything the page shows out.
// Pure (no file or network access), so it runs in the build and, with the sheet read live, in the
// browser: an edit in the sheet then shows on the next page load without waiting for a build.
import { reconcile } from "./reconcile.mjs";
import { fundLimits } from "./limit.mjs";
import { budgetOf } from "./budget.mjs";
import { healthChecks } from "./health.mjs";
import { councilTerms } from "./members.mjs";
import { rebuildSeries, fullyIndexed } from "./series.mjs";
import { councilVideos } from "./videos.mjs";
import { pipPlans, milestoneLabels } from "./plans.mjs";

const round2 = (n) => Math.round(n * 100) / 100;

// votesOf(pip) returns a proposal's per-voter file or null (the browser passes null: it keeps the
// built largest-voters table, which does not depend on the sheet's editable tabs).
export function compute({ config, sources, proposals, ledger, history, now, nowAt, tracked = {}, seedLabels = [], councilHistory = { terms: [] }, imported = {}, multisigActivity = { accounts: {} }, walletKinds = { wallets: {} }, youtube = { videos: {} }, votesOf = () => null, editingPreview = false, generatedAt = new Date().toISOString() }) {
  const nowTs = Date.parse(nowAt) / 1000;

  // Sheet labels override seed labels for the same payout.
  // A paid upcoming payment labels the payout that settled it (what it was for, its fiscal year);
  // a Council label on that payout wins.
  // A repeating payment labels each of its payouts.
  const upcomingLabels = (sources.upcoming ?? []).filter((u) => u.for)
    .flatMap((u) => (u.paid ?? (u.paidBy ? [u.paidBy] : [])).map((sig, i) => ({ signature: sig, recipient: "", label: u.for, confirmed: true, fiscalYear: u.paidYears?.[i] ?? u.fiscalYear })))
    .filter((u) => !sources.labels.some((l) => l.signature === u.signature));
  const msLabels = milestoneLabels(sources.milestones ?? []).filter((m) => !sources.labels.some((l) => l.signature === m.signature) && !upcomingLabels.some((u) => u.signature === m.signature));
  const labels = [...seedLabels.filter((s) => !sources.labels.some((l) => l.signature === s.signature)), ...upcomingLabels, ...msLabels, ...sources.labels];
  // A wallet reused for a new purpose has one row per purpose; its "Since" (a PIP, whose vote end starts
  // the purpose, or a date) becomes the time the row applies from. The first purpose has none.
  const voteEndTs = (n) => {
    const d = proposals.find((p) => p.pip === n)?.votingEndsAt ?? sources.pips.find((p) => p.pip === n)?.voteEnd;
    const t = d ? Date.parse(d) / 1000 : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const walletRows = (sources.wallets ?? []).map((w) => {
    const m = /^PIP-(\d+)$/i.exec(w.since ?? "");
    const from = m ? voteEndTs(Number(m[1])) : /^\d{4}-\d{2}-\d{2}$/.test(w.since ?? "") ? Date.parse(w.since) / 1000 : null;
    return { ...w, from };
  });
  const recon = reconcile({ pips: sources.pips, ledger, labels, wallets: walletRows, config });
  const limit = fundLimits({ ledger, fundNow: now.fund.ATLAS, treasuryNow: now.treasury, rules: config.daoRules?.fund ?? [], nowTs });
  const flags = healthChecks({ pips: sources.pips, missingColumns: sources.missingColumns, proposals, recon, ledger, history, now, config, nowTs });
  for (const w of walletRows) if (w.since && w.from == null) flags.push({ severity: "warning", area: "sheet", message: `Wallets tab: ${w.name || w.wallet} has Since "${w.since}", which is not a PIP with a vote end date or a date (YYYY-MM-DD), so that row counts from the wallet's first payout.` });
  // Per wallet: its purposes in time order; the last one is the current one.
  const byWallet = new Map();
  for (const w of [...walletRows].sort((a, b) => (a.from ?? -1) - (b.from ?? -1))) { if (!byWallet.has(w.wallet)) byWallet.set(w.wallet, []); byWallet.get(w.wallet).push(w); }
  // Named milestones and checklists per PIP; a PIP with named milestones counts them instead of the
  // Tracker's two milestone columns (done = a payout is linked).
  const plans = pipPlans({ milestones: sources.milestones ?? [], checklists: sources.checklists ?? [], legs: recon.legs });
  flags.push(...plans.flags);
  // A PIP with a milestone list counts it (done = completed or paid) instead of the Tracker's two columns,
  // which the dashboard keeps in step on every milestone save. `tracker`: those columns' values.
  const withPlan = (f, plan) => (f && plan?.milestones.length ? { ...f, milestones: { done: plan.milestones.filter((m) => m.completed || m.paidBy).length, paid: plan.milestones.filter((m) => m.paidBy).length, total: plan.milestones.length, fromList: true, tracker: f.milestones } } : f);
  // A payout labelled in more than one row: the last row is used, which is easy to miss in the sheet.
  const labelCount = new Map();
  for (const l of sources.labels) labelCount.set(`${l.signature}:${l.recipient}`, (labelCount.get(`${l.signature}:${l.recipient}`) ?? 0) + 1);
  for (const [k, n] of labelCount) {
    if (n > 1) flags.push({ severity: "warning", area: "payments", message: `Payment labels: payout ${k.slice(0, 8)}… is labelled in ${n} rows; the last one is used. Delete the others, or relabel it from the dashboard (that removes them).` });
  }
  const council = councilTerms({ sheetMembers: sources.members ?? [], proposals, history: councilHistory });
  for (const w of council.warnings) flags.push({ severity: "warning", area: "council", message: w });
  // Paid by the Fund through the Treasury: the Treasury pays a Fund PIP (sheet "Ecosystem Fund?" = YES)
  // and the Fund then sends the Treasury the same amount within 30 days (e.g. PIP-29 and PIP-30 in
  // April 2026). Those payouts count as the Fund's (onBehalfOf), on the Budget page as well.
  const fundPip = new Map(recon.summary.map((s) => [s.pip, s.ecosystemFund]));
  const reimbursements = recon.legs.filter((l) => l.account === "fund" && l.direction === "out" && l.confidence === "internal");
  const bySig = new Map();
  for (const l of recon.legs) {
    if (l.account !== "treasury" || l.direction !== "out" || l.pip == null || fundPip.get(l.pip) !== true) continue;
    const k = `${l.sig}:${l.symbol}`;
    if (!bySig.has(k)) bySig.set(k, []);
    bySig.get(k).push(l);
  }
  for (const legs of bySig.values()) {
    const total = legs.reduce((s, l) => s + l.amount, 0), t = legs[0].t;
    const r = reimbursements.find((x) => x.symbol === legs[0].symbol && Math.abs(x.amount - total) < 1 && x.t >= t && x.t - t <= 30 * 86400);
    if (r) for (const l of legs) { l.onBehalfOf = "fund"; l.reimbursedBy = r.sig; }
  }
  // Which account pays a PIP: the sheet's "Ecosystem Fund?" column, checked against the wallet its
  // matched payouts actually came from (the dashboard's own guesses, "inferred", are left out). The
  // Budget page relies on it for what each account still owes.
  const ACC = { fund: "Ecosystem Fund", treasury: "DAO Treasury" };
  const paidFrom = new Map();
  for (const l of recon.legs) {
    if (l.direction !== "out" || l.pip == null || l.confidence === "internal" || l.confidence === "inferred" || !ACC[l.account]) continue;
    if (!paidFrom.has(l.pip)) paidFrom.set(l.pip, new Set());
    paidFrom.get(l.pip).add(l.onBehalfOf ?? l.account);
  }
  for (const s of recon.summary) {
    const from = [...(paidFrom.get(s.pip) ?? [])];
    if (s.ecosystemFund == null) {
      flags.push({ severity: "warning", area: "sheet", pip: s.pip, message: `PIP-${s.pip}: "Ecosystem Fund?" is empty in the sheet, so it is not known whether the Ecosystem Fund or the DAO Treasury pays it${from.length ? ` (its payouts so far came from the ${from.map((a) => ACC[a]).join(" and the ")})` : ""}. Enter YES or NO.` });
      continue;
    }
    const want = s.ecosystemFund ? "fund" : "treasury";
    const other = from.filter((a) => a !== want);
    if (other.length) flags.push({ severity: "warning", area: "sheet", pip: s.pip, message: `PIP-${s.pip}: the sheet says the ${ACC[want]} pays it ("Ecosystem Fund?" = ${s.ecosystemFund ? "YES" : "NO"}), but payouts matched to it came from the ${other.map((a) => ACC[a]).join(" and the ")}. Correct the column, or the payout's label if it belongs to another PIP.` });
  }
  // Council activity on chain: decisions executed on the Council's Squads multisigs per month, by
  // kind (payouts, member changes, other), and proposals created. Counted from the first Council
  // term on; each term's start is returned so the chart can mark it.
  const termStarts = council.terms.filter((t) => t.start).map((t) => ({ label: t.label, start: t.start })).sort((a, b) => a.start.localeCompare(b.start));
  const firstTerm = termStarts[0]?.start ?? null;
  const today = String(nowAt).slice(0, 10);
  const chainMonths = new Map();
  for (const ms of config.councilMultisigs ?? []) {
    for (const [d, c] of Object.entries(multisigActivity.accounts?.[ms.address]?.days ?? {})) {
      if (!firstTerm || d < firstTerm || typeof c !== "object") continue;
      const row = chainMonths.get(d.slice(0, 7)) ?? { transfer: 0, members: 0, other: 0, proposals: 0 };
      for (const k of Object.keys(row)) row[k] += c[k] ?? 0;
      chainMonths.set(d.slice(0, 7), row);
    }
  }
  const chainList = [];
  if (firstTerm && chainMonths.size) {
    const last = [today.slice(0, 7), ...chainMonths.keys()].sort().at(-1);
    for (let [y, m] = firstTerm.slice(0, 7).split("-").map(Number); `${y}-${String(m).padStart(2, "0")}` <= last; m === 12 ? (y++, m = 1) : m++) {
      const k = `${y}-${String(m).padStart(2, "0")}`;
      chainList.push({ month: k, ...(chainMonths.get(k) ?? { transfer: 0, members: 0, other: 0, proposals: 0 }) });
    }
  }
  // Multisigs in use each month: a multisig counts from the day of its first transaction (its creation).
  const firstDays = (config.councilMultisigs ?? []).map((ms) => Object.keys(multisigActivity.accounts?.[ms.address]?.days ?? {}).sort()[0]).filter(Boolean);
  for (const row of chainList) row.multisigs = firstDays.filter((d) => d.slice(0, 7) <= row.month).length;
  const councilChain = {
    months: chainList,
    terms: termStarts.filter((t) => t.start <= today),
    multisigs: (config.councilMultisigs ?? []).length,
  };

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
      status: s?.status ?? null,
      step: s?.step ?? null,
      draftDate: s?.draftDate ?? null,
      draftId: s?.draftId ?? null,
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
      ecosystemFund: s?.ecosystemFund ?? null,
      roi: s?.roi ?? "",
      note: s?.note ?? "",
      funding: withPlan(pay.get(n) ?? null, plans.byPip.get(n)),
      milestones: plans.byPip.get(n)?.milestones ?? [],
      checklists: plans.byPip.get(n)?.checklists ?? [],
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

  // Shared by the output and the budget.
  const accountsOut = Object.fromEntries(Object.entries(config.accounts).map(([k, a]) => [k, { label: a.label, wallet: a.wallet, now: now[k], retired: a.retired ?? null }]));
  const payoutsList = recon.legs
      .filter((l) => l.amount > 0 && !(l.confidence === "income" && recurring.has(l.owner)))
      .map((l) => ({ sig: l.sig, t: l.t, account: l.account, symbol: l.symbol, amount: round2(l.amount), direction: l.direction, owner: l.owner, confidence: l.confidence, pip: l.pip, category: l.category ?? null, labelled: Boolean(l.labelled), reason: l.reason, isReturn: Boolean(l.isReturn), onBehalfOf: l.onBehalfOf ?? null, reimbursedBy: l.reimbursedBy ?? null, fiscalYear: l.fiscalYear ?? null }))
      .sort((a, b) => b.t - a.t);
  const out = {
    generatedAt,
    dataAt: nowAt,
    sources: {
      sheet: `https://docs.google.com/spreadsheets/d/${config.sheet.id}`,
      governance: config.governance.api,
      sheetFetchedAt: sources.fetchedAt,
    },
    accounts: accountsOut,
    pips,
    // Tracker rows without a PIP number yet (ideas, drafts, withdrawn before a vote).
    drafts: (sources.drafts ?? []).map((d) => ({ draftId: d.draftId, name: d.name, phase: d.phase, status: d.status, step: d.step, draftDate: d.draftDate, pdfSent: d.pdfSent, markdownSent: d.markdownSent, amount: d.amount?.value ?? null, currency: d.currency, category: d.category, sacTerm: d.sacTerm, note: d.note })),
    knownWallets: known,
    // Names for counterparties: the Council's "Wallets" tab, plus known income sources from config.
    walletNames: { ...known, ...Object.fromEntries([...byWallet.values()].map((l) => [l[0].wallet, [...l].reverse().find((x) => x.name)?.name]).filter(([, n]) => n)) },
    // One entry per wallet with its current purpose; `history` lists every purpose when it was reused.
    // `multisig`: found on chain to pay out through a Squads multisig (see walletkinds.mjs).
    wallets: [...byWallet.values()].map((l) => {
      const cur = l[l.length - 1], track = l.some((x) => x.track), k = walletKinds.wallets?.[cur.wallet];
      return {
        wallet: cur.wallet, name: cur.name, label: cur.label, note: cur.note, since: cur.since || null, track,
        now: track ? tracked[cur.wallet] ?? null : null,
        history: l.length > 1 ? l.map((x) => ({ name: x.name, label: x.label, since: x.since || null })) : [],
        multisig: k?.multisig ? { program: k.program ?? null, account: k.account ?? null, label: (config.councilMultisigs ?? []).find((m) => m.address === k.account)?.label ?? null } : null,
      };
    }),
    income,
    voters,
    payments: payoutsList,
    limit,
    budget: budgetOf({ payments: payoutsList, income, accounts: accountsOut, pips, limit, upcoming: sources.upcoming ?? [], rules: config.daoRules ?? {}, settings: config.budget ?? {}, nowTs }),
    upcoming: sources.upcoming ?? [],
    series,
    council: sources.council,
    councilChain,
    videos: councilVideos({ store: youtube, terms: council.terms, channelUrl: config.youtube?.url ?? null, minutes: sources.minutes ?? [] }),
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
