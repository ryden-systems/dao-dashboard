// Tests the two-way editor against an in-memory imitation of the Google Sheets API,
// seeded with a copy of the real Tracker tab. Then reads what the editor wrote back through
// the build's own importers, to prove both directions use the same format.
//   node test/editor.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT, parseCSV } from "../scripts/lib/util.mjs";
import { parsePipTab, parseLabelTab, parseMembersTab, parseWalletsTab, parseMinutesTab, parseUpcomingTab, parseMilestonesTab, parseChecklistTab } from "../scripts/lib/sheet.mjs";
import { pipPlans, milestoneLabels } from "../scripts/lib/plans.mjs";
import { budgetOf } from "../scripts/lib/budget.mjs";
import { councilVideos } from "../scripts/lib/videos.mjs";
import { reconcile } from "../scripts/lib/reconcile.mjs";
import { squadsSend } from "../scripts/lib/walletkinds.mjs";
import { councilTerms } from "../scripts/lib/members.mjs";

let failed = 0, passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log("FAIL", msg); } };

// Load the browser scripts the same way the page does.
const ctx = { console, Promise, JSON, Object, Array, String, Number, Math, Map, Set, Blob, encodeURIComponent, decodeURIComponent };
ctx.window = ctx; ctx.globalThis = ctx;
vm.createContext(ctx);
for (const f of ["sheetmap.js", "editor.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, "site", f), "utf8"), ctx, { filename: f });
const SM = ctx.SheetMap;

// ---------- fake Sheets API ----------
const book = { Tracker: parseCSV(fs.readFileSync(path.join(ROOT, "test", "fixtures", "tracker.csv"), "utf8")) };
let access = true, readOnly = false;
const writes = [];
function parseRange(r) {
  const m = r.match(/^'((?:[^']|'')+)'(?:!([A-Z]+)(\d+))?$/);
  if (!m) throw new Error("bad range " + r);
  const tab = m[1].replace(/''/g, "'");
  if (!m[2]) return { tab };
  let col = 0; for (const ch of m[2]) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { tab, row: Number(m[3]) - 1, col: col - 1 };
}
const json = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
async function fakeFetch(url, opts = {}) {
  if (!access) return json(403, { error: { message: "The caller does not have permission" } });
  // A view-only account: reading works, every write is refused.
  if (readOnly && (opts.method || "GET") !== "GET") return json(403, { error: { message: "The caller does not have permission" } });
  const u = new URL(url);
  const rest = decodeURIComponent(u.pathname.split("/spreadsheets/")[1]).split("/").slice(1).join("/");
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (!rest && u.search.includes("fields=properties.title")) return json(200, { properties: { title: "Tracker sheet" } });
  if (!rest && u.search.includes("sheets.properties")) return json(200, { sheets: Object.keys(book).map((t, i) => ({ properties: { title: t, sheetId: i } })) });
  if (rest === ":batchUpdate" || (u.pathname.endsWith(":batchUpdate") && rest !== "values:batchUpdate")) {
    // Like Google: an update without any request is refused.
    if (!body.requests?.length) return json(400, { error: { message: "Invalid requests: must specify at least one request." } });
    for (const rq of body.requests) if (rq.updateSpreadsheetProperties && rq.updateSpreadsheetProperties.properties.title !== "Tracker sheet") return json(500, { error: { message: "the check must not rename the sheet" } });
    for (const rq of body.requests) if (rq.addSheet) { const t = rq.addSheet.properties.title; if (book[t]) return json(400, { error: { message: "exists" } }); book[t] = []; }
    for (const rq of body.requests) if (rq.deleteDimension) { const g = rq.deleteDimension.range; book[Object.keys(book)[g.sheetId]].splice(g.startIndex, g.endIndex - g.startIndex); }
    return json(200, {});
  }
  if (rest === "values:batchUpdate") {
    for (const d of body.data) {
      const c = parseRange(d.range), tab = book[c.tab];
      while (tab.length <= c.row) tab.push([]);
      while (tab[c.row].length <= c.col) tab[c.row].push("");
      tab[c.row][c.col] = String(d.values[0][0]).replace(/^'/, "");
    }
    writes.push(["batch", body.data.length]);
    return json(200, {});
  }
  const m = rest.match(/^values\/(.+?)(:append)?$/);
  if (!m) return json(404, { error: { message: "unknown " + rest } });
  const r = parseRange(m[1]);
  const tab = book[r.tab];
  if (!tab) return json(400, { error: { message: "Unable to parse range: " + m[1] } });
  // Like Google with valueInputOption=USER_ENTERED: a leading apostrophe forces text and is not shown.
  const entered = (v) => String(v).replace(/^'/, "");
  if (m[2]) { for (const row of body.values) tab.push(row.map(entered)); writes.push(["append", r.tab]); return json(200, {}); }
  if ((opts.method || "GET") === "PUT") {
    while (tab.length <= r.row) tab.push([]);
    while (tab[r.row].length <= r.col) tab[r.row].push("");
    tab[r.row][r.col] = entered(body.values[0][0]); writes.push(["put", m[1]]);
    return json(200, {});
  }
  if (r.row == null) return json(200, { values: tab });
  return json(200, { values: [[(tab[r.row] || [])[r.col] ?? ""]] });
}
const core = ctx.Editor.makeCore({ sheetId: "SHEET", tabs: { pips: "Tracker", paymentLabels: "Payment labels", councilMembers: "Council members" }, fetchFn: fakeFetch, getToken: async () => "token" });

// ---------- sheetmap ----------
ok(SM.colLetter(0) === "A" && SM.colLetter(25) === "Z" && SM.colLetter(26) === "AA" && SM.colLetter(30) === "AE", "colLetter");
ok(SM.a1("Bob's tab", 4, 2) === "'Bob''s tab'!C5", "a1 quotes apostrophes");
const loc = SM.locatePip(book.Tracker, 16);
ok(!loc.error && loc.pip === 16 && Object.entries(loc.cols).every(([k, c]) => c >= 0 || SM.PIP_FIELDS[k].add), "locatePip finds PIP-16 and every editable column: " + JSON.stringify(loc.error || loc.cols));
ok(SM.locatePip(book.Tracker, 999).error?.includes("no row"), "unknown PIP reported");
ok(SM.validate("int", "3") === "" && SM.validate("int", "abc") !== "", "int validation");
ok(SM.validate("pipLabel", "PIP-28") === "" && SM.validate("pipLabel", "internal") === "" && SM.validate("pipLabel", "28") !== "", "label validation");
ok(SM.validate("pipLabel", "Foundation") === "" && SM.validate("pipLabel", "PIP 28") !== "", "cost categories are valid labels, PIP typos are not");
ok(SM.validate("url", "javascript:alert(1)") !== "", "unsafe image link rejected");

// ---------- read + save with conflict check ----------
ok(await core.canAccess(), "access granted");
const before = await core.readPip(16);
ok(!before.error && typeof before.values.note === "string", "readPip returns live values");
let r = await core.savePip(16, { note: { from: before.values.note, to: "Updated from the dashboard" } });
ok(r.saved, "save with matching 'from' succeeds");
ok(book.Tracker[loc.row][loc.cols.note] === "Updated from the dashboard", "cell written in the sheet");
r = await core.savePip(16, { note: { from: "what I saw an hour ago", to: "Mine" } });
ok(r.conflicts?.length === 1 && r.conflicts[0].sheet === "Updated from the dashboard", "conflict detected, sheet value reported");
ok(book.Tracker[loc.row][loc.cols.note] === "Updated from the dashboard", "nothing written on conflict");
r = await core.savePip(16, { note: { from: "what I saw an hour ago", to: "Mine" } }, { force: true });
ok(r.saved && book.Tracker[loc.row][loc.cols.note] === "Mine", "forced overwrite writes");
r = await core.savePip(16, { milestonesDone: { from: "1", to: "abc" } });
ok(r.error?.includes("whole number"), "invalid number refused before any write");
const n0 = writes.length;
r = await core.savePip(16, { milestonesDone: { from: book.Tracker[loc.row][loc.cols.milestonesDone], to: book.Tracker[loc.row][loc.cols.milestonesDone] } });
ok(r.saved && writes.length === n0, "unchanged value is not rewritten");

// ---------- Tracker: process and funding fields, Add PIP, drafts without a number ----------
{
  const saved = book.Tracker.map((r) => [...r]);
  const T = SM.trackerColumns(book.Tracker);
  const v = await core.readPip(16);
  ok(!v.error && v.form.pipNo === "16" && typeof v.form.pdfSent === "boolean" && !v.missing.includes("authUsdc") && !v.missing.includes("draftId"), "readPip gives form values; added columns are not missing: " + JSON.stringify(v.missing));
  let r = await core.savePip(16, { amount: { from: v.values.amount, to: "1,250,000" }, pdfSent: { from: v.values.pdfSent, to: true }, draftDate: { from: v.values.draftDate, to: "2026-01-05" } });
  ok(r.saved && r.key === 16 && book.Tracker[loc.row][T.cols.amount] === "1250000" && book.Tracker[loc.row][T.cols.pdfSent] === "TRUE" && book.Tracker[loc.row][T.cols.draftDate] === "2026-01-05", "funding and process fields are written as the sheet expects: " + JSON.stringify(r));
  const p16 = parsePipTab(book.Tracker).pips.find((p) => p.pip === 16);
  ok(p16.amount.value === 1250000 && p16.pdfSent === true && p16.draftDate === "2026-01-05", "and read back by the build: " + JSON.stringify(p16.amount));
  ok((await core.savePip(16, { amount: { from: "1250000", to: "lots" } })).error, "an amount that is not a number is refused");
  const w0 = book.Tracker[T.headerRow].length;
  r = await core.savePip(16, { authUsdc: { from: "", to: "5000" } });
  const cAuth = SM.colIndex(book.Tracker[T.headerRow], "Authorized USDC");
  ok(r.saved && cAuth >= 0 && book.Tracker[loc.row][cAuth] === "5000" && parsePipTab(book.Tracker).pips.find((p) => p.pip === 16).authorizedUsdc.value === 5000, "a missing Authorized USDC column is added on the first value: " + cAuth + " / " + w0);
  ok((await core.savePip(16, { pipNo: { from: "PIP-16", to: "1" } })).error?.includes("already has a row"), "a PIP number cannot be given twice");

  // A draft: no number, gets a Draft ID, fills the first empty prepared row.
  const blank = book.Tracker.findIndex((row, i) => i > T.headerRow && row.every((c) => !SM.clean(c) || /^false$/i.test(SM.clean(c))));
  r = await core.addPip({ name: "Council expense wallet", phase: "Draft", status: "Actionable", draftDate: "2026-11-07", step: "2", pdfSent: false, mdSent: false, amount: "50000", currency: "USDC", eco: "NO", category: "DAO Treasury", sacTerm: "SAC-3" });
  const cId = SM.colIndex(book.Tracker[T.headerRow], "Draft ID");
  ok(r.saved && /^D[0-9A-Z]+$/.test(r.key) && cId >= 0 && (blank < 0 || book.Tracker[blank][cId] === r.key), "Add PIP without a number: a Draft ID, in the first empty row " + blank + ": " + JSON.stringify(r));
  const parsed = parsePipTab(book.Tracker);
  const d = parsed.drafts.find((x) => x.draftId === r.key);
  ok(d && d.name === "Council expense wallet" && d.phase === "Draft" && d.step === "2" && d.amount.value === 50000 && d.currency === "USDC" && d.ecosystemFund === false && d.draftDate === "2026-11-07", "the draft is read back by the build: " + JSON.stringify(d));
  ok(parsed.drafts.some((x) => x.phase === "Withdrawn" && !x.draftId), "withdrawn rows without a number are read as drafts too");
  ok((await core.addPip({ name: "" })).error && (await core.addPip({ name: "x", pipNo: "16" })).error?.includes("already"), "Add PIP needs a name and a free number");

  // An old row without a Draft ID is found by its name and gets one on the first save.
  const old = parsed.drafts.find((x) => !x.draftId);
  r = await core.savePip(`name:${old.name}`, { step: { from: old.step, to: "5" } });
  ok(r.saved && /^D/.test(r.key) && parsePipTab(book.Tracker).drafts.find((x) => x.name === old.name).draftId === r.key, "a draft found by name gets its Draft ID on save: " + JSON.stringify(r));
  // Rename, then assign the number once the vote is up.
  const dv = await core.readPip(d.draftId);
  r = await core.savePip(d.draftId, { name: { from: dv.values.name, to: "Council expense wallet v2" } });
  ok(r.saved && r.key === d.draftId && parsePipTab(book.Tracker).drafts.find((x) => x.draftId === d.draftId).name === "Council expense wallet v2", "a draft keeps its Draft ID through a rename");
  r = await core.savePip(d.draftId, { pipNo: { from: "", to: "99" } });
  ok(r.saved && r.key === 99 && parsePipTab(book.Tracker).pips.some((p) => p.pip === 99 && p.name === "Council expense wallet v2"), "assigning a number turns the draft into PIP-99");
  r = await core.addPip({ name: "Numbered right away", pipNo: "98", phase: "Voting" });
  ok(r.saved && r.key === 98 && parsePipTab(book.Tracker).pips.some((p) => p.pip === 98), "Add PIP with a number");
  book.Tracker = saved;
}

// ---------- payment labels: create tab, append, round-trip through the build's importer ----------
r = await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-28", confirmed: true });
ok(r.saved && book["Payment labels"]?.[0]?.join() === SM.LABEL_HEADERS.join(), "labels tab created with headers");
await core.addLabel({ signature: "SIG2", recipient: "", pip: "internal", confirmed: false });
ok(book["Payment labels"].length === 3, "second label appended, tab not recreated");
ok((await core.addLabel({ signature: "SIG3", pip: "28" })).error, "invalid label refused");
r = await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-29", confirmed: false });
ok(r.updated && book["Payment labels"].length === 3 && book["Payment labels"][1][2] === "PIP-29" && book["Payment labels"][1][3] === "FALSE", "relabelling updates the row instead of adding one");
ok((await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "Foundation", confirmed: true, fiscalYear: "last year" })).error, "a fiscal year that is not a year is refused");
r = await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-29", confirmed: false, fiscalYear: "2024" });
ok(r.updated && book["Payment labels"][1][4] === "2024" && parseLabelTab(book["Payment labels"])[0].fiscalYear === "2024", "the fiscal year is saved and read back by the build");
{
  // A tab made before the column existed: the header is added on the first fiscal year saved.
  const saved = book["Payment labels"];
  book["Payment labels"] = [["Signature", "Recipient", "PIP", "Confirmed"], ["OLD", "", "Foundation", "TRUE"]];
  r = await core.addLabel({ signature: "OLD", recipient: "", pip: "Foundation", confirmed: true, fiscalYear: "2025" });
  ok(r.updated && book["Payment labels"][0][4] === "Fiscal year" && book["Payment labels"][1][4] === "2025" && parseLabelTab(book["Payment labels"])[0].fiscalYear === "2025", "an old tab gets the Fiscal year column: " + JSON.stringify(book["Payment labels"]));
  book["Payment labels"] = saved;
}
r = await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-29", confirmed: false });
book["Payment labels"].push(["SIG1", "OWNER1", "not a payout", "TRUE"]); // a duplicate row, e.g. typed into the sheet
r = await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-28", confirmed: true });
ok(r.updated && r.removed === 1 && book["Payment labels"].length === 3 && book["Payment labels"].filter((x) => x[0] === "SIG1").length === 1 && book["Payment labels"][1][2] === "PIP-28", "relabelling removes duplicate rows for the payout: " + JSON.stringify(book["Payment labels"]));
r = await core.addLabel({ signature: "SIG4", recipient: "OWNER4", pip: "PIP-28", confirmed: true });
book["Payment labels"].push(["SIG4", "OWNER4", "Foundation", "TRUE"]); // a duplicate row typed into the sheet
r = await core.removeLabel({ signature: "SIG4", recipient: "OWNER4" });
ok(r.removed === 2 && !book["Payment labels"].some((x) => x[0] === "SIG4") && book["Payment labels"].length === 3, "removing a label deletes every row for that payout and nothing else: " + JSON.stringify(book["Payment labels"]));
ok((await core.removeLabel({ signature: "NOPE", recipient: "" })).removed === 0, "removing a label that does not exist changes nothing");
const labels = parseLabelTab(book["Payment labels"]);
ok(labels.length === 2 && labels[0].label === "PIP-28" && labels[0].confirmed === true && labels[0].recipient === "OWNER1" && labels[1].confirmed === false, "build reads the labels back: " + JSON.stringify(labels));

