// Budget: what comes in, what goes out, what the DAO rules allow, and a projection of the
// Treasury and the Ecosystem Fund. Pure: used by the build and by the page's live calculation.
//
// Averages use the last `windowMonths` complete months. Payouts are split by what they paid for:
//   PIP payouts   labelled or matched to a PIP (one-off, decided by vote)
//   running costs a cost category (e.g. Operating costs); paid irregularly, so averaged per month
//   unlabelled    not identified yet: shown, but not projected (labelling moves them where they belong)
// The projection assumes the averages hold and applies the Fund refill rule at each refill date.
// It is an estimate from past months, not a plan.
import { ruleAt } from "./limit.mjs";

const DAY = 86400, MONTH = 30.44 * DAY;
const round = (n) => Math.round(n);
const monthOf = (t) => new Date(t * 1000).toISOString().slice(0, 7);
const tsOf = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

// The `n` complete months before the month of `nowTs`, oldest first ("2025-11" ... "2026-10").
function lastMonths(n, nowTs) {
  const d = new Date(nowTs * 1000);
  const out = [];
  for (let i = n; i >= 1; i--) out.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)).toISOString().slice(0, 7));
  return out;
}

export function budgetOf({ payments = [], income = {}, accounts = {}, pips = [], limit = {}, upcoming = [], rules = {}, settings = {}, nowTs = Date.now() / 1000 }) {
  const n = settings.windowMonths ?? 12;
  const months = lastMonths(n, nowTs), inWindow = new Set(months);
  const foundationCats = new Set((settings.foundationCategories ?? []).map((c) => c.toLowerCase()));

  // Income (all of it reaches the Treasury): crafting fees and transfers in from income sources.
  const inc = new Map((income.monthly ?? []).map((r) => [r.month, r]));
  const incRows = months.map((m) => inc.get(m) ?? { month: m, ATLAS: 0, USDC: 0, crafting: 0 });
  const half = Math.floor(n / 2);
  const atlasIn = (r) => (r.ATLAS ?? 0) + (r.crafting ?? 0);
  const income12 = {
    atlas: avg(incRows.map(atlasIn)), crafting: avg(incRows.map((r) => r.crafting ?? 0)), atlasTransfers: avg(incRows.map((r) => r.ATLAS ?? 0)),
    usdc: avg(incRows.map((r) => r.USDC ?? 0)),
    // Recent half against the earlier half of the window: how income is moving.
    trend: avg(incRows.slice(0, half).map(atlasIn)) > 0 ? avg(incRows.slice(half).map(atlasIn)) / avg(incRows.slice(0, half).map(atlasIn)) - 1 : null,
  };

  // Payouts in the window, by account and kind.
  // A payout the Treasury made for the Fund and the Fund reimbursed (onBehalfOf) counts as the Fund's.
  const outs = payments.filter((p) => p.direction === "out" && p.confidence !== "internal" && !p.isReturn && inWindow.has(monthOf(p.t)));
  const kindOf = (p) => (p.pip != null ? "pip" : p.category ? "running" : "unlabelled");
  const accOf = (p) => p.onBehalfOf ?? p.account;
  const sum = (acc, kind, sym) => outs.filter((p) => accOf(p) === acc && kindOf(p) === kind && p.symbol === sym).reduce((s, p) => s + p.amount, 0);
  const spend = {};
  for (const acc of ["treasury", "fund"]) for (const kind of ["pip", "running", "unlabelled"]) for (const sym of ["ATLAS", "USDC"]) {
    ((spend[acc] ??= {})[kind] ??= {})[sym] = { total: round(sum(acc, kind, sym)), perMonth: round(sum(acc, kind, sym) / n) };
  }
  // Running costs per category (Treasury), so each kind of cost stays visible on its own.
  const byCategory = {};
  for (const p of outs) {
    if (accOf(p) !== "treasury" || kindOf(p) !== "running") continue;
    const c = (byCategory[p.category] ??= { category: p.category, ATLAS: 0, USDC: 0, foundation: foundationCats.has(p.category.toLowerCase()) });
    c[p.symbol] = (c[p.symbol] ?? 0) + p.amount;
  }
  spend.treasury.runningByCategory = Object.values(byCategory).map((c) => ({ ...c, ATLAS: round(c.ATLAS), USDC: round(c.USDC) })).sort((a, b) => b.USDC - a.USDC || b.ATLAS - a.ATLAS);
  const unlabelled = {
    USDC: spend.treasury.unlabelled.USDC.total, ATLAS: spend.treasury.unlabelled.ATLAS.total,
    payouts: outs.filter((p) => accOf(p) === "treasury" && kindOf(p) === "unlabelled").length,
  };

  // Foundation budget (PIP-2): payouts in its cost categories per fiscal year, against the yearly cap.
  // The fiscal year comes from the payout's label ("Fiscal year" in Payment labels); a payout without
  // one counts in the calendar year it was paid (noFiscalYear says how many, so each year's reliability shows).
  const fRule = ruleAt(rules.foundation ?? [], nowTs);
  const years = new Map();
  for (const p of payments) {
    if (p.direction !== "out" || !p.category || !foundationCats.has(p.category.toLowerCase())) continue;
    const y = p.fiscalYear ?? monthOf(p.t).slice(0, 4), r = years.get(y) ?? { year: y, USDC: 0, ATLAS: 0, payouts: 0, noFiscalYear: 0, upcoming: 0, upcomingCount: 0 };
    r[p.symbol] = (r[p.symbol] ?? 0) + p.amount; r.payouts++;
    if (!p.fiscalYear) r.noFiscalYear++;
    years.set(y, r);
  }
  // Known upcoming payments (not paid yet) in the Foundation's categories count in their fiscal year.
  const open = upcoming.filter((u) => !u.paidBy);
  for (const u of open) {
    if (!u.for || !foundationCats.has(u.for.toLowerCase()) || u.currency !== "USDC") continue;
    const y = u.fiscalYear ?? String(u.due ?? "").slice(0, 4);
    if (!y) continue;
    const r = years.get(y) ?? { year: y, USDC: 0, ATLAS: 0, payouts: 0, noFiscalYear: 0, upcoming: 0, upcomingCount: 0 };
    r.upcoming += u.amount; r.upcomingCount++;
    years.set(y, r);
  }
  const foundation = {
    rule: fRule,
    categories: settings.foundationCategories ?? [],
    years: [...years.values()].sort((a, b) => b.year.localeCompare(a.year)).map((r) => ({ ...r, USDC: round(r.USDC), ATLAS: round(r.ATLAS), upcoming: round(r.upcoming), cap: fRule?.budgetUsdPerYear ?? null })),
  };

  // Approved PIPs not fully paid yet: one entry per currency still owed. A PIP paid in two currencies
  // owes per currency (remainingBy); an unpaid PIP owes what was authorized; a PIP authorized in one
  // currency and paid in another has no calculable remainder (amount null, with the reason). PIPs that
  // set a recurring budget (e.g. PIP-2, the Foundation's) are counted under that budget instead.
  const recurring = new Set((rules.foundation ?? []).map((v) => v.pip));
  // Paying account: the sheet's "Ecosystem Fund?" column; when it is empty, the account its payouts
  // came from (if they all came from one); otherwise "unknown", which the projection leaves out.
  const paidFrom = new Map();
  for (const p of payments) {
    if (p.direction !== "out" || p.pip == null || p.confidence === "internal" || p.confidence === "inferred") continue;
    if (!paidFrom.has(p.pip)) paidFrom.set(p.pip, new Set());
    paidFrom.get(p.pip).add(p.onBehalfOf ?? p.account);
  }
  const accountOf = (pip, eco) => (eco === true ? "fund" : eco === false ? "treasury" : paidFrom.get(pip)?.size === 1 ? [...paidFrom.get(pip)][0] : "unknown");
  const commitments = [];
  for (const p of pips) {
    const f = p.funding;
    if (!f || !["unpaid", "partly-paid"].includes(f.state) || recurring.has(p.pip)) continue;
    // Voted more than a year ago and nothing paid since: probably cancelled or settled another way.
    const voted = p.votingEndsAt ? Date.parse(p.votingEndsAt) / 1000 : null;
    const stale = f.state === "unpaid" && voted != null && nowTs - voted > 365 * DAY;
    const base = { pip: p.pip, name: f.name ?? p.title, account: accountOf(p.pip, f.ecosystemFund), accountFromSheet: f.ecosystemFund != null, state: f.state, voted: voted ? new Date(voted * 1000).toISOString().slice(0, 10) : null, stale };
    if (f.remainingBy) { for (const [cur, v] of Object.entries(f.remainingBy)) if (v > 0) commitments.push({ ...base, currency: cur, amount: round(v) }); }
    else if (Number(f.remaining) > 0) commitments.push({ ...base, currency: f.currency, amount: round(Number(f.remaining)) });
    else if (f.state === "unpaid" && Number(f.authorized) > 0) commitments.push({ ...base, currency: f.currency, amount: round(Number(f.authorized)) });
    else if (f.state === "partly-paid") commitments.push({ ...base, currency: f.currency, amount: null, note: f.remainingNote ?? "remainder not known" });
  }
  // Totals still owed, per account and currency.
  const owed = {};
  for (const c of commitments) if (c.amount != null) ((owed[c.account] ??= {})[c.currency] = (owed[c.account]?.[c.currency] ?? 0) + c.amount);

  // Projection to the next refill dates.
  const now = { tA: accounts.treasury?.now?.ATLAS ?? 0, tU: accounts.treasury?.now?.USDC ?? 0, fA: accounts.fund?.now?.ATLAS ?? 0 };
  const rate = {
    tA: income12.atlas - spend.treasury.running.ATLAS.perMonth,
    tU: income12.usdc - spend.treasury.running.USDC.perMonth,
    fA: -(spend.fund.pip.ATLAS.perMonth + spend.fund.running.ATLAS.perMonth + spend.fund.unlabelled.ATLAS.perMonth),
  };
  const fundRules = rules.fund ?? [];
  const dates = [];
  const y0 = new Date(nowTs * 1000).getUTCFullYear(), today = new Date(nowTs * 1000).toISOString().slice(0, 10);
  for (const y of [y0, y0 + 1, y0 + 2]) for (const d of ruleAt(fundRules, nowTs)?.refillDates ?? []) if (`${y}-${d}` > today) dates.push(`${y}-${d}`);
  dates.sort();
  let { tA, tU, fA } = now, at = nowTs;
  const steps = [{ date: today, treasuryATLAS: round(tA), treasuryUSDC: round(tU), fundATLAS: round(fA), share: fA / (fA + tA || 1), refillATLAS: 0, refillUSDC: 0, now: true }];
  // Approved PIPs still owed are paid first (their timing is not known, so the projection assumes now).
  // The Treasury pays ATLAS and USDC as owed; the Fund pays in ATLAS, so only its ATLAS amounts can be
  // taken off here. Amounts it owes in USDC, GBP or EUR are converted when paid and stay out (listed).
  const paysNow = { tA: owed.treasury?.ATLAS ?? 0, tU: owed.treasury?.USDC ?? 0, fA: owed.fund?.ATLAS ?? 0 };
  const notProjected = Object.fromEntries(Object.entries(owed.fund ?? {}).filter(([c]) => c !== "ATLAS"));
  // Known upcoming payments come off their account on their due date (those already due: now).
  const slot = (u) => (u.account === "treasury" && u.currency === "USDC" ? "tU" : u.account === "treasury" && u.currency === "ATLAS" ? "tA" : u.account === "fund" && u.currency === "ATLAS" ? "fA" : null);
  const upcomingList = open.map((u) => ({ ...u, projected: Boolean(slot(u) && u.due), overdue: Boolean(u.due && u.due <= today) })).sort((a, b) => String(a.due).localeCompare(String(b.due)));
  const take = (from, to) => {
    for (const u of upcomingList) if (u.projected && u.due > from && u.due <= to) { const k = slot(u); if (k === "tU") tU -= u.amount; else if (k === "tA") tA -= u.amount; else fA = Math.max(0, fA - u.amount); }
  };
  const dueNow = upcomingList.filter((u) => u.projected && u.overdue);
  for (const u of dueNow) paysNow[slot(u)] += u.amount;
  if (paysNow.tA || paysNow.tU || paysNow.fA) {
    tA -= paysNow.tA; tU -= paysNow.tU; fA = Math.max(0, fA - paysNow.fA);
    steps.push({ date: today, treasuryATLAS: round(tA), treasuryUSDC: round(tU), fundATLAS: round(fA), share: fA / (fA + tA || 1), refillATLAS: 0, refillUSDC: 0, afterOwed: true });
  }
  let prevDate = today;
  for (const d of dates.slice(0, settings.projectRefills ?? 4)) {
    const ts = tsOf(d), m = (ts - at) / MONTH;
    tA += rate.tA * m; tU += rate.tU * m; fA = Math.max(0, fA + rate.fA * m);
    take(prevDate, d); prevDate = d;
    const v = ruleAt(fundRules, ts);
    const refillATLAS = v ? Math.max(0, ((fA + tA) * v.targetSharePercent) / 100 - fA) : 0;
    const refillUSDC = v && tU > v.usdcThreshold ? ((tU - v.usdcThreshold) * v.usdcSharePercent) / 100 : 0;
    fA += refillATLAS; tA -= refillATLAS; tU -= refillUSDC;
    steps.push({ date: d, treasuryATLAS: round(tA), treasuryUSDC: round(tU), fundATLAS: round(fA), share: fA / (fA + tA || 1), refillATLAS: round(refillATLAS), refillUSDC: round(refillUSDC) });
    at = ts;
  }
  // Months until the Treasury's USDC runs out at the current pace (null when it is not shrinking),
  // and the same after paying the USDC it still owes on approved PIPs.
  const usdcRunwayMonths = rate.tU < 0 ? now.tU / -rate.tU : null;
  // Runway after paying everything outstanding: what approved PIPs are owed and every known upcoming USDC payment.
  const upcomingUsdc = upcomingList.filter((u) => slot(u) === "tU").reduce((s, u) => s + u.amount, 0) - dueNow.filter((u) => slot(u) === "tU").reduce((s, u) => s + u.amount, 0);
  const usdcRunwayAfterOwed = rate.tU < 0 ? Math.max(0, now.tU - paysNow.tU - upcomingUsdc) / -rate.tU : null;
  const upcomingTotals = {};
  for (const u of upcomingList) ((upcomingTotals[u.account ?? "unknown"] ??= {})[u.currency] = (upcomingTotals[u.account ?? "unknown"]?.[u.currency] ?? 0) + u.amount);

  return { window: { months: n, from: months[0], to: months.at(-1) }, income: income12, spend, unlabelled, foundation, commitments, owed, paysNow, notProjected, upcoming: upcomingList, upcomingTotals, rate, usdcRunwayMonths, usdcRunwayAfterOwed, projection: steps };
}
