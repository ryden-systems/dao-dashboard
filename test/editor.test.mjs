// Tests the two-way editor against an in-memory imitation of the Google Sheets API,
// seeded with a copy of the real Tracker tab. Then reads what the editor wrote back through
// the build's own importers, to prove both directions use the same format.
//   node test/editor.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT, parseCSV } from "../scripts/lib/util.mjs";
import { parsePipTab, parseLabelTab, parseMembersTab } from "../scripts/lib/sheet.mjs";
import { councilTerms } from "../scripts/lib/members.mjs";

let failed = 0, passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log("FAIL", msg); } };

// Load the browser scripts the same way the page does.
const ctx = { console, Promise, JSON, Object, Array, String, Number, Math, Map, Set, encodeURIComponent, decodeURIComponent };
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
await core.addLabel({ signature: "SIG1", recipient: "OWNER1", pip: "PIP-28", confirmed: true });
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
ok(!/picker|apis\.google\.com|drive\.file/i.test(editorSrc), "no file picker or drive.file permission in the editor");
ok(editorSrc.includes("auth/spreadsheets"), "editor asks for the spreadsheet permission");

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

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} editor checks passed`);
process.exit(failed ? 1 : 0);
