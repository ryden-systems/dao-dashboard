// Data-health checks. Every flag says what is wrong and where to fix it.
// severity: "critical" (a number on the dashboard is probably wrong)
//           "warning"  (the sheet and the chain disagree, or a value is missing)
//           "info"     (worth a look, not necessarily wrong)
import { balanceAt, fullyIndexed } from "./balances.mjs";

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US", { maximumFractionDigits: 2 }));

export function healthChecks({ pips, missingColumns, proposals, recon, ledger, history, now, config, nowTs = Date.now() / 1000 }) {
  const flags = [];
  const add = (severity, area, message, extra = {}) => flags.push({ severity, area, message, ...extra });

  // Sheet structure
  for (const c of missingColumns) add("critical", "sheet", `Column for "${c}" not found in the PIP tab. Restore the header or update the importer.`);

  // Sheet cells
  for (const p of pips) {
    for (const [field, label] of [["amount", "Amount"], ["paidAtlas", "Total Amount Paid (ATLAS)"], ["paidUsdc", "Total Amount Paid (USDC)"], ["leftAtlas", "Total Amount Left (ATLAS)"], ["leftUsdc", "Total Amount Left (USDC)"], ["milestonesDone", "Completed Milestones"], ["milestonesTotal", "Total Payment Milestones"]]) {
      const v = p[field];
      if (v?.state === "unknown") add("warning", "sheet", `PIP-${p.pip}: "${label}" is "?" in the sheet.`, { pip: p.pip });
      if (v?.state === "invalid") add("warning", "sheet", `PIP-${p.pip}: "${label}" is not a number ("${v.raw}").`, { pip: p.pip });
    }
    const d = p.milestonesDone.value, t = p.milestonesTotal.value;
    if (d != null && t != null && d > t) add("warning", "sheet", `PIP-${p.pip}: ${d} completed milestones but only ${t} in total.`, { pip: p.pip });
  }

  // Sheet vs governance API
  const api = new Map(proposals.map((p) => [p.pip, p]));
  for (const p of pips) {
    const a = api.get(p.pip);
    if (!a) { add("info", "governance", `PIP-${p.pip} is in the sheet but not in the governance API.`, { pip: p.pip }); continue; }
    const sheetOutcome = p.voteResult.toLowerCase();
    if ((sheetOutcome === "passed" || sheetOutcome === "failed") && a.outcome !== sheetOutcome && a.outcome !== "open") {
      add("warning", "governance", `PIP-${p.pip}: the sheet says ${p.voteResult}, the governance API says ${a.outcome}.`, { pip: p.pip });
    }
    if (p.sheetVotes != null && a.totalVotes && p.sheetVotes !== a.totalVotes) {
      add("info", "governance", `PIP-${p.pip}: the sheet records ${p.sheetVotes} votes, the governance API ${a.totalVotes}.`, { pip: p.pip });
    }
  }
  for (const a of proposals) if (!pips.some((p) => p.pip === a.pip)) add("info", "sheet", `PIP-${a.pip} (${a.title}) is in the governance API but has no row in the sheet yet.`, { pip: a.pip });

  // Payments: sheet vs chain
  for (const s of recon.summary) {
    for (const [sym, sheetCell] of [["ATLAS", s.sheet.paidAtlas], ["USDC", s.sheet.paidUsdc]]) {
      const chain = s.net[sym] ?? 0;
      const ret = s.returned[sym] ?? 0;
      const sheet = sheetCell.state === "ok" ? sheetCell.value : null;
      if (sheet == null && chain < 0.5) continue;
      const net = ret > 0 ? ` (${fmt(s.paid[sym])} sent, ${fmt(ret)} returned)` : "";
      if (sheet == null) { add("warning", "payments", `PIP-${s.pip}: ${fmt(chain)} ${sym} paid on-chain${net}, but the sheet has no paid ${sym} figure.`, { pip: s.pip }); continue; }
      if (Math.abs(sheet - chain) >= 0.5) add("warning", "payments", `PIP-${s.pip}: the sheet says ${fmt(sheet)} ${sym} paid, matched on-chain payouts total ${fmt(chain)} ${sym}${net}.`, { pip: s.pip });
    }
  }

  // Unlabelled payouts above the noise threshold
  const min = { USDC: config.reconcile.ignoreUsdcBelow, ATLAS: config.reconcile.ignoreAtlasBelow };
  const unl = recon.legs.filter((l) => l.direction === "out" && (l.confidence === "unlabelled" || l.confidence === "inferred") && l.amount >= (min[l.symbol] ?? 0));
  if (unl.length) add("warning", "payments", `${unl.length} on-chain payouts need a Council label (${unl.filter((l) => l.confidence === "inferred").length} have a suggestion).`);

  // Ledger completeness: a stored snapshot must equal the balance the ledger implies for that moment.
  for (const [day, snap] of Object.entries(history.days ?? {})) {
    if (!snap.at || nowTs - snap.at < 3600) continue;
    for (const account of Object.keys(config.accounts)) {
      for (const symbol of Object.keys(config.mints)) {
        if (!fullyIndexed(config, account, symbol) || snap[account]?.[symbol] == null) continue;
        const implied = balanceAt(ledger, now[account][symbol], account, symbol, snap.at);
        if (Math.abs(implied - snap[account][symbol]) > 0.01) {
          add("critical", "ledger", `${config.accounts[account].label} ${symbol}: balance recorded on ${day} was ${fmt(snap[account][symbol])}, the ledger implies ${fmt(implied)}. Transactions are missing; check the RPC's signature history.`);
        }
      }
    }
  }

  const order = { critical: 0, warning: 1, info: 2 };
  flags.sort((a, b) => order[a.severity] - order[b.severity] || (a.pip ?? 0) - (b.pip ?? 0));
  return flags;
}
