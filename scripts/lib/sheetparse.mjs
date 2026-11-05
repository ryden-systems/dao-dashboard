// Parsers for the Council's sheet tabs. Pure: used by the build and by the dashboard page,
// which reads the sheet live. Columns are located by header text, so reordering columns is safe.
import { parseCSV, clean, parseNum } from "./pure.mjs";

const CURRENCY = { usdc: "USDC", usd: "USDC", atlas: "ATLAS", pounds: "GBP", gbp: "GBP", euros: "EUR", eur: "EUR" };

// The sheet as the calculation reads it, from the tabs' rows. rowsOf(key) returns a tab's rows, or
// null for a tab that does not exist (yet); key is "pips", "council", "paymentLabels",
// "councilMembers" or "wallets". Shared by the build and the page's live read, so both parse alike.
export function sheetSources({ rowsOf, tabs = {}, fetchedAt = new Date().toISOString() }) {
  const pipRows = rowsOf("pips");
  if (!pipRows) throw new Error("sheet: the PIP tab could not be read");
  const opt = (key, parse, empty) => { const rows = rowsOf(key); return rows ? parse(rows) : empty; };
  return {
    ...parsePipTab(pipRows),
    council: opt("council", parseCouncilTab, null),
    labels: opt("paymentLabels", parseLabelTab, []),
    members: opt("councilMembers", parseMembersTab, []),
    wallets: opt("wallets", parseWalletsTab, []),
    tabs,
    fetchedAt,
  };
}

// A configured tab is either a gid ("1688943123") or a tab name ("Payment labels").
// Returns the gid, or null when a named tab does not exist (yet).
export function resolveTab(ref, index) {
  if (ref == null || ref === "") return null;
  if (/^\d+$/.test(String(ref))) return String(ref);
  return index[ref] ?? null;
}

