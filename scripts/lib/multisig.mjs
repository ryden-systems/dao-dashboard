// Council activity on chain: every transaction on the DAO's Squads multisigs, and what it did.
//
// Every proposal, approval and execution on a Squads multisig touches the multisig account, so its
// signature list is a record of the Council's work there. Each transaction is read once and kept in
// compact form (time, who signed, which instructions ran, kind), so later builds only read new ones.
// The first build after this was added reads the whole history once (a few hundred transactions).
import { readJSON, writeJSON, log, warn } from "./util.mjs";
import { isoDay } from "./pure.mjs";

const FILE = "data/multisig_activity.json";

// The instructions a transaction ran, from its program logs ("Program log: Instruction: AddMember").
const instructionsOf = (tx) => [...new Set((tx.meta?.logMessages ?? []).filter((l) => /^Program log: Instruction: /.test(l)).map((l) => l.slice(26).trim()))];

// Whether a transaction moved tokens or SOL. Read from its parsed instructions, not its logs: the
// token program stopped logging instruction names in 2026, so a log check misses newer payouts.
export function movedFunds(tx) {
  const all = [...(tx.transaction?.message?.instructions ?? []), ...(tx.meta?.innerInstructions ?? []).flatMap((x) => x.instructions)];
  return all.some((i) => ["spl-token", "spl-token-2022", "system"].includes(i.program) && /^transfer/i.test(i.parsed?.type ?? ""));
}

// What a multisig transaction did. Kept next to the raw instruction list, so it can be re-derived.
export function kindOf(ins, moved = false) {
  const has = (re) => ins.some((i) => re.test(i));
  if (has(/^Execute/)) {
    if (has(/Member|Threshold|ChangeTimeLock|^AddAuthority|RemoveAuthority/)) return "execute:members";
    if (moved || has(/^Transfer/)) return "execute:transfer";
    return "execute:other";
  }
  if (has(/^CreateTransaction/)) return "propose";
  if (has(/^ApproveTransaction/)) return "approve";
  if (has(/^RejectTransaction/)) return "reject";
  if (has(/^CancelTransaction/)) return "cancel";
  if (has(/^TrackMeta/)) return "meta";
  return "other";
}

// Per day: transactions, executed decisions by kind, proposals created and approvals given (from the stored list).
export function dailyCounts(txs) {
  const days = {};
  for (const x of Object.values(txs ?? {})) {
    const c = (days[isoDay(x.t)] ??= { tx: 0, transfer: 0, members: 0, other: 0, proposals: 0, approvals: 0 });
    c.tx++;
    if (x.kind.startsWith("execute:")) c[x.kind.slice(8)]++;
    if (x.ins.includes("CreateTransaction")) c.proposals++;
    if (x.ins.includes("ApproveTransaction")) c.approvals++;
  }
  return days;
}

export async function updateMultisigActivity({ rpc, sigRpc }, config) {
  const store = readJSON(FILE, { accounts: {} });
  const save = () => { store.updatedAt = new Date().toISOString(); writeJSON(FILE, store); };
  for (const ms of config.councilMultisigs ?? []) {
    const acc = store.accounts[ms.address] ?? { cursor: null, days: {} };
    // No transaction list yet: read the full history once.
    if (!acc.txs) { acc.txs = {}; acc.cursor = null; }
    const sigs = (await sigRpc.signaturesSince(ms.address, acc.cursor ?? undefined)).filter((s) => !s.err && s.blockTime);
    let n = 0, missed = 0;
    for (const s of [...sigs].reverse()) {
      if (acc.txs[s.signature]) continue;
      // Refused or not returned: counted as missed, so the cursor stays and it is read again next build.
      const tx = await rpc.getTransaction(s.signature).catch(() => null);
      if (!tx) { missed++; continue; }
      const ins = instructionsOf(tx);
      const moved = movedFunds(tx);
      acc.txs[s.signature] = { t: s.blockTime, signer: tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey ?? null, ins, moved, kind: kindOf(ins, moved) };
      n++;
      // Checkpoint: an interrupted run keeps what it read.
      if (n % 100 === 0) { store.accounts[ms.address] = acc; save(); }
    }
    // A transaction that could not be read is retried next time: the cursor only moves when all were read.
    if (!missed && sigs.length) acc.cursor = sigs[0].signature;
    if (missed) warn(`multisig: ${ms.label}: ${missed} transactions not returned, retried next build`);
    acc.days = dailyCounts(acc.txs);
    store.accounts[ms.address] = acc;
    log(`multisig: ${ms.label.padEnd(22)} ${ms.address.slice(0, 8)}…  ${n} transactions read, ${Object.keys(acc.txs).length} stored`);
  }
  save();
  return store;
}