// ---------- council members: seed from the dashboard record, round-trip ----------
const D = JSON.parse(fs.readFileSync(path.join(ROOT, "dist", "data", "dashboard.json"), "utf8"));
const terms = D.councilTerms.terms;
r = await core.addMember({ name: "Too early", start: "2027-01-01" });
ok(r.error?.includes("first") && !book["Council members"], "adding a member before the tab exists is refused (would hide the history)");
r = await core.seedMembers(terms);
const expectedRows = terms.reduce((s, t) => s + t.members.length, 0);
ok(r.saved && r.rows === expectedRows && book["Council members"].length === expectedRows + 1, `members tab seeded with ${expectedRows} rows`);
ok((await core.seedMembers(terms)).error?.includes("already exists"), "seeding twice refused");
ok((await core.addMember({ name: "", start: "2027-01-01" })).error, "member without a name refused");
ok((await core.addMember({ name: "X", start: "11/10/2026" })).error, "member with a non-ISO date refused");
const members = parseMembersTab(book["Council members"]);
const back = councilTerms({ sheetMembers: members, proposals: [], history: { terms: [] } });
const names = (ts) => ts.map((t) => `${t.label}:${t.members.map((m) => m.name).join("|")}`).sort().join(" / ");
ok(names(back.terms) === names(terms), "build reads the seeded members back as the same terms");
ok(back.terms.every((t) => { const o = terms.find((x) => x.label === t.label); return o && o.start === t.start && o.end === t.end; }), "term dates survive the round trip");
const t2 = back.terms.find((t) => t.label === "Term 2");
ok(t2?.members.find((m) => m.name === "Emperor ===[]")?.role === "Council Chair", "roles survive the round trip");
r = await core.addMember({ name: "New Member", role: "Council member", term: "Term 5", start: "2027-07-11", end: "2028-04-11", electedIn: 40, x: "@newbie" });
ok(r.saved && book["Council members"].length === expectedRows + 2, "member added once the tab exists");
const addedBack = parseMembersTab(book["Council members"]).find((m) => m.name === "New Member");
ok(addedBack?.start === "2027-07-11" && addedBack.electedIn === 40 && addedBack.x === "newbie", "added member reads back correctly: " + JSON.stringify(addedBack));

