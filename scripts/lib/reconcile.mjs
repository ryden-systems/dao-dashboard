// Matches on-chain payouts to PIPs and derives what each PIP has been paid.
//
// Confidence, strongest first:
//   confirmed       a Council label in the sheet (or the seed file) says so
//   matches-sheet   the payout, or all payouts to one recipient, equal the PIP's "paid" figure in the sheet
//   matches-amount  the payout equals the PIP's authorized amount in the same currency
//   inferred        same recipient as a payout already matched to exactly one PIP; needs a person to confirm
//   category        a Council label naming a cost instead of a PIP (e.g. Foundation); `category` holds the name
//   internal        a transfer between DAO accounts (e.g. Ecosystem Fund refill), or labelled refund / not a payout
//   unlabelled      nothing matched; listed for the Council to label
// Only confirmed / matches-sheet / matches-amount count toward "paid".

export const COUNTS_AS_PAID = new Set(["confirmed", "matches-sheet", "matches-amount"]);
const EPS = 1e-6;
// Labels that mean "no money was spent"; any other non-PIP label is a cost category.
const NOT_SPENDING = /^(internal|refund|not a payout)$/i;
const eq = (a, b) => a != null && b != null && Math.abs(a - b) < 0.5; // whole-token tolerance

// PIPs that can receive money: passed, amount > 0, not withdrawn.
export function fundedPips(pips) {
  return pips.filter((p) => /passed/i.test(p.voteResult) && (p.amount.value ?? 0) > 0 && !/withdrawn/i.test(p.phase));
}

function sheetPaid(p, symbol) {
  return symbol === "ATLAS" ? p.paidAtlas.value : symbol === "USDC" ? p.paidUsdc.value : null;
}

