// Tests reading transactions from the chain: the RPC request asks for Solana's newer transaction
// format (version 1), and a version-1 transaction is parsed like any other. Unread transactions
// show on the Data health page.
//   node test/ledger.test.mjs
import { makeRpc } from "../scripts/lib/rpc.mjs";
import { parseTransaction } from "../scripts/lib/ledger.mjs";
import { healthChecks } from "../scripts/lib/health.mjs";

let failed = 0, passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log("FAIL", msg); } };

// ---------- the request ----------
{
  const sent = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent.push(JSON.parse(opts.body)); return { status: 200, json: async () => ({ jsonrpc: "2.0", id: 1, result: null }) }; };
  try { await makeRpc("https://rpc.example", { minIntervalMs: 0 }).getTransaction("SIG"); } finally { globalThis.fetch = realFetch; }
  ok(sent[0]?.method === "getTransaction" && sent[0].params[1].maxSupportedTransactionVersion === 1 && sent[0].params[1].encoding === "jsonParsed", "transactions are requested with version 1 allowed: " + JSON.stringify(sent[0]?.params));
}

// ---------- a version-1 transaction (the shape the RPC returned for a real one, 2026-11-07) ----------
{
  const TREASURY = "CuwnarNh7FEqZMmffFjRyWj54RecyS7zwFg1CxfzNudi", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", SENDER = "SenderWa11et1111111111111111111111111111111";
  const config = { accounts: { treasury: { label: "DAO Treasury", wallet: TREASURY } }, mints: { USDC: { mint: USDC, decimals: 6 } } };
  const tx = {
    version: 1, blockTime: 1794000000, slot: 1,
    transaction: { signatures: ["SIGV1"], message: { accountKeys: [{ pubkey: SENDER, signer: true, writable: true }, { pubkey: "SenderTokenAcc", signer: false, writable: true }, { pubkey: "TreasuryTokenAcc", signer: false, writable: true }], instructions: [], recentBlockhash: "x", transactionConfig: {} } },
    meta: { err: null, fee: 5000, preBalances: [10, 0, 0], postBalances: [9, 0, 0],
      preTokenBalances: [{ accountIndex: 1, mint: USDC, owner: SENDER, uiTokenAmount: { uiAmountString: "100" } }, { accountIndex: 2, mint: USDC, owner: TREASURY, uiTokenAmount: { uiAmountString: "500" } }],
      postTokenBalances: [{ accountIndex: 1, mint: USDC, owner: SENDER, uiTokenAmount: { uiAmountString: "75" } }, { accountIndex: 2, mint: USDC, owner: TREASURY, uiTokenAmount: { uiAmountString: "525" } }] },
  };
  const rows = parseTransaction(tx, "SIGV1", config);
  const r = rows.find((x) => x.account === "treasury" && x.symbol === "USDC");
  ok(r && Math.abs(r.delta - 25) < 1e-9 && r.legs.some((l) => l.owner === SENDER && Math.abs(l.amount - 25) < 1e-9), "a version-1 transaction is parsed: 25 USDC into the Treasury from the sender: " + JSON.stringify(rows));
}

// ---------- unread transactions on the Data health page ----------
{
  const base = { pips: [], missingColumns: [], proposals: [], recon: { summary: [], legs: [] }, history: { days: {} }, now: {}, config: { accounts: {}, mints: {}, reconcile: { ignoreUsdcBelow: 1, ignoreAtlasBelow: 1 } } };
  const none = healthChecks({ ...base, ledger: { rows: [], unread: [] } });
  const some = healthChecks({ ...base, ledger: { rows: [], unread: [{ sig: "4sVTRSGomhd3abcdef", t: 1794000000, error: "Transaction version (1) is not supported" }] } });
  ok(!none.some((f) => /could not be read/.test(f.message)), "no flag when every transaction was read");
  ok(some.some((f) => f.severity === "critical" && /1 transaction of the DAO accounts could not be read in the last update \(first: 4sVTRSGomhd3…, Transaction version \(1\)/.test(f.message)), "an unread transaction is a critical flag naming it: " + JSON.stringify(some.map((f) => f.message)));
}

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} ledger checks passed`);
process.exit(failed ? 1 : 0);
