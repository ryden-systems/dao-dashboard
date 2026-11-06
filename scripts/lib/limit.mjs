// Ecosystem Fund: the per-PIP limit and the refill rule, from the DAO rules in config.json
// (daoRules.fund) and the fund's on-chain history. No manual input.
//
// Each rule version applies from its date (the day its PIP passed). The limit's basis:
//   "initialFunding": <percent>% of the fund's balance after its first funding (PIP-4)
//   "lastRefill":     <percent>% of the fund's balance after the latest refill, held until the
//                     next refill (PIP-23)
// The limit caps a single PIP; it is not a budget for a period.
import { balanceAt } from "./series.mjs";

const DAY = 86400;
const tsOf = (iso) => Date.parse(`${iso}T00:00:00Z`) / 1000;
const isoOf = (ts) => new Date(ts * 1000).toISOString().slice(0, 10);
const round = (n) => Math.round(n);

// The rule version in force at unix time ts (the earliest one before the first version's date).
export function ruleAt(versions, ts) {
  const sorted = [...versions].sort((a, b) => a.from.localeCompare(b.from));
  return sorted.filter((v) => tsOf(v.from) <= ts).pop() ?? sorted[0] ?? null;
}

// The next refill date (MM-DD list, e.g. ["03-31", ...]) on or after unix time ts.
function nextDate(dates, ts) {
  if (!dates?.length) return null;
  const y = new Date(ts * 1000).getUTCFullYear();
  const today = isoOf(ts);
  return [y, y + 1].flatMap((yy) => dates.map((d) => `${yy}-${d}`)).sort().find((d) => d >= today) ?? null;
}

export function fundLimits({ ledger, fundNow, treasuryNow = {}, rules = [], nowTs = Date.now() / 1000 }) {
  const rows = ledger.rows.filter((r) => r.account === "fund" && r.symbol === "ATLAS");
  if (!rows.length || !rules.length) return { periods: [], current: null, refills: [], lastRefill: null, rules: [], refill: null };

  // Refills: ATLAS from the DAO Treasury into the fund, with the fund's balance right after.
  const refills = rows
    .filter((r) => r.delta > 0 && r.legs.some((l) => l.dao === "treasury"))
    .map((r) => ({ t: r.t, sig: r.sig, amount: round(r.delta), balanceAfter: round(balanceAt(ledger, fundNow, "fund", "ATLAS", r.t + 1)) }));
  if (!refills.length) return { periods: [], current: null, refills: [], lastRefill: null, rules, refill: null };

  // The limit changes at every refill and whenever a new rule version starts.
  const starts = [
    ...refills.map((r) => ({ ts: r.t, refill: r })),
    ...rules.map((v) => ({ ts: tsOf(v.from), rule: v })).filter((s) => s.ts > refills[0].t && s.ts <= nowTs),
  ].sort((a, b) => a.ts - b.ts);
  const periods = [];
  for (const s of starts) {
    const v = ruleAt(rules, s.ts);
    const last = refills.filter((r) => r.t <= s.ts).pop();
    const base = v.pipLimitBasis === "initialFunding" ? refills[0].balanceAfter : last.balanceAfter;
    periods.push({
      from: isoOf(s.ts), fromTs: s.ts,
      cause: s.refill ? (s.refill === refills[0] ? "funding" : "refill") : "rule",
      refill: s.refill ?? null,
      rule: { pip: v.pip, from: v.from, basis: v.pipLimitBasis, percent: v.pipLimitPercent },
      base, limit: round((base * v.pipLimitPercent) / 100),
    });
  }
  periods.forEach((p, i) => { p.to = periods[i + 1] ? isoOf(periods[i + 1].fromTs - DAY) : null; });

  // Refill rule today: the fund is topped up to <targetSharePercent>% of the ATLAS held by fund and
  // Treasury together; USDC above the threshold is shared at <usdcSharePercent>%.
  const v = ruleAt(rules, nowTs);
  const tA = treasuryNow.ATLAS ?? 0, tU = treasuryNow.USDC ?? 0;
  const target = ((fundNow + tA) * v.targetSharePercent) / 100;
  const refill = {
    share: fundNow + tA > 0 ? fundNow / (fundNow + tA) : null,
    targetSharePercent: v.targetSharePercent,
    target: round(target),
    atlasDue: round(Math.max(0, target - fundNow)),
    usdcThreshold: v.usdcThreshold,
    usdcDue: tU > v.usdcThreshold ? round(((tU - v.usdcThreshold) * v.usdcSharePercent) / 100) : 0,
    nextDate: nextDate(v.refillDates, nowTs),
  };

  return { periods, current: periods.at(-1), refills, lastRefill: refills.at(-1), rules, refill };
}
