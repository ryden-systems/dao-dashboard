// Self-indexing on-chain ledger.
//
// Each run scans only signatures newer than the stored cursor for a small set of
// low-volume addresses (the DAO wallets and selected token accounts), fetches just
// those transactions, and appends the token movements to data/ledger.json.
// The repository therefore accumulates the full payout history over time, with no
// external indexer.
import { readJSON, writeJSON, log, warn } from "./util.mjs";

const LEDGER = "data/ledger.json";
const CURSORS = "data/cursors.json";

// Resolve the list of addresses to scan and remember which token accounts belong to us.
export async function resolveIndex(rpc, config) {
  const targets = [];
  const ownTokenAccounts = {}; // token account address -> { account, symbol }
  for (const [key, acc] of Object.entries(config.accounts)) {
    targets.push({ address: acc.wallet, why: `${key} wallet` });
    for (const [symbol, m] of Object.entries(config.mints)) {
      const tas = await rpc.tokenAccounts(acc.wallet, m.mint);
      for (const ta of tas) {
        ownTokenAccounts[ta.address] = { account: key, symbol };
        if ((acc.indexTokens ?? []).includes(symbol)) targets.push({ address: ta.address, why: `${key} ${symbol} account` });
      }
    }
  }
  for (const ms of config.multisigs ?? []) targets.push({ address: ms.address, why: `multisig ${ms.label ?? ""}`.trim() });
  return { targets, ownTokenAccounts };
}

// Turn one parsed transaction into ledger rows: one row per (DAO account, token) whose balance changed.
export function parseTransaction(tx, sig, config) {
  if (!tx || tx.meta?.err) return [];
  const wallets = Object.fromEntries(Object.entries(config.accounts).map(([k, a]) => [a.wallet, k]));
  const symbolOf = Object.fromEntries(Object.entries(config.mints).map(([s, m]) => [m.mint, s]));
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);

  // accountIndex -> { mint, owner, pre, post }
  const bal = new Map();
  for (const b of tx.meta.preTokenBalances ?? []) {
    bal.set(b.accountIndex, { mint: b.mint, owner: b.owner, pre: Number(b.uiTokenAmount.uiAmountString ?? 0), post: 0 });
  }
  for (const b of tx.meta.postTokenBalances ?? []) {
    const e = bal.get(b.accountIndex) ?? { mint: b.mint, owner: b.owner, pre: 0, post: 0 };
    e.post = Number(b.uiTokenAmount.uiAmountString ?? 0);
    e.owner = e.owner ?? b.owner;
    bal.set(b.accountIndex, e);
  }

  const rows = [];
  const byMint = new Map();
  for (const [idx, e] of bal) {
    const symbol = symbolOf[e.mint];
    if (!symbol) continue;
    const delta = round(e.post - e.pre);
    if (delta === 0) continue;
    if (!byMint.has(symbol)) byMint.set(symbol, []);
    byMint.get(symbol).push({ tokenAccount: keys[idx], owner: e.owner, delta });
  }
  for (const [symbol, moves] of byMint) {
    // Net change per DAO account for this token.
    const net = {};
    for (const m of moves) {
      const acc = wallets[m.owner];
      if (acc) net[acc] = round((net[acc] ?? 0) + m.delta);
    }
    for (const [account, delta] of Object.entries(net)) {
      if (delta === 0) continue;
      // Counterparties: the other side of the movement (opposite sign, not the same DAO account).
      const legs = moves
        .filter((m) => wallets[m.owner] !== account && Math.sign(m.delta) === -Math.sign(delta))
        .map((m) => ({ owner: m.owner, tokenAccount: m.tokenAccount, amount: Math.abs(m.delta), dao: wallets[m.owner] ?? null }));
      rows.push({ sig, slot: tx.slot, t: tx.blockTime, account, symbol, delta, legs });
    }
  }
  return rows;
}

const round = (n) => Math.round(n * 1e8) / 1e8;

// rpc: balances + transaction lookups (any provider).
// sigRpc: signature history (must be archive-complete; see config.rpc._note).
export async function updateLedger({ rpc, sigRpc }, config) {
  const ledger = readJSON(LEDGER, { rows: [], seen: [] });
  const cursors = readJSON(CURSORS, {});
  const seen = new Set(ledger.seen);
  const { targets, ownTokenAccounts } = await resolveIndex(rpc, config);

  const fresh = new Map(); // sig -> blockTime
  for (const tgt of targets) {
    const sigs = await sigRpc.signaturesSince(tgt.address, cursors[tgt.address]);
    if (sigs.length) cursors[tgt.address] = sigs[0].signature;
    let n = 0;
    for (const s of sigs) {
      if (s.err || seen.has(s.signature) || fresh.has(s.signature)) continue;
      fresh.set(s.signature, s.blockTime);
      n++;
    }
    log(`ledger: ${tgt.why.padEnd(22)} ${tgt.address.slice(0, 8)}…  ${sigs.length} new signatures, ${n} unseen`);
  }

  const order = [...fresh.entries()].sort((a, b) => a[1] - b[1]);
  let added = 0, done = 0;
  for (const [sig] of order) {
    const tx = await rpc.getTransaction(sig);
    if (!tx) { warn(`ledger: transaction ${sig.slice(0, 10)}… not returned, will retry next run`); continue; }
    const rows = parseTransaction(tx, sig, config);
    ledger.rows.push(...rows);
    added += rows.length;
    seen.add(sig);
    if (++done % 100 === 0) {
      // Checkpoint: an interrupted run keeps its progress (cursors only move once a run completes,
      // so the next run rescans signatures and skips everything already seen).
      ledger.seen = [...seen];
      writeJSON(LEDGER, ledger, false);
      log(`ledger: fetched ${done}/${order.length} transactions (checkpoint saved)`);
    }
  }

  // A signature that failed to load is not marked seen, and the cursor must not skip it.
  if (done < order.length) {
    for (const tgt of targets) delete cursors[tgt.address];
    warn("ledger: some transactions were not returned; cursors reset so the next run retries them");
  }

  ledger.rows.sort((a, b) => a.t - b.t || a.sig.localeCompare(b.sig));
  ledger.seen = [...seen];
  ledger.updatedAt = new Date().toISOString();
  writeJSON(LEDGER, ledger, false);
  writeJSON(CURSORS, cursors);
  log(`ledger: ${order.length} transactions fetched, ${added} rows added, ${ledger.rows.length} rows total`);
  return { ledger, ownTokenAccounts, targets };
}