export function reconcile({ pips, ledger, labels = [], wallets = [], config }) {
  const funded = fundedPips(pips);
  const byPip = new Map(funded.map((p) => [p.pip, p]));
  const labelBySig = new Map();
  for (const l of labels) {
    const key = l.recipient ? `${l.signature}:${l.recipient}` : l.signature;
    labelBySig.set(key, l);
  }

  // Flatten ledger rows into legs: one entry per counterparty of a DAO movement.
  const legs = [];
  for (const r of ledger.rows) {
    if (!r.legs.length) {
      legs.push({ ...base(r), owner: null, amount: Math.abs(r.delta), direction: r.delta < 0 ? "out" : "in" });
      continue;
    }
    for (const l of r.legs) {
      legs.push({ ...base(r), owner: l.owner, ownerDao: l.dao, amount: l.amount, direction: r.delta < 0 ? "out" : "in" });
    }
  }
  function base(r) { return { sig: r.sig, t: r.t, account: r.account, symbol: r.symbol }; }

  const set = (leg, confidence, pip, reason) => { leg.confidence = confidence; leg.pip = pip ?? null; leg.reason = reason; };
  const pipLabel = (s) => { const m = String(s).match(/PIP-?(\d+)/i); return m ? Number(m[1]) : null; };

  // A label is a PIP, "internal" / "refund" / "not a payout", or a cost category such as Foundation.
  const applyLabel = (leg, text, confirmed, reason) => {
    const pip = pipLabel(text);
    if (pip != null) set(leg, confirmed ? "confirmed" : "inferred", pip, reason);
    else if (NOT_SPENDING.test(text)) set(leg, "internal", null, text);
    else { set(leg, confirmed ? "category" : "inferred", null, reason); leg.category = text; }
  };
  // Wallets with an automatic label ("Wallets" tab): every payout to them gets it.
  const walletLabel = new Map(wallets.filter((w) => w.label).map((w) => [w.wallet, w]));

  // Pass 1: internal transfers, Council labels on a payout, then wallet labels.
  for (const leg of legs) {
    if (leg.ownerDao) { set(leg, "internal", null, `${leg.direction === "out" ? "to" : "from"} ${config.accounts[leg.ownerDao]?.label ?? leg.ownerDao}`); continue; }
    const l = labelBySig.get(`${leg.sig}:${leg.owner}`) ?? labelBySig.get(leg.sig);
    if (l) { leg.labelled = true; applyLabel(leg, l.label, l.confirmed, "Council label"); continue; }
    const w = leg.direction === "out" && leg.owner ? walletLabel.get(leg.owner) : null;
    if (w) applyLabel(leg, w.label, true, `wallet label${w.name ? ` (${w.name})` : ""}`);
  }

  // A sheet "paid" figure can be claimed by one payout (or one recipient group) only;
  // otherwise two equal legs of a combined payout would both credit the same PIP.
  const sheetUsed = new Set();

  // Pass 2: single payouts equal to a PIP's sheet "paid" figure.
  for (const leg of legs) {
    if (leg.confidence || leg.direction !== "out") continue;
    const hits = funded.filter((p) => !sheetUsed.has(`${p.pip}:${leg.symbol}`) && eq(sheetPaid(p, leg.symbol), leg.amount));
    if (hits.length === 1) {
      sheetUsed.add(`${hits[0].pip}:${leg.symbol}`);
      set(leg, "matches-sheet", hits[0].pip, `equals the sheet's paid ${leg.symbol} for PIP-${hits[0].pip}`);
    }
  }

  // Pass 3: all payouts to one recipient summing to a PIP's sheet "paid" figure (milestones, test transfers).
  const byRecipient = groupBy(legs.filter((l) => !l.confidence && l.direction === "out" && l.owner), (l) => `${l.owner}:${l.symbol}`);
  for (const group of byRecipient.values()) {
    if (group.length < 2) continue;
    const sym = group[0].symbol;
    const sum = group.reduce((s, l) => s + l.amount, 0);
    const hits = funded.filter((p) => !sheetUsed.has(`${p.pip}:${sym}`) && eq(sheetPaid(p, sym), sum));
    if (hits.length !== 1) continue;
    sheetUsed.add(`${hits[0].pip}:${sym}`);
    for (const leg of group) set(leg, "matches-sheet", hits[0].pip, `${group.length} payouts to this recipient sum to the sheet's paid ${sym} for PIP-${hits[0].pip}`);
  }

  // Pass 4: payouts equal to an authorized amount. PIPs sharing an amount inside one
  // transaction are assigned one leg each, in PIP order.
  const bySig = groupBy(legs.filter((l) => !l.confidence && l.direction === "out"), (l) => `${l.sig}:${l.symbol}`);
  const taken = new Set(legs.filter((l) => l.pip != null && COUNTS_AS_PAID.has(l.confidence)).map((l) => l.pip));
  for (const group of bySig.values()) {
    for (const leg of group) {
      const cands = funded.filter((p) => p.currency === leg.symbol && eq(p.amount.value, leg.amount) && !taken.has(p.pip));
      if (!cands.length) continue;
      const pick = cands[0];
      taken.add(pick.pip);
      const note = cands.length > 1 ? ` (shared amount with ${cands.slice(1).map((c) => `PIP-${c.pip}`).join(", ")}; assigned in order)` : "";
      set(leg, "matches-amount", pick.pip, `equals PIP-${pick.pip}'s authorized ${leg.symbol}${note}`);
    }
  }

  // Recipient memory: owners already matched to exactly one PIP.
  const recipientPips = new Map();
  for (const leg of legs) {
    if (!leg.owner || leg.pip == null || !COUNTS_AS_PAID.has(leg.confidence)) continue;
    if (!recipientPips.has(leg.owner)) recipientPips.set(leg.owner, new Set());
    recipientPips.get(leg.owner).add(leg.pip);
  }

  // Recipients already labelled with exactly one cost category (e.g. the Foundation's wallet).
  const recipientCats = new Map();
  for (const leg of legs) {
    if (!leg.owner || leg.confidence !== "category") continue;
    if (!recipientCats.has(leg.owner)) recipientCats.set(leg.owner, new Set());
    recipientCats.get(leg.owner).add(leg.category);
  }

  // Pass 5: returns (inflows from a known PIP recipient) and inferred outflows.
  for (const leg of legs) {
    if (leg.confidence) continue;
    const known = leg.owner ? recipientPips.get(leg.owner) : null;
    if (leg.direction === "in") {
      if (known?.size === 1) { const pip = [...known][0]; set(leg, "matches-sheet", pip, `returned by PIP-${pip}'s recipient`); leg.isReturn = true; }
      else set(leg, "income", null, "inflow");
      continue;
    }
    const cats = leg.owner ? recipientCats.get(leg.owner) : null;
    if (!known?.size && cats?.size === 1) { const c = [...cats][0]; set(leg, "inferred", null, `same recipient as other ${c} payouts`); leg.category = c; }
    else if (known?.size === 1) { const pip = [...known][0]; set(leg, "inferred", pip, `same recipient as PIP-${pip}`); }
    else if (known?.size > 1) set(leg, "unlabelled", null, `recipient was paid for ${[...known].map((p) => `PIP-${p}`).join(", ")}`);
    else set(leg, "unlabelled", null, "no match");
  }

  // One spelling per cost category ("foundation" and "Foundation" are the same): the most used one wins.
  const spellings = new Map();
  for (const l of legs) {
    if (!l.category) continue;
    const m = spellings.get(l.category.toLowerCase()) ?? new Map();
    m.set(l.category, (m.get(l.category) ?? 0) + 1);
    spellings.set(l.category.toLowerCase(), m);
  }
  for (const l of legs) if (l.category) l.category = [...spellings.get(l.category.toLowerCase())].sort((a, b) => b[1] - a[1])[0][0];

  // Per-PIP payment summary. "paid" is gross (what left the DAO); "returned" is what came back.
  // Remaining is measured against gross paid: money sent and later returned is not "still owed".
  const summary = funded.map((p) => {
    const mine = legs.filter((l) => l.pip === p.pip);
    const paid = {}, returned = {}, inferred = {};
    for (const l of mine) {
      if (COUNTS_AS_PAID.has(l.confidence)) {
        const target = l.isReturn ? returned : paid;
        target[l.symbol] = (target[l.symbol] ?? 0) + l.amount;
      } else if (l.confidence === "inferred" && !l.isReturn) {
        inferred[l.symbol] = (inferred[l.symbol] ?? 0) + l.amount;
      }
    }
    const net = Object.fromEntries([...new Set([...Object.keys(paid), ...Object.keys(returned)])].map((s) => [s, (paid[s] ?? 0) - (returned[s] ?? 0)]));
    const authorized = p.amount.value;
    const sameCurrency = paid[p.currency] != null;
    const crossCurrency = Object.keys(paid).some((s) => s !== p.currency && paid[s] > EPS);
    let remaining = null, state;
    if (sameCurrency) remaining = Math.max(0, round(authorized - paid[p.currency]));
    const anyPaid = Object.values(paid).some((v) => v > EPS);
    const allReturned = anyPaid && Object.values(net).every((v) => Math.abs(v) < 0.5);
    const msDone = p.milestonesDone.value, msTotal = p.milestonesTotal.value;
    if (allReturned) state = "returned";
    else if (!anyPaid) state = "unpaid";
    else if (remaining === 0 || (msTotal && msDone === msTotal)) state = "paid";
    else state = "partly-paid";
    return {
      pip: p.pip, name: p.name, category: p.category, ecosystemFund: p.ecosystemFund, sacTerm: p.sacTerm,
      authorized, currency: p.currency, paid: roundAll(paid), returned: roundAll(returned), net: roundAll(net), inferred: roundAll(inferred), remaining,
      remainingNote: !sameCurrency && crossCurrency ? `authorized in ${p.currency}, paid in ${Object.keys(paid).join(" + ")}` : null,
      sheet: { paidAtlas: p.paidAtlas, paidUsdc: p.paidUsdc, leftAtlas: p.leftAtlas, leftUsdc: p.leftUsdc },
      milestones: { done: msDone, total: msTotal },
      state, payments: mine.map((l) => l.sig),
    };
  });

  return { legs, summary };
}

function groupBy(arr, fn) {
  const m = new Map();
  for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
const round = (n) => Math.round(n * 100) / 100;
const roundAll = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, round(v)]));
