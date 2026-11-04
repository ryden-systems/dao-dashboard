// Live balances, the daily snapshot history, and exact historical balances
// for accounts whose full transfer history is in the ledger.
import { readJSON, writeJSON, isoDay, log } from "./util.mjs";

const HISTORY = "data/balances.json";

export async function readBalances(rpc, config) {
  const now = {};
  for (const [key, acc] of Object.entries(config.accounts)) {
    now[key] = { SOL: await rpc.solBalance(acc.wallet) };
    for (const [symbol, m] of Object.entries(config.mints)) {
      const tas = await rpc.tokenAccounts(acc.wallet, m.mint);
      now[key][symbol] = tas.reduce((s, t) => s + t.amount, 0);
    }
  }
  return now;
}

// Balances of the wallets the Council tracks ("Wallets" tab, Track balance = TRUE). A wallet
// that cannot be read is left out of this update instead of stopping the build.
export async function readTracked(rpc, config, wallets) {
  const out = {};
  for (const w of wallets) {
    try {
      const b = { SOL: await rpc.solBalance(w) };
      for (const [symbol, m] of Object.entries(config.mints)) b[symbol] = (await rpc.tokenAccounts(w, m.mint)).reduce((s, t) => s + t.amount, 0);
      out[w] = b;
    } catch (e) {
      log(`balances: tracked wallet ${w.slice(0, 8)}… could not be read: ${e.message}`);
    }
  }
  return out;
}

// Record today's balances (one entry per UTC day; a later run the same day overwrites it).
export function recordSnapshot(now, ts = Date.now() / 1000) {
  const hist = readJSON(HISTORY, { days: {} });
  hist.days[isoDay(ts)] = { at: Math.floor(ts), ...now };
  hist.updatedAt = new Date(ts * 1000).toISOString();
  writeJSON(HISTORY, hist);
  log(`balances: snapshot ${isoDay(ts)} recorded (${Object.keys(hist.days).length} days on file)`);
  return hist;
}

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
