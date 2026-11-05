// Tests the two-way editor against an in-memory imitation of the Google Sheets API,
// seeded with a copy of the real Tracker tab. Then reads what the editor wrote back through
// the build's own importers, to prove both directions use the same format.
//   node test/editor.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT, parseCSV } from "../scripts/lib/util.mjs";
import { parsePipTab, parseLabelTab, parseMembersTab, parseWalletsTab } from "../scripts/lib/sheet.mjs";
import { reconcile } from "../scripts/lib/reconcile.mjs";
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
let access = true;
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
  const u = new URL(url);
  const rest = decodeURIComponent(u.pathname.split("/spreadsheets/")[1]).split("/").slice(1).join("/");
  const body = opts.body ? JSON.parse(opts.body) : null;
  if (!rest && u.search.includes("fields=properties.title")) return json(200, { properties: { title: "Tracker sheet" } });
  if (!rest && u.search.includes("sheets.properties")) return json(200, { sheets: Object.keys(book).map((t, i) => ({ properties: { title: t, sheetId: i } })) });
  if (rest === ":batchUpdate" || u.pathname.endsWith(":batchUpdate")) {
    for (const rq of body.requests) if (rq.addSheet) { const t = rq.addSheet.properties.title; if (book[t]) return json(400, { error: { message: "exists" } }); book[t] = []; }
    for (const rq of body.requests) if (rq.deleteDimension) { const g = rq.deleteDimension.range; book[Object.keys(book)[g.sheetId]].splice(g.startIndex, g.endIndex - g.startIndex); }
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
ok(!loc.error && Object.values(loc.cols).every((c) => c >= 0), "locatePip finds PIP-16 and every editable column: " + JSON.stringify(loc.error || loc.cols));
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

// ---------- payment labels: create tab, append, round-trip through the build's importer ----------
r = await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-28", confirmed: true });
ok(r.saved && book["Payment labels"]?.[0]?.join() === SM.LABEL_HEADERS.join(), "labels tab created with headers");
await core.addLabel({ signature: "SIG2", recipient: "", pip: "internal", confirmed: false });
ok(book["Payment labels"].length === 3, "second label appended, tab not recreated");
ok((await core.addLabel({ signature: "SIG3", pip: "28" })).error, "invalid label refused");
r = await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-29", confirmed: false });
ok(r.updated && book["Payment labels"].length === 3 && book["Payment labels"][1][2] === "PIP-29" && book["Payment labels"][1][3] === "FALSE", "relabelling updates the row instead of adding one");
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
