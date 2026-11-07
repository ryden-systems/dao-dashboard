// Which wallets in the Council's Wallets tab are Squads multisig vaults. A vault pays out through the
// Squads program, so a transaction in which the wallet sends tokens or SOL and the Squads program runs
// marks it as one. Receiving is no sign: the DAO Treasury is itself a Squads multisig, so every payout
// it makes runs through Squads. Each wallet's newest transactions are read once (a cursor per wallet,
// at most CHECK per build); a wallet found to be a vault is not read again.
import { readJSON, writeJSON, log } from "./util.mjs";

const FILE = "data/wallet_kinds.json";
const CHECK = 25;
export const SQUADS = { SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf: "Squads v4", SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu: "Squads v3" };

// The Squads program of a transaction in which `wallet` sent funds, with the multisig account it names
// (one of `known`), or null.
export function squadsSend(tx, wallet, known = new Set()) {
  const m = tx?.meta, msg = tx?.transaction?.message;
  if (!m || !msg) return null;
  const keys = (msg.accountKeys ?? []).map((k) => k.pubkey ?? k);
  const prog = keys.find((k) => SQUADS[k]);
  if (!prog) return null;
  const mine = (list) => Object.fromEntries((list ?? []).filter((b) => b.owner === wallet).map((b) => [b.accountIndex, Number(b.uiTokenAmount?.uiAmountString ?? 0)]));
  const pre = mine(m.preTokenBalances), post = mine(m.postTokenBalances);
  const i = keys.indexOf(wallet);
  const sentToken = Object.keys(pre).some((a) => pre[a] > (post[a] ?? 0));
  const sentSol = i >= 0 && !(msg.accountKeys[i]?.signer) && m.preBalances?.[i] > m.postBalances?.[i];
  if (!sentToken && !sentSol) return null;
  return { program: SQUADS[prog], account: keys.find((k) => known.has(k)) ?? null };
}

export async function updateWalletKinds({ rpc, sigRpc }, config, wallets) {
  const store = readJSON(FILE, { wallets: {} });
  const known = new Set((config.councilMultisigs ?? []).map((x) => x.address));
  let read = 0;
  for (const w of new Set(wallets)) {
    const k = store.wallets[w] ?? { multisig: false };
    if (k.multisig) continue;
    try {
      const sigs = (await sigRpc.call("getSignaturesForAddress", [w, { limit: CHECK, ...(k.cursor ? { until: k.cursor } : {}) }])).filter((s) => !s.err);
      for (const s of sigs) {
        // A transaction the RPC cannot return (e.g. a newer transaction version) is skipped.
        const tx = await rpc.getTransaction(s.signature).catch(() => null);
        read++;
        const hit = squadsSend(tx, w, known);
        if (hit) { Object.assign(k, { multisig: true, ...hit, since: s.blockTime ?? null }); break; }
      }
      if (sigs.length) k.cursor = sigs[0].signature;
      k.checkedAt = new Date().toISOString();
      store.wallets[w] = k;
    } catch (e) {
      log(`wallets: multisig check of ${w.slice(0, 8)}… failed (${e.message}), retried next build`);
    }
  }
  store.updatedAt = new Date().toISOString();
  writeJSON(FILE, store);
  log(`wallets: ${Object.values(store.wallets).filter((x) => x.multisig).length} multisig vaults among ${Object.keys(store.wallets).length} wallets (${read} transactions read)`);
  return store;
}