// A term typed as "4" belongs to the same Council as "Term 4", and shares its dates.
const merged = councilTerms({ sheetMembers: [
  { name: "A", term: "Term 4", start: "2026-10-11", end: "2027-07-11" },
  { name: "B", term: "4", start: "2026-10-11", end: null },
] }).terms;
ok(merged.length === 1 && merged[0].label === "Term 4" && merged[0].members.length === 2 && merged[0].end === "2027-07-11", "term 4 spellings merge: " + JSON.stringify(merged.map((t) => t.label)));

// ---------- sign-in must not depend on Google's file picker (it fails with several accounts signed in) ----------
const editorSrc = fs.readFileSync(path.join(ROOT, "site", "editor.js"), "utf8");
ok(!/picker|apis\.google\.com/i.test(editorSrc), "no file picker in the editor");
ok(!/drive/i.test((editorSrc.match(/const SCOPE = "[^"]*"/) || ["drive"])[0]), "sign-in asks for no Drive permission (only the owner's first upload does)");
ok(editorSrc.includes("auth/spreadsheets"), "editor asks for the spreadsheet permission");

// ---------- "Update now" writes the request time into the Dashboard tab ----------
r = await core.requestUpdate("editor@example.org");
ok(r.saved && book.Dashboard && book.Dashboard[0][0].startsWith("Last update requested") && book.Dashboard[1][0] === r.at && book.Dashboard[1][1] === "editor@example.org", "update request creates the Dashboard tab and writes time + editor: " + JSON.stringify(book.Dashboard));
await core.requestUpdate("other@example.org");
ok(book.Dashboard.length === 2 && book.Dashboard[1][1] === "other@example.org", "a second request overwrites the same cell instead of adding rows");

// ---------- no access ----------
access = false;
ok((await core.canAccess()) === false, "no access is reported, not thrown");
const ac = await core.accessCheck();
ok(ac.ok === false && ac.status === 403 && ac.message.includes("permission"), "refusal carries Google's status and message: " + JSON.stringify(ac));
access = true;

// The Tracker the editor wrote must still be readable by the build.
const csvBack = book.Tracker.map((row) => row.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
const parsed = parsePipTab(parseCSV(csvBack));
ok(parsed.pips.length === 36 && parsed.pips.find((p) => p.pip === 16).note === "Mine", "build still parses the edited Tracker");

// ---------- wallets: name, auto label, tracked balance ----------
const FOUND = "B5hX2Aj8FYmdYjXQFVF1jpz7BkrdpLXgSPs92G6DFGjA";
ok((await core.saveWallet({ wallet: "not-an-address", name: "X" })).error, "invalid wallet address refused");
ok((await core.saveWallet({ wallet: FOUND, name: "" })).error, "wallet name required");
ok((await core.saveWallet({ wallet: FOUND, name: "Foundation", label: "PIP 3" })).error, "invalid auto label refused");
r = await core.saveWallet({ wallet: FOUND, name: "Foundation", label: "Foundation", track: false });
ok(r.saved && !r.updated && book.Wallets[0].join() === SM.WALLET_HEADERS.join() && book.Wallets.length === 2, "Wallets tab created with the first wallet");
r = await core.saveWallet({ wallet: FOUND, name: "Star Atlas Foundation", label: "Foundation", track: true, note: "legal entity" });
ok(r.updated && book.Wallets.length === 2 && book.Wallets[1][1] === "Star Atlas Foundation" && book.Wallets[1][3] === "TRUE", "saving a listed wallet updates its row: " + JSON.stringify(book.Wallets));
// A tab made before the rename calls the column "Label": saving still writes the payout label there.
{
  const keep = book.Wallets;
  book.Wallets = [["Wallet", "Name", "Label", "Track balance", "Note"], [FOUND, "Old", "", "FALSE", ""]];
  r = await core.saveWallet({ wallet: FOUND, name: "Old", label: "Foundation", track: false, note: "" });
  ok(r.updated && book.Wallets[1][2] === "Foundation", "an old Wallets tab with a Label column still gets the payout label: " + JSON.stringify(book.Wallets));
  ok(parseWalletsTab(book.Wallets)[0].label === "Foundation", "the build reads the payout label from an old Label column");
  book.Wallets = keep;
}
const walletsBack = parseWalletsTab([...book.Wallets, ["bad", "Ignored", "", "TRUE", ""], [FOUND, "Duplicate", "", "", ""]]);
ok(walletsBack.length === 1 && walletsBack[0].track === true && walletsBack[0].label === "Foundation" && walletsBack[0].note === "legal entity", "build reads the Wallets tab back; invalid and repeated addresses are skipped");

// ---------- a wallet reused for a new purpose (one row per purpose, "Since") ----------
{
  const keep = book.Wallets;
  const MS = "AGefCMwaVHvn6VhYMcWLLz2JTGa6DkmdpQbkv82eMyuK";
  book.Wallets = [["Wallet", "Name", "Payout label", "Track balance", "Note"], [MS, "Arty's SLYA hosting", "PIP-24", "TRUE", ""]];
  ok((await core.saveWallet({ wallet: MS, name: "Atom", label: "PIP-30", reuse: true })).error?.includes("Since"), "reusing a wallet needs its Since");
  ok((await core.saveWallet({ wallet: MS, name: "Atom", label: "PIP-30", since: "soon", reuse: true })).error, "Since must be a PIP or a date");
  r = await core.saveWallet({ wallet: MS, name: "Atom", label: "PIP-30", track: true, since: "pip-30", reuse: true });
  ok(r.saved && r.added === "purpose" && book.Wallets[0][5] === "Since" && book.Wallets.length === 3 && book.Wallets[2][5] === "PIP-30", "reuse adds a row and the Since column: " + JSON.stringify(book.Wallets));
  ok((await core.saveWallet({ wallet: MS, name: "Again", since: "PIP-30", reuse: true })).error?.includes("already"), "the same purpose cannot be added twice");
  await core.saveWallet({ wallet: MS, name: "Dashboard", label: "PIP-36", track: true, since: "PIP-36", reuse: true });
  r = await core.saveWallet({ wallet: MS, name: "Atom (ATOM PIP)", label: "PIP-30", track: true, since: "PIP-30", at: "PIP-30" });
  ok(r.updated && book.Wallets[2][1] === "Atom (ATOM PIP)" && book.Wallets[1][1] === "Arty's SLYA hosting" && book.Wallets[3][1] === "Dashboard", "editing changes only the purpose being edited");
  const rows = parseWalletsTab(book.Wallets);
  ok(rows.length === 3 && rows.map((w) => w.since).join() === ",PIP-30,PIP-36", "the build reads every purpose of a wallet: " + JSON.stringify(rows.map((w) => w.since)));
  // Payouts get the purpose in force at their time.
  const from = { "": null, "PIP-30": 1760000000, "PIP-36": 1790000000 };
  const wal = rows.map((w) => ({ ...w, from: from[w.since] }));
  const leg = (sig, t) => ({ sig, t, account: "fund", symbol: "ATLAS", delta: -1000, legs: [{ owner: MS, amount: 1000 }] });
  const rec = reconcile({ pips: [], ledger: { rows: [leg("A", 1750000000), leg("B", 1770000000), leg("C", 1795000000)] }, labels: [], wallets: wal, config: { accounts: { fund: { label: "Ecosystem Fund" } } } });
  const pipOfLeg = (s) => rec.legs.find((l) => l.sig === s)?.pip;
  ok(pipOfLeg("A") === 24 && pipOfLeg("B") === 30 && pipOfLeg("C") === 36, "each payout to a reused wallet gets the purpose of its time: " + ["A", "B", "C"].map(pipOfLeg).join());
  book.Wallets = keep;
}

// ---------- multisig check: a Squads transaction in which the wallet SENDS ----------
{
  const W = "9q3ZZnezQyVXvBKYkKwjxpvVVPp7CFY9VYbaW5gBhX7Y", SQ = "SMPLecH534NA9acpos4G6x7uf3LWbCAwZQE9e8ZekMu", MSA = "5hr6YecyRMFb3eb4SLL863TYb6nQUYYzGpCNsTwSoVZm";
  const tx = (pre, post, keys = [{ pubkey: "member", signer: true }, { pubkey: SQ }, { pubkey: MSA }, { pubkey: W }]) => ({ transaction: { message: { accountKeys: keys } }, meta: { preBalances: [1, 0, 0, 5], postBalances: [1, 0, 0, 5], preTokenBalances: [{ accountIndex: 4, owner: W, uiTokenAmount: { uiAmountString: String(pre) } }], postTokenBalances: [{ accountIndex: 4, owner: W, uiTokenAmount: { uiAmountString: String(post) } }] } });
  const hit = squadsSend(tx(100, 40), W, new Set([MSA]));
  ok(hit && hit.program === "Squads v3" && hit.account === MSA, "a payout from the wallet through Squads marks it as a multisig vault: " + JSON.stringify(hit));
  ok(!squadsSend(tx(40, 100), W, new Set([MSA])), "receiving through Squads (e.g. a DAO Treasury payout) does not");
  ok(!squadsSend(tx(100, 40, [{ pubkey: "member", signer: true }, { pubkey: W }]), W), "sending without Squads does not");
}

// Auto labels: every payout to a labelled wallet gets the label; a payout's own label wins.
{
  const leg = (sig) => ({ sig, t: 1, account: "treasury", symbol: "USDC", delta: -100, legs: [{ owner: FOUND, amount: 100 }] });
  const rec = reconcile({ pips: [], ledger: { rows: [leg("A"), leg("B"), { ...leg("C"), delta: 100 }] }, labels: [{ signature: "B", recipient: "", label: "not a payout", confirmed: true }], wallets: walletsBack, config: { accounts: { treasury: { label: "DAO Treasury" } } } });
  const by = Object.fromEntries(rec.legs.map((l) => [l.sig, l]));
  ok(by.A.confidence === "category" && by.A.category === "Foundation" && /wallet label/.test(by.A.reason), "payout to a labelled wallet gets the wallet's label");
  ok(by.B.confidence === "internal" && by.B.labelled, "a payout's own label overrides the wallet label");
  ok(by.C.confidence !== "category", "inflows from the wallet are not labelled");
  const mixed = reconcile({ pips: [], ledger: { rows: [leg("A"), leg("B"), leg("D")] }, labels: [{ signature: "B", recipient: "", label: "Foundation", confirmed: true }, { signature: "D", recipient: "", label: "Foundation", confirmed: true }], wallets: [{ wallet: FOUND, name: "F", label: "foundation" }], config: { accounts: { treasury: { label: "DAO Treasury" } } } });
  ok(mixed.legs.every((l) => l.category === "Foundation"), "category names are case-insensitive and merge under the most used spelling");
  // A sender splitting one transfer between the DAO and someone else: only the DAO's share is income.
  const split = reconcile({ pips: [], ledger: { rows: [{ sig: "S", t: 1, account: "treasury", symbol: "ATLAS", delta: 330, legs: [{ owner: FOUND, amount: 1000 }] }] }, config: { accounts: { treasury: { label: "DAO Treasury" } } } });
  ok(split.legs[0].amount === 330, "an inflow counts what the DAO received, not the sender's whole transfer: " + split.legs[0].amount);
  // Automatic matches respect dates: a payout before a PIP's vote started is never matched to it.
  const PAYEE = "So11111111111111111111111111111111111111112";
  const mkPip = (pip, voteStart) => ({ pip, voteResult: "Passed", phase: "", amount: { value: 1000 }, currency: "ATLAS", paidAtlas: { state: "blank", value: null }, paidUsdc: { state: "blank", value: null }, milestonesDone: { value: null }, milestonesTotal: { value: null }, voteStart });
  const early = reconcile({ pips: [mkPip(50, "2026-06-26")], ledger: { rows: [
    { sig: "E1", t: Date.parse("2024-10-11") / 1000, account: "treasury", symbol: "ATLAS", delta: -1000, legs: [{ owner: PAYEE, amount: 1000 }] },
    { sig: "E2", t: Date.parse("2026-07-20") / 1000, account: "treasury", symbol: "ATLAS", delta: -1000, legs: [{ owner: PAYEE, amount: 1000 }] },
  ] }, config: { accounts: { treasury: { label: "DAO Treasury" } } } });
  const eb = Object.fromEntries(early.legs.map((l) => [l.sig, l]));
  ok(eb.E2.pip === 50 && eb.E1.pip == null, "a payout from before a PIP's vote is not matched to it, by amount or by recipient: " + JSON.stringify([eb.E1.confidence, eb.E1.pip, eb.E2.pip]));
  const unk = reconcile({ pips: [mkPip(50, "2020-01-01")], ledger: { rows: [{ sig: "U1", t: Date.parse("2026-07-20") / 1000, account: "treasury", symbol: "ATLAS", delta: -1000, legs: [{ owner: PAYEE, amount: 1000 }] }] }, labels: [{ signature: "U1", recipient: PAYEE, label: "unknown", confirmed: true }], config: { accounts: { treasury: { label: "DAO Treasury" } } } });
  ok(unk.legs[0].pip == null && unk.legs[0].confidence === "unlabelled" && unk.legs[0].labelled, "the label unknown clears an automatic match");
  // A split PIP (Authorized USDC + Authorized ATLAS) is paid and owed per currency.
  {
    const sp = { ...mkPip(60, "2020-01-01"), currency: "USDC", amount: { value: 469514 }, authorizedUsdc: { value: 352135.15 }, authorizedAtlas: { value: 753707176 } };
    const rows = [
      { sig: "S1", t: 2, account: "treasury", symbol: "USDC", delta: -176067.57, legs: [{ owner: PAYEE, amount: 176067.57 }] },
      { sig: "S2", t: 2, account: "treasury", symbol: "ATLAS", delta: -376853588, legs: [{ owner: PAYEE, amount: 376853588 }] },
    ];
    const r60 = reconcile({ pips: [sp], ledger: { rows }, labels: [{ signature: "S1", recipient: PAYEE, label: "PIP-60", confirmed: true }, { signature: "S2", recipient: PAYEE, label: "PIP-60", confirmed: true }], config: { accounts: { treasury: { label: "DAO Treasury" } } } }).summary[0];
    ok(r60.remainingBy.USDC === 176067.58 && r60.remainingBy.ATLAS === 376853588 && r60.state === "partly-paid" && r60.remaining == null && r60.remainingNote == null, "a split PIP's remaining is per currency: " + JSON.stringify(r60.remainingBy));
  }
  // Labelled inflows: a category names the source; a PIP marks a return, never money paid.
  const inl = reconcile({ pips: [], ledger: { rows: [{ sig: "I1", t: 1, account: "treasury", symbol: "USDC", delta: 500, legs: [{ owner: FOUND, amount: 500 }] }, { sig: "I2", t: 2, account: "treasury", symbol: "USDC", delta: 70, legs: [{ owner: FOUND, amount: 70 }] }] }, labels: [{ signature: "I1", recipient: FOUND, label: "Initial funding", confirmed: true }, { signature: "I2", recipient: FOUND, label: "PIP-28", confirmed: true }], config: { accounts: { treasury: { label: "DAO Treasury" } } } });
  const il = Object.fromEntries(inl.legs.map((l) => [l.sig, l]));
  ok(il.I1.confidence === "category" && il.I1.category === "Initial funding" && il.I1.labelled, "an inflow labelled with a category keeps it as its source");
  ok(il.I2.pip === 28 && il.I2.isReturn === true, "an inflow labelled with a PIP is a return for that PIP, not a payout");
}

// ---------- payment documents: several files per payout, one row each ----------
ok((await core.listDocs()).length === 0, "no documents before the tab exists");
await core.addDoc({ signature: "SIGD", recipient: "", file: "2025-12-18 a.pdf", link: "https://drive/1", by: "owner@example.org" });
await core.addDoc({ signature: "SIGD", recipient: "", file: "2025-12-18 b.pdf", link: "https://drive/2", by: "owner@example.org" });
const docList = await core.listDocs();
ok(docList.length === 2 && docList[1].link === "https://drive/2" && docList[0].by === "owner@example.org" && docList[0].file === "2025-12-18 a.pdf", "two documents on one payout: " + JSON.stringify(book["Payment documents"]));

// ---------- meeting minutes ----------
{
  const text = "# Minutes\n- PIP-36 approved\n= result 4:0\n\n> quote";
  ok((await core.saveMinutes({ day: "3.11.2026", text })).error, "a date that is not YYYY-MM-DD is refused");
  ok((await core.saveMinutes({ day: "2026-11-03", text: "  " })).error, "empty minutes refused");
  ok((await core.saveMinutes({ day: "2026-11-03", text: "x".repeat(50001) })).error?.includes("50,000"), "minutes over one sheet cell refused");
  let m = await core.saveMinutes({ day: "2026-11-03", title: "", text });
  ok(m.saved && !m.updated && book["Meeting minutes"] && m.gid === String(Object.keys(book).indexOf("Meeting minutes")), "first minutes create the tab and return its gid: " + JSON.stringify(m));
  ok(book["Meeting minutes"][1][2] === text, "minutes keep their line breaks, and lines like '- ' or '= ' stay text");
  const back = parseMinutesTab(book["Meeting minutes"]);
  ok(back.length === 1 && back[0].day === "2026-11-03" && back[0].text === text, "the build reads the minutes back as written");
  m = await core.saveMinutes({ day: "2026-11-03", text: "other" });
  ok(m.conflict?.sheet === text && book["Meeting minutes"][1][2] === text, "new minutes for a day that already has some: conflict, nothing written");
  book["Meeting minutes"][1][2] = text + "\nedited in the sheet";
  m = await core.saveMinutes({ day: "2026-11-03", text: text + "\nmine", from: text });
  ok(m.conflict && book["Meeting minutes"][1][2].endsWith("in the sheet"), "a change in the sheet since opening is a conflict");
  m = await core.saveMinutes({ day: "2026-11-03", text: text + "\nmine", from: text }, { force: true });
  ok(m.saved && m.updated && book["Meeting minutes"][1][2].endsWith("mine") && book["Meeting minutes"].length === 2, "overwrite updates the same row");
  m = await core.saveMinutes({ day: "2026-10-28", title: "Council meeting (recording failed)", text: "notes" });
  ok(m.saved && parseMinutesTab(book["Meeting minutes"]).length === 2, "a second day appends a row");
  ok(parseMinutesTab([["Date", "Title", "Minutes", "Show"], ["11/3/2026", "", "a", "TRUE"], ["2026-11-03", "", "dupe", ""], ["2026-11-04", "", "hidden", "FALSE"], ["", "", "no date", ""]]).map((x) => x.text).join() === "a", "US dates read, one entry per day, hidden and dateless rows skipped");

  // Minutes attach to the recording of the same day; without one they are a meeting of their own.
  const store = { videos: { V1: { id: "V1", title: "Star Atlas DAO Council (Term #4) Meeting - November 3, 2026", published: "2026-11-04T10:00:00Z", description: "", views: 5 } } };
  const V = councilVideos({ store, terms: [{ label: "Term 4", start: "2026-10-11" }], minutes: [{ day: "2026-11-03", title: "", text: "PIP-36 approved" }, { day: "2026-10-28", title: "Recording failed", text: "notes on PIP-40" }] });
  ok(V.meetings.length === 2 && V.meetings[0].id === "V1" && V.meetings[0].minutes === "PIP-36 approved" && V.meetings[0].pips.includes(36), "minutes attach to the same day's recording, and their PIPs count");
  ok(V.meetings[1].noRecording && V.meetings[1].url === null && V.meetings[1].title === "Recording failed" && V.meetings[1].term === "Term 4" && V.meetings[1].pips.includes(40), "minutes without a recording are a meeting of their own");
}

// ---------- upcoming payments ----------
{
  ok((await core.addUpcoming({ due: "1.12.2026", account: "treasury", for: "Operating costs", amount: "100" })).error, "a due date that is not YYYY-MM-DD is refused");
  ok((await core.addUpcoming({ due: "2026-12-01", account: "treasury", for: "Operating costs", amount: "0" })).error, "an amount of 0 is refused");
  ok((await core.addUpcoming({ due: "2026-12-01", account: "", for: "Operating costs", amount: "100" })).error, "the paying account is required");
  let u = await core.addUpcoming({ due: "2026-12-01", account: "treasury", for: "Operating costs", fiscalYear: "2027", amount: "1,234.50", currency: "USDC", description: "- annual fees" });
  ok(u.saved && /^U[0-9A-Z]+$/.test(u.id) && u.gid != null && book["Upcoming payments"]?.[0]?.join() === SM.UPCOMING_HEADERS.join(), "first upcoming payment creates the tab with an ID: " + JSON.stringify(u));
  const back = parseUpcomingTab(book["Upcoming payments"]);
  ok(back.length === 1 && back[0].id === u.id && back[0].due === "2026-12-01" && back[0].account === "treasury" && back[0].amount === 1234.5 && back[0].fiscalYear === "2027" && back[0].description === "- annual fees" && !back[0].paidBy, "the build reads it back as written: " + JSON.stringify(back[0]));
  ok((await core.updateUpcoming(u.id, { due: "2026-12-02", account: "treasury", for: "Foundation", fiscalYear: "2027", amount: "1234.50", currency: "USDC", description: "annual fees" })).updated, "an upcoming payment can be edited");
  const edited = parseUpcomingTab(book["Upcoming payments"])[0];
  ok(edited.id === u.id && edited.for === "Foundation" && edited.due === "2026-12-02" && edited.description === "annual fees", "the edit keeps its ID and changes the fields: " + JSON.stringify(edited));
  ok((await core.updateUpcoming("UNKNOWN", { due: "2026-12-02", account: "treasury", for: "Foundation", amount: "1" })).error, "editing an ID that is not in the sheet is refused");
  const extra = await core.addUpcoming({ due: "2027-01-15", account: "treasury", for: "Hosting", amount: "50" });
  ok((await core.deleteUpcoming(extra.id)).deleted && parseUpcomingTab(book["Upcoming payments"]).map((x) => x.id).join() === u.id, "deleting removes only that row");
  ok((await core.markUpcomingPaid(u.id, "not-a-signature")).error, "marking paid needs a transaction signature");
  const SIG = "5".repeat(88);
  ok((await core.markUpcomingPaid(u.id, SIG)).saved && parseUpcomingTab(book["Upcoming payments"])[0].paidBy === SIG, "marking paid stores the payout's transaction");

  // Budget: an unpaid Foundation invoice counts in its fiscal year and comes off the Treasury on its due date.
  const rules = { foundation: [{ from: "2024-07-23", pip: 2, budgetUsdPerYear: 100000 }], fund: [{ from: "2024-08-06", pip: 4, pipLimitPercent: 5, pipLimitBasis: "lastRefill", targetSharePercent: 20, usdcThreshold: 500000, usdcSharePercent: 20, refillDates: ["03-31", "06-30", "09-30", "12-31"] }] };
  const base = { accounts: { treasury: { now: { ATLAS: 1000, USDC: 50000 } }, fund: { now: { ATLAS: 100 } } }, rules, settings: { foundationCategories: ["Operating costs"], projectRefills: 2 }, nowTs: Date.parse("2026-11-06T00:00:00Z") / 1000 };
  const inv = { id: "U1", due: "2026-12-01", account: "treasury", for: "Operating costs", fiscalYear: "2027", amount: 12000, currency: "USDC", description: "", paidBy: null };
  const without = budgetOf(base), withInv = budgetOf({ ...base, upcoming: [inv] });
  ok(withInv.foundation.years.find((y) => y.year === "2027")?.upcoming === 12000, "the invoice counts in fiscal year 2027 of the Foundation budget");
  const dec = (b) => b.projection.find((s) => s.date === "2026-12-31").treasuryUSDC;
  ok(dec(without) - dec(withInv) === 12000, "the projection takes it off the Treasury's USDC by its due date");
  ok(budgetOf({ ...base, upcoming: [{ ...inv, paidBy: SIG }] }).upcoming.length === 0, "a paid entry leaves the upcoming list");

  // Repeating payments: saved with Repeats and Until, each Mark paid adds one transaction and moves the next due date.
  ok((await core.addUpcoming({ due: "2026-12-01", account: "treasury", for: "Council expenses", amount: "1000", until: "2027-03-01" })).error, "Until without Repeats is refused");
  ok((await core.addUpcoming({ due: "2026-12-01", account: "treasury", for: "Council expenses", amount: "1000", repeats: "Monthly", until: "2026-11-01" })).error, "Until before Due is refused");
  const rp = await core.addUpcoming({ due: "2026-11-30", account: "treasury", for: "Council expenses", fiscalYear: "2026", amount: "1000", repeats: "Monthly", until: "2027-02-28" });
  const findR = () => parseUpcomingTab(book["Upcoming payments"]).find((x) => x.id === rp.id);
  let r1 = findR();
  ok(rp.saved && r1.every === 1 && r1.repeats === "monthly" && r1.until === "2027-02-28" && r1.next === "2026-11-30" && !r1.fiscalYear && !r1.paidBy, "a monthly payment reads back with its end date and no fixed fiscal year: " + JSON.stringify(r1));
  const SIG2 = "6".repeat(88), SIG3 = "7".repeat(88);
  ok((await core.markUpcomingPaid(rp.id, SIG2)).count === 1 && findR().next === "2026-12-30", "the first payment moves the next due date on by a month");
  ok((await core.markUpcomingPaid(rp.id, SIG2)).error, "the same payout cannot be recorded twice");
  ok((await core.markUpcomingPaid(rp.id, SIG3)).count === 2 && findR().paid.join() === [SIG2, SIG3].join() && findR().paidYears.join() === "2026,2026", "a second payment is added, each with the year it was due");
  // A tab made before Repeats and Until existed gets the columns on the next save.
  const old = SM.UPCOMING_HEADERS.slice(0, 9);
  book["Upcoming payments"] = [old, ["U1", "'2026-12-01", "DAO Treasury", "Hosting", "", "50", "USDC", "", ""]];
  ok((await core.updateUpcoming("U1", { due: "2026-12-01", account: "treasury", for: "Hosting", amount: "50", repeats: "Yearly" })).updated && book["Upcoming payments"][0].slice(9).join() === "Repeats,Until" && parseUpcomingTab(book["Upcoming payments"])[0].repeats === "yearly", "missing Repeats/Until columns are added before saving: " + JSON.stringify(book["Upcoming payments"][0]));

  // Budget: every monthly due date comes off the Treasury; done once the next date passes Until; Foundation years per due date.
  const mo = { id: "R1", due: "2026-12-15", every: 1, repeats: "monthly", until: null, next: "2026-12-15", paid: [], account: "treasury", for: "Operating costs", amount: 1000, currency: "USDC", description: "", paidBy: null };
  const withMo = budgetOf({ ...base, upcoming: [mo] });
  ok(dec(without) - dec(withMo) === 1000, "by 2026-12-31 one monthly payment is taken");
  const mar = (b) => b.projection.find((s) => s.date === "2027-03-31").treasuryUSDC;
  ok(mar(without) - mar(withMo) === 4000, "by 2027-03-31 four monthly payments are taken");
  ok(mar(without) - mar(budgetOf({ ...base, upcoming: [{ ...mo, until: "2027-01-31" }] })) === 2000, "it stops after its end date");
  ok(withMo.upcoming.length === 1 && withMo.upcoming[0].due === "2026-12-15" && withMo.recurringMonthly === 1000, "it is listed once, at its next due date");
  ok(withMo.foundation.years.find((y) => y.year === "2026")?.upcomingCount === 1 && withMo.foundation.years.find((y) => y.year === "2027")?.upcomingCount === 10, "Foundation budget: each due date counts in its own year (12 months ahead)");
  // Its category's past average is replaced, not added to.
  const paid12 = Array.from({ length: 12 }, (_, i) => ({ sig: "p" + i, t: Date.UTC(2025, 10 + i, 10) / 1000, account: "treasury", direction: "out", symbol: "USDC", amount: 500, category: "Operating costs", confidence: "labelled" }));
  const hist = budgetOf({ ...base, payments: paid12 }), histMo = budgetOf({ ...base, payments: paid12, upcoming: [mo] });
  ok(hist.rate.tU === -500 && histMo.rate.tU === 0 && histMo.replaced.categories.join() === "Operating costs", "a repeating payment replaces its category's average in the projection: " + hist.rate.tU + " / " + histMo.rate.tU);
}

// ---------- PIP milestones and checklists ----------
{
  ok((await core.addMilestone({ pip: 36, n: "x", name: "Beta" })).error, "a milestone needs a number");
  ok((await core.addMilestone({ pip: 36, n: "1", name: "" })).error, "a milestone needs a name");
  const m1 = await core.addMilestone({ pip: 36, n: "1", name: "Beta release", amount: "5,000,000", currency: "ATLAS" });
  const m2 = await core.addMilestone({ pip: 36, n: "2", name: "Launch", amount: "", currency: "ATLAS" });
  ok(m1.saved && /^M[0-9A-Z]+$/.test(m1.id) && m1.id !== m2.id && book["PIP milestones"][0].join() === SM.MILESTONE_HEADERS.join(), "the first milestone creates the tab: " + JSON.stringify(m1));
  let ms = parseMilestonesTab(book["PIP milestones"]);
  ok(ms.length === 2 && ms[0].pip === 36 && ms[0].n === 1 && ms[0].name === "Beta release" && ms[0].amount === 5000000 && ms[0].currency === "ATLAS" && !ms[1].amount && !ms[1].currency, "milestones read back as written: " + JSON.stringify(ms));
  ok((await core.updateMilestone(m2.id, { pip: 36, n: "2", name: "Public launch", amount: "1000", currency: "USDC" })).updated && parseMilestonesTab(book["PIP milestones"])[1].name === "Public launch", "a milestone can be edited");

  ok((await core.addCheckItem({ pip: 36, list: "", item: "x" })).error, "an item needs a checklist name");
  ok((await core.addCheckItem({ pip: 36, list: "KPIs", item: "x", evidence: "not a link" })).error, "evidence must be a link");
  const c1 = await core.addCheckItem({ pip: 36, list: "KPIs", milestone: "2", item: "1,000 players onboarded" });
  const c2 = await core.addCheckItem({ pip: 36, list: "KPIs", milestone: "2", item: "Report published", evidence: "https://example.org/report" });
  const c3 = await core.addCheckItem({ pip: 36, list: "Deliverables", milestone: "", item: "Source code public" });
  ok(c1.saved && c2.saved && c3.saved && book["Checklists"][0].join() === SM.CHECKLIST_HEADERS.join(), "checklist items create their tab");
  ok((await core.tickCheckItem(c1.id, true, "council@example.org")).updated, "an item can be ticked");
  let cl = parseChecklistTab(book["Checklists"]);
  const t1 = cl.find((c) => c.id === c1.id);
  ok(/^\d{4}-\d{2}-\d{2}$/.test(t1.doneOn) && t1.doneBy === "council@example.org" && t1.milestone === 2 && !cl.find((c) => c.id === c2.id).doneOn && cl.find((c) => c.id === c2.id).evidence === "https://example.org/report", "ticking saves the date and who ticked: " + JSON.stringify(t1));
  ok((await core.tickCheckItem(c1.id, false)).updated && !parseChecklistTab(book["Checklists"]).find((c) => c.id === c1.id).doneOn, "an item can be unticked");
  await core.tickCheckItem(c1.id, true, "council@example.org");

  const SIGM = "8".repeat(88);
  ok((await core.setMilestonePayout(m2.id, "nope")).error, "linking needs a transaction signature");
  ok((await core.setMilestonePayout(m2.id, SIGM)).updated && parseMilestonesTab(book["PIP milestones"])[1].paidBy === SIGM, "a payout can be linked to a milestone");

  // The calculation: checklists per milestone, the paid-with-open-items flag, labels for linked payouts.
  ms = parseMilestonesTab(book["PIP milestones"]); cl = parseChecklistTab(book["Checklists"]);
  const legs = [{ sig: SIGM, t: 1790000000, direction: "out", account: "treasury" }];
  const plan = pipPlans({ milestones: ms, checklists: cl, legs });
  const P = plan.byPip.get(36);
  ok(P.milestones.length === 2 && P.milestones[1].checks[0].name === "KPIs" && P.milestones[1].checks[0].done === 1 && P.milestones[1].checks[0].total === 2 && P.milestones[1].paidAt === 1790000000, "milestone 2 shows its KPI checklist 1/2: " + JSON.stringify(P.milestones[1].checks));
  ok(P.checklists.length === 2 && P.checklists.find((l) => l.name === "Deliverables").milestone === null, "a checklist without a milestone stands on its own");
  ok(plan.flags.some((f) => /milestone 2 \(Public launch\) is paid, but its checklist "KPIs" has 1 open item/.test(f.message)), "paying a milestone with open KPIs is flagged: " + JSON.stringify(plan.flags));
  await core.tickCheckItem(c2.id, true, "council@example.org");
  const afterTick = pipPlans({ milestones: ms, checklists: parseChecklistTab(book["Checklists"]), legs }).flags;
  ok(!afterTick.some((f) => /open item/.test(f.message)) && afterTick.some((f) => f.severity === "info" && /milestone 2 \(Public launch\) is paid, but not marked completed/.test(f.message)), "open-items flag gone once every item is ticked; paid but not completed is a reminder: " + JSON.stringify(afterTick));
  ok(pipPlans({ milestones: [], checklists: cl, legs }).flags.some((f) => /for milestone 2, which is not in the PIP milestones tab/.test(f.message)), "a checklist for a missing milestone is flagged");
  ok(milestoneLabels(ms).length === 1 && milestoneLabels(ms)[0].label === "PIP-36" && milestoneLabels(ms)[0].signature === SIGM, "a linked payout is labelled as the PIP's");

  // Completed (signed off) is its own step; the Tracker's counts follow the list on every milestone save.
  {
    const T = SM.trackerColumns(book.Tracker);
    const row36 = SM.locatePip(book.Tracker, 36);
    ok(!row36.error, "the test Tracker has a PIP-36 row");
    r = await core.completeMilestone(m1.id, true, "council@example.org");
    let ms2 = parseMilestonesTab(book["PIP milestones"]);
    const done1 = ms2.find((m) => m.id === m1.id);
    ok(r.updated && /^\d{4}-\d{2}-\d{2}$/.test(done1.completedOn) && done1.completedBy === "council@example.org" && book["PIP milestones"][0].includes("Completed on"), "a milestone can be marked completed: " + JSON.stringify(done1));
    ok(book.Tracker[row36.row][T.cols.milestonesDone] === "2" && book.Tracker[row36.row][T.cols.milestonesTotal] === "2", "the Tracker counts follow the list (1 completed + 1 paid of 2): " + book.Tracker[row36.row][T.cols.milestonesDone] + "/" + book.Tracker[row36.row][T.cols.milestonesTotal]);
    let plan2 = pipPlans({ milestones: ms2, checklists: parseChecklistTab(book["Checklists"]), legs });
    ok(plan2.flags.some((f) => /milestone 1 \(Beta release\) is completed, but no payout is linked/.test(f.message)), "completed without a payout is a reminder to pay");
    r = await core.completeMilestone(m1.id, false);
    ok(r.updated && !parseMilestonesTab(book["PIP milestones"]).find((m) => m.id === m1.id).completedOn && book.Tracker[row36.row][T.cols.milestonesDone] === "1", "reopening clears it and the Tracker count goes back to 1");
    // Completed while its checklist has open items: flagged before the money goes out.
    const c4 = await core.addCheckItem({ pip: 36, list: "KPIs", milestone: "1", item: "Beta live" });
    await core.completeMilestone(m1.id, true, "council@example.org");
    plan2 = pipPlans({ milestones: parseMilestonesTab(book["PIP milestones"]), checklists: parseChecklistTab(book["Checklists"]), legs });
    ok(plan2.flags.some((f) => f.severity === "warning" && /milestone 1 \(Beta release\) is marked completed, but its checklist "KPIs" has 1 open item/.test(f.message)), "completing with open checklist items is flagged");
    await core.deleteCheckItem(c4.id);
    // One-time import from the Tracker's counts; a PIP that already has a list is left alone.
    r = await core.importMilestones([{ pip: 24, done: 3, total: 3 }, { pip: 14, done: 1, total: 2 }, { pip: 36, done: 0, total: 5 }]);
    const all = parseMilestonesTab(book["PIP milestones"]);
    const p24 = all.filter((m) => m.pip === 24), p14 = all.filter((m) => m.pip === 14);
    ok(r.saved && r.rows === 5 && r.pips.join() === "24,14" && all.filter((m) => m.pip === 36).length === 2, "import makes lists only for PIPs without one: " + JSON.stringify(r));
    ok(p24.length === 3 && p24.every((m) => m.completedBy === "Tracker" && !m.paidBy) && p14.map((m) => m.completedBy || "-").join() === "Tracker,-" && p14[1].name === "Milestone 2", "imported milestones are completed per the Tracker, never paid: " + JSON.stringify(p14));
    const plan3 = pipPlans({ milestones: all, checklists: [], legs });
    ok(plan3.flags.filter((f) => f.pip === 24 && /completed \(per the Tracker\), but no payout is linked/.test(f.message)).length === 3, "each imported completed milestone without a payout is a reminder");
  }
  ok((await core.deleteCheckItem(c3.id)).deleted && parseChecklistTab(book["Checklists"]).length === 2, "an item can be deleted");
  ok((await core.deleteMilestone(m1.id)).deleted && parseMilestonesTab(book["PIP milestones"]).filter((m) => m.pip === 36).map((m) => m.n).join() === "2", "a milestone can be deleted");
  ok(book.Tracker[SM.locatePip(book.Tracker, 36).row][SM.trackerColumns(book.Tracker).cols.milestonesTotal] === "1", "and the Tracker's total follows");
}

// ---------- sign-in problems in plain words ----------
{
  ok((await core.canEdit()).ok, "an editor passes the edit-rights check");
  readOnly = true;
  const v = await core.canEdit();
  ok(!v.ok && v.status === 403 && (await core.canAccess()), "a view-only account can open the sheet but fails the edit-rights check");
  readOnly = false;
  const m = ctx.Editor.signInMessage;
  ok(/can view the Council's sheet but not edit it/.test(m("view-only: The caller does not have permission", "x@y.org")), "view-only sign-in explained");
  ok(/tick the box for Google Sheets/.test(m("Request had insufficient authentication scopes.")), "missing Sheets permission explained");
  ok(/tick the box for Google Sheets/.test(m("The Google Sheets permission was not granted.")), "unticked Sheets box explained");
  ok(/window was closed/.test(m("popup_closed")) && /window was closed/.test(m("Popup window closed")) && /Allow pop-ups/.test(m("popup_failed_to_open")), "closed and blocked popups explained");
  const sh = ctx.Editor.signInShort;
  ok(sh("Popup window closed") === "Sign-in cancelled" && sh("view-only: x") === "No edit rights" && sh("popup_failed_to_open") === "Pop-up blocked" && sh("new thing") === "Sign-in failed", "short header texts match the cases");
  ok(/registered as a tester/.test(m("access_denied")), "access denied explained");
  ok(/x@y\.org\) cannot edit the Council's sheet/.test(m("403: The caller does not have permission", "x@y.org")) && /\(Google: 403/.test(m("403: The caller does not have permission")), "no edit access explained, with Google's own text kept");
  ok(/^Sign-in failed\. \(Google: something new\)$/.test(m("something new")), "unknown errors keep Google's text");
}

// ---------- Google Drive upload against a fake Drive API ----------
const dreq = [];
let driveFiles = [];
const drive = ctx.Editor.makeDrive({
  getToken: async () => "T",
  fetchFn: async (url, o = {}) => {
    dreq.push({ url, o });
    if (url.includes("/about")) return json(200, { user: { emailAddress: "owner@example.org" } });
    if (url.includes("/upload/")) return json(200, { id: "F1", name: "x.pdf", webViewLink: "https://drive.google.com/file/d/F1/view" });
    if ((o.method || "GET") === "GET") return json(200, { files: driveFiles });
    driveFiles = [{ id: "FOLDER" }];
    return json(200, { id: "FOLDER" });
  },
});
ok((await drive.folder("Payment documents")) === "FOLDER" && dreq.some((r) => r.o.method === "POST"), "documents folder is created on first use");
dreq.length = 0;
ok((await drive.folder("Payment documents")) === "FOLDER" && !dreq.some((r) => r.o.method === "POST"), "and found again afterwards");
const upd = await drive.upload("FOLDER", new Blob(["%PDF-1.4 test"], { type: "application/pdf" }), "2025-12-18 invoice.pdf");
const sent = dreq.find((r) => r.url.includes("/upload/"));
const sentText = await sent.o.body.text();
ok(upd.webViewLink && sent.o.headers["Content-Type"].startsWith("multipart/related; boundary=") && sentText.includes('"parents":["FOLDER"]') && sentText.includes('"name":"2025-12-18 invoice.pdf"') && sentText.includes("%PDF-1.4 test") && sent.o.headers.Authorization === "Bearer T", "upload sends name, folder and file in one request");
ok((await drive.who()) === "owner@example.org", "reads which account the Drive permission belongs to");

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} editor checks passed`);
process.exit(failed ? 1 : 0);
