// Ecosystem Fund PIP limit, derived with no manual input.
// The limit for a quarter is <percent>% of the fund's ATLAS balance at the start of that quarter,
// held for the whole quarter. The fund's full history is in the ledger, so its balance at any
// past quarter boundary is exact.
import { balanceAt } from "./series.mjs";
import { quarterOf, quarterStart } from "./pure.mjs";

export function fundLimits({ ledger, fundNow, percent = 5, nowTs = Date.now() / 1000 }) {
  const rows = ledger.rows.filter((r) => r.account === "fund" && r.symbol === "ATLAS");
  if (!rows.length) return { quarters: [], current: null, live: null };

  const refills = rows
    .filter((r) => r.delta > 0 && r.legs.some((l) => l.dao === "treasury"))
    .map((r) => ({ t: r.t, sig: r.sig, amount: r.delta }));

  const quarters = [];
  let key = quarterOf(rows[0].t);
  const lastKey = quarterOf(nowTs);
  for (;;) {
    const start = quarterStart(key);
    const balance = balanceAt(ledger, fundNow, "fund", "ATLAS", start);
    quarters.push({
      quarter: key,
      start: new Date(start * 1000).toISOString().slice(0, 10),
      balance: round(balance),
      limit: round((balance * percent) / 100),
      refills: refills.filter((r) => quarterOf(r.t) === key),
    });
    if (key === lastKey) break;
    key = next(key);
  }

  return {
    percent,
    quarters,
    current: quarters[quarters.length - 1],
    live: { balance: round(fundNow), limit: round((fundNow * percent) / 100) },
    lastRefill: refills[refills.length - 1] ?? null,
  };
}

function next(key) {
  let [y, q] = key.split("-Q").map(Number);
  q++; if (q > 4) { q = 1; y++; }
  return `${y}-Q${q}`;
}
const round = (n) => Math.round(n);
