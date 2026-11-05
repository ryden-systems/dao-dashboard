// Balance history from the ledger. Pure: used by the build and by the dashboard page.
import { isoDay } from "./pure.mjs";

// True when every movement of (account, symbol) is captured by the ledger,
// so the balance at any past moment can be rebuilt exactly.
export function fullyIndexed(config, account, symbol) {
  return (config.accounts[account]?.indexTokens ?? []).includes(symbol);
}

// Balance of (account, symbol) just before unix time `ts`: current minus every movement since.
export function balanceAt(ledger, current, account, symbol, ts) {
  let b = current;
  for (const r of ledger.rows) if (r.account === account && r.symbol === symbol && r.t >= ts) b -= r.delta;
  return Math.round(b * 1e8) / 1e8;
}

// Daily end-of-day series for a fully indexed (account, symbol), from its first movement to today.
export function rebuildSeries(ledger, current, account, symbol, todayTs = Date.now() / 1000) {
  const rows = ledger.rows.filter((r) => r.account === account && r.symbol === symbol);
  if (!rows.length) return [];
  const series = [];
  const DAY = 86400;
  let t = Math.floor(rows[0].t / DAY) * DAY;
  // Walk forward from the first movement, applying deltas day by day.
  let b = balanceAt(ledger, current, account, symbol, t);
  let i = 0;
  for (; t <= todayTs; t += DAY) {
    while (i < rows.length && rows[i].t < t + DAY) { b += rows[i].delta; i++; }
    series.push([isoDay(t), Math.round(b * 1e8) / 1e8]);
  }
  return series;
}
