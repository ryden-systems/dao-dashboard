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

export { fullyIndexed, balanceAt, rebuildSeries } from "./series.mjs";