// Sheet dates: M/D/YYYY (the sheet's US format) or ISO YYYY-MM-DD.
function dateCell(raw) {
  const s = clean(raw);
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

const yes = (raw) => /^(yes|true)$/i.test(clean(raw));

export function parsePipTab(rows) {
  const hi = rows.findIndex((r) => r.some((c) => clean(c) === "PIP") && r.some((c) => clean(c) === "PIP Name"));
  if (hi < 0) throw new Error("PIP tab: header row not found (expected columns 'PIP' and 'PIP Name')");
  const header = rows[hi].map(clean);

  // Match by prefix so small header wording changes still resolve.
  const col = (...names) => {
    for (const n of names) {
      const i = header.findIndex((h) => h.toLowerCase().startsWith(n.toLowerCase()));
      if (i >= 0) return i;
    }
    return -1;
  };
  const C = {
    phase: col("PIP Phase"), draft: col("Draft Date"), voteStart: col("Voted Started", "Vote Started"),
    voteEnd: col("Vote Ended"), status: col("Status"), pdf: col("PDF sent"), md: col("Markdown sent"),
    step: col("Step"), pip: header.indexOf("PIP"), name: col("PIP Name"), amount: col("Amount"),
    type: col("Type"), roi: col("DAO ROI"), eco: col("Ecosystem Fund"), result: col("Vote Result"),
    category: col("Category"), sac: col("SAC Term"), note: col("Note"),
    paidUsdc: col("Total Amount Paid (USDC)"), leftUsdc: col("Total Amount Left (USDC)"),
    paidAtlas: col("Total Amount Paid (ATLAS)"), leftAtlas: col("Total Amount Left (ATLAS)"),
    msDone: col("Completed Milestones"), msTotal: col("Total Payment Milestones"),
    votes: col("# of Votes"), pvpVoted: col("PVP Voted"), totalPvp: col("Total PVP"),
    // Optional: a PIP paid in both currencies gets its USDC and ATLAS amounts here (token amounts).
    authUsdc: col("Authorized USDC"), authAtlas: col("Authorized ATLAS"),
  };
  const OPTIONAL = new Set(["authUsdc", "authAtlas"]);
  const missing = Object.entries(C).filter(([k, i]) => i < 0 && !OPTIONAL.has(k)).map(([k]) => k);

  const pips = [];
  for (const r of rows.slice(hi + 1)) {
    const id = clean(r[C.pip]);
    const m = id.match(/^PIP-(\d+)$/i);
    if (!m) continue;
    const get = (k) => (C[k] >= 0 ? r[C[k]] : "");
    const typeRaw = clean(get("type")).toLowerCase();
    pips.push({
      pip: Number(m[1]),
      name: clean(get("name")).replace(/^PIP-\d+:\s*/i, ""),
      phase: clean(get("phase")),
      status: clean(get("status")),
      draftDate: dateCell(get("draft")),
      voteStart: dateCell(get("voteStart")),
      voteEnd: dateCell(get("voteEnd")),
      pdfSent: yes(get("pdf")),
      markdownSent: yes(get("md")),
      amount: parseNum(get("amount")),
      currency: CURRENCY[typeRaw] ?? (typeRaw ? typeRaw.toUpperCase() : null),
      roi: clean(get("roi")),
      ecosystemFund: yes(get("eco")),
      voteResult: clean(get("result")),
      category: clean(get("category")),
      sacTerm: clean(get("sac")),
      note: clean(get("note")),
      paidUsdc: parseNum(get("paidUsdc")),
      leftUsdc: parseNum(get("leftUsdc")),
      paidAtlas: parseNum(get("paidAtlas")),
      leftAtlas: parseNum(get("leftAtlas")),
      authorizedUsdc: parseNum(get("authUsdc")),
      authorizedAtlas: parseNum(get("authAtlas")),
      milestonesDone: parseNum(get("msDone")),
      milestonesTotal: parseNum(get("msTotal")),
      sheetVotes: parseNum(get("votes")).value,
      sheetPvpVotedM: parseNum(get("pvpVoted")).value,
      sheetTotalPvpM: parseNum(get("totalPvp")).value,
    });
  }
  return { pips, missingColumns: missing };
}

// The Council tab is a small grid: a row of term labels (SAC-2, SAC-3 ...),
// a totals row, then one row per month ("April 2025", counts...).
export function parseCouncilTab(rows) {
  const ti = rows.findIndex((r) => r.some((c) => /^SAC-\d+$/i.test(clean(c))));
  if (ti < 0) return { title: "", terms: [], totals: {}, months: [] };
  const title = clean(rows.slice(0, ti).flat().find((c) => clean(c)) ?? "");
  const termCols = rows[ti].map((c, i) => [clean(c), i]).filter(([c]) => /^SAC-\d+$/i.test(c));
  const totals = {};
  const totalRow = rows[ti + 1] ?? [];
  for (const [t, i] of termCols) { const n = parseNum(totalRow[i]); if (n.state === "ok") totals[t] = n.value; }
  const MONTHS = ["january","february","march","april","may","june","july","august","september","october","november","december"];
  const months = [];
  for (const r of rows.slice(ti + 1)) {
    const mm = clean(r[0]).toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
    if (!mm || MONTHS.indexOf(mm[1]) < 0) continue;
    const counts = {};
    for (const [t, i] of termCols) { const n = parseNum(r[i]); if (n.state === "ok") counts[t] = n.value; }
    months.push({ month: `${mm[2]}-${String(MONTHS.indexOf(mm[1]) + 1).padStart(2, "0")}`, counts });
  }
  return { title, terms: termCols.map(([t]) => t), totals, months };
}

// Optional "Council members" tab maintained by the Council: one row per member and term.
// Headers (any order): Name, Role, Term, Start, End, Elected (PIP), Wallet, Discord, X, Image, Show.
// Only Name is required. Start/End decide whether a member is current, incoming, or past;
// "Show" = FALSE hides a row without deleting it.
export function parseMembersTab(rows) {
  const hi = rows.findIndex((r) => r.some((c) => /^name$/i.test(clean(c))));
  if (hi < 0) return [];
  const h = rows[hi].map((c) => clean(c).toLowerCase());
  const at = (...names) => h.findIndex((x) => names.some((n) => x === n || x.startsWith(n)));
  const C = {
    name: at("name"), role: at("role"), term: at("term"), start: at("start"), end: at("end"),
    pip: at("elected", "pip"), wallet: at("wallet"), discord: at("discord"), x: at("x", "twitter"),
    image: at("image", "avatar", "photo"), show: at("show", "active"),
  };
  const get = (r, k) => (C[k] >= 0 ? clean(r[C[k]]) : "");
  return rows.slice(hi + 1)
    .filter((r) => get(r, "name") && !(C.show >= 0 && /^(false|no)$/i.test(get(r, "show"))))
    .map((r) => ({
      name: get(r, "name"),
      role: get(r, "role") || "Council member",
      term: get(r, "term") || null,
      start: dateCell(get(r, "start")),
      end: dateCell(get(r, "end")),
      electedIn: Number((get(r, "pip").match(/\d+/) || [])[0]) || null,
      wallet: get(r, "wallet") || null,
      discord: get(r, "discord") || null,
      x: get(r, "x").replace(/^@/, "") || null,
      image: /^https:\/\//i.test(get(r, "image")) ? get(r, "image") : null,
    }));
}

// Optional tab maintained by the Council: other wallets the DAO deals with, one row each.
// Headers: "Wallet", "Name" (shown instead of the address), "Label" (given automatically to every
// payout to this wallet), "Track balance" (TRUE = its balances are shown), "Note".
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
export function parseWalletsTab(rows) {
  const hi = rows.findIndex((r) => r.some((c) => /^wallet$/i.test(clean(c))));
  if (hi < 0) return [];
  const h = rows[hi].map((c) => clean(c).toLowerCase());
  const at = (n) => h.findIndex((x) => x === n || x.startsWith(n));
  // "Payout label" since 2026-11; tabs made earlier call it "Label".
  const C = { wallet: at("wallet"), name: at("name"), label: at("payout label") >= 0 ? at("payout label") : at("label"), track: at("track"), note: at("note") };
  const get = (r, k) => (C[k] >= 0 ? clean(r[C[k]]) : "");
  const seen = new Set();
  return rows.slice(hi + 1)
    .map((r) => ({ wallet: get(r, "wallet"), name: get(r, "name"), label: get(r, "label"), track: yes(get(r, "track")), note: get(r, "note") }))
    .filter((w) => WALLET_RE.test(w.wallet) && !seen.has(w.wallet) && seen.add(w.wallet));
}

// Optional tab maintained by the Council: one row per on-chain payout they have labelled.
// Expected headers: "Signature", "PIP" (e.g. PIP-29, a cost category such as "Foundation", or "internal" / "refund" / "not a payout"), "Confirmed".
export function parseLabelTab(rows) {
  const hi = rows.findIndex((r) => r.some((c) => /^signature$/i.test(clean(c))));
  if (hi < 0) return [];
  const h = rows[hi].map((c) => clean(c).toLowerCase());
  const iSig = h.indexOf("signature"), iPip = h.indexOf("pip"), iOk = h.indexOf("confirmed"), iRecipient = h.indexOf("recipient");
  return rows.slice(hi + 1)
    .map((r) => ({
      signature: clean(r[iSig]),
      recipient: iRecipient >= 0 ? clean(r[iRecipient]) : "",
      label: clean(r[iPip]),
      confirmed: iOk >= 0 ? yes(r[iOk]) : true,
    }))
    .filter((x) => x.signature && x.label);
}
