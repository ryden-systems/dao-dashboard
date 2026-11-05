// Drives the dashboard's editing controls without a browser: a stub editor is "signed in",
// pages are rendered, buttons are "clicked", and the test checks what the page sends to the
// editor core and what it shows afterwards.   node test/editor_ui.test.mjs   (after a build)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "../scripts/lib/util.mjs";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log("FAIL", m); } };
const dist = path.join(ROOT, "dist");
const D = JSON.parse(fs.readFileSync(path.join(dist, "data", "dashboard.json"), "utf8"));
// The "create tab" path applies while the list still comes from the record, whatever sheet this was built from.
D.councilTerms.source = "record";
D.editing = { googleClientId: "test-client", sheetId: "SHEET", tabs: { pips: "Tracker", paymentLabels: "Payment labels", councilMembers: "Council members" } };

const el = (id) => ({ id, hidden: false, innerHTML: "", value: "", checked: false, dataset: {}, style: {}, addEventListener() {}, querySelectorAll: () => [], scrollIntoView() {} });
const nodes = { view: el("view"), stamp: el("stamp"), foot: el("foot"), notice: el("notice"), tip: el("tip"), editbar: el("editbar") };
const inputs = {}; // values the "user" typed, by element id
const viewClick = [], winListeners = {};
nodes.view.addEventListener = (t, fn) => { if (t === "click") viewClick.push(fn); };
const ctx = {
  console, setTimeout, clearTimeout, Intl, Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise,
  location: { hash: "" }, innerWidth: 1200, scrollTo() {},
  document: {
    querySelector: (s) => nodes[s.replace(/^#/, "")] ?? (s.startsWith("#") && s.slice(1) in inputs ? { value: inputs[s.slice(1)], checked: inputs[s.slice(1)] === true, files: inputs[s.slice(1)] } : null),
    querySelectorAll: () => [], getElementById: (id) => nodes[id] ?? null, head: { appendChild() {} }, createElement: () => ({}),
  },
  addEventListener: (t, fn) => { (winListeners[t] ??= []).push(fn); },
  dispatchEvent: (ev) => { for (const fn of winListeners[ev.type] ?? []) fn(ev); },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  // Serves the built site's files (vote detail etc.) like the browser would; dashboard.json is the test's copy.
  fetch: async (u) => {
    if (String(u).includes("dashboard.json")) return { ok: true, status: 200, json: async () => D };
    const file = path.join(dist, String(u).split("?")[0]);
    const ok = fs.existsSync(file);
    return { ok, status: ok ? 200 : 404, json: async () => (ok ? JSON.parse(fs.readFileSync(file, "utf8")) : {}) };
  },
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["charts.js", "sheetmap.js", "editor.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(dist, f), "utf8"), ctx, { filename: f });
const tick = () => new Promise((r) => setTimeout(r, 20));
await tick();

const go = async (hash) => { ctx.location.hash = hash; for (const fn of winListeners.hashchange ?? []) fn(); await tick(); };
const text = () => nodes.view.innerHTML.replace(/<[^>]+>/g, " ").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ");
const click = async (act, dataset = {}) => {
  const target = { dataset: { act, ...dataset }, disabled: false, closest: (sel) => (sel === "[data-act]" ? target : null) };
  for (const fn of viewClick) fn({ target, preventDefault() {} });
  await tick(); await tick();
};

// ---------- signed out ----------
ok(nodes.editbar.innerHTML.includes("Editor sign-in"), "sign-in button shown when editing is enabled");
ok(!nodes.view.innerHTML.includes('href="#health"'), "overview hides the Data health tile while signed out");
await go("#health");
ok(!nodes.view.innerHTML.includes('id="f-sev"'), "Data health page is not shown while signed out");
await go("#payments");
ok(!nodes.view.innerHTML.includes('data-act="lbl-open"'), "no Label buttons while signed out");
ok(!nodes.view.innerHTML.includes("Payouts to label"), "Payouts to label is hidden while signed out");

// ---------- sign in with a stub core ----------
const calls = [];
let sheetNote = "Transitioning from Eveeye Star Atlas";
let docsInSheet = [];
ctx.Editor.core = {
  async addLabel(a) { calls.push(["addLabel", a]); return { saved: true }; },
  async requestUpdate(by) { calls.push(["requestUpdate", by]); return { saved: true, at: "2026-11-03 12:34:56" }; },
  async readPip(n) { calls.push(["readPip", n]); return { values: { phase: "Voting", milestonesDone: "1", milestonesTotal: "1", roi: "ROI text", note: sheetNote }, missing: [] }; },
  async savePip(n, changes, opts) {
    calls.push(["savePip", n, changes, opts]);
    if (!opts?.force && changes.note && changes.note.from !== sheetNote) return { conflicts: [{ field: "note", label: "Note", yours: changes.note.to, sheet: sheetNote }] };
    return { saved: true };
  },
  async seedMembers(terms) { calls.push(["seedMembers", terms.length]); return { saved: true, rows: terms.reduce((s, t) => s + t.members.length, 0) }; },
  async addMember(m) { calls.push(["addMember", m]); return m.name ? { saved: true } : { error: "name: This field is required." }; },
  async listDocs() { calls.push(["listDocs"]); return docsInSheet; },
};
ctx.Editor.state = { available: true, signedIn: true, email: "editor@example.org", error: null };
ctx.dispatchEvent(new ctx.CustomEvent("editor:change"));
await tick();
ok(nodes.editbar.innerHTML.includes("editor@example.org") && nodes.editbar.innerHTML.includes("Sign out"), "header shows the signed-in editor");
ok(text().includes("Editor mode"), "editor banner on the payments page");
ok(nodes.view.innerHTML.includes('<div class="kpi ed-only"><span class="k">Payouts to label'), "Payouts to label shown to editors, with the editor tint");

// ---------- label a payout ----------
const need = D.payments.find((p) => p.direction === "out" && (p.confidence === "unlabelled" || p.confidence === "inferred"));
const key = `${need.sig}:${need.owner ?? ""}`;
ok(nodes.view.innerHTML.includes(`data-key="${key}"`), "Label button on a payout that needs a label");
await click("lbl-open", { key });
ok(nodes.view.innerHTML.includes('id="lbl-pip"') && nodes.view.innerHTML.includes("PIP-28"), "label form opens with the funded PIPs");
ok(nodes.view.innerHTML.includes('value="Foundation"') && nodes.view.innerHTML.includes('id="lbl-cat"'), "label form offers the Foundation cost category and a new-category field");
inputs["lbl-pip"] = "PIP-28"; inputs["lbl-ok"] = true;
await click("lbl-save", { sig: need.sig, owner: need.owner ?? "" });
const lc = calls.find((c) => c[0] === "addLabel");
ok(lc && lc[1].signature === need.sig && lc[1].recipient === (need.owner ?? "") && lc[1].pip === "PIP-28" && lc[1].confirmed === true, "label saved with signature, recipient, PIP and confirmed: " + JSON.stringify(lc?.[1]));
ok(text().includes("Labelled PIP-28"), "saved message shown on the payout");

// Remove a label: only on labelled payouts, and only after confirming in place.
{
  const lab = D.payments.find((p) => p.labelled && p.direction === "out");
  if (lab) {
    ctx.Editor.core.removeLabel = async (a) => { calls.push(["removeLabel", a]); return { removed: 1 }; };
    const lkey = `${lab.sig}:${lab.owner ?? ""}`;
    await click("lbl-open", { key: lkey });
    ok(nodes.view.innerHTML.includes('data-act="lbl-clear"'), "a labelled payout's form offers Remove label");
    await click("lbl-clear", { sig: lab.sig, owner: lab.owner ?? "" });
    ok(!calls.some((c) => c[0] === "removeLabel") && nodes.view.innerHTML.includes('data-act="lbl-clear-yes"'), "Remove label asks to confirm before touching the sheet");
    await click("lbl-clear-yes", { sig: lab.sig, owner: lab.owner ?? "" });
    const rc = calls.find((c) => c[0] === "removeLabel");
    ok(rc && rc[1].signature === lab.sig && rc[1].recipient === (lab.owner ?? "") && text().includes("Label removed"), "confirming removes the label for that payout");
  }
  const unl = D.payments.find((p) => !p.labelled && p.direction === "out" && (p.confidence === "unlabelled" || p.confidence === "inferred"));
  await click("lbl-open", { key: `${unl.sig}:${unl.owner ?? ""}` });
  ok(!nodes.view.innerHTML.includes('data-act="lbl-clear"'), "a payout without a Council label has no Remove label button");
  await click("lbl-cancel");
}

// A movement can be edited wherever it shows up: proposal page, Overview, Payments.
{
  const leg = D.payments.find((p) => p.pip != null && !(p.confidence === "internal" && !p.labelled));
  const k = `data-act="lbl-open" data-key="${leg.sig}:${leg.owner ?? ""}"`;
  await go(`#votes/${leg.pip}`);
  ok(nodes.view.innerHTML.includes(k), `a PIP's payout can be labelled on its proposal page (PIP-${leg.pip})`);
  await click("lbl-open", { key: `${leg.sig}:${leg.owner ?? ""}` });
  ok(nodes.view.innerHTML.includes('id="lbl-pip"'), "the label form opens on the proposal page");
  await click("lbl-cancel");
  await go("#overview");
  const recent = D.payments.find((p) => p.direction === "out" && p.confidence !== "internal");
  ok(nodes.view.innerHTML.includes(`data-act="lbl-open" data-key="${recent.sig}:${recent.owner ?? ""}"`), "recent payouts on Overview can be labelled");
  await go("#payments");
}

// ---------- edit a PIP: conflict, then overwrite ----------
ctx.location.hash = "#payments";
const funded = D.pips.find((p) => p.pip === 16);
// open PIP-16's detail row, as a click on its row would
for (const fn of viewClick) fn({ target: { closest: (s) => (s === "tr.click[data-pip]" ? { dataset: { pip: "16" } } : null) }, preventDefault() {} });
await tick();
ok(funded && nodes.view.innerHTML.includes('data-act="pip-edit"'), "PIP detail offers editing");
await click("pip-edit", { pip: "16" });
ok(calls.some((c) => c[0] === "readPip" && c[1] === 16) && nodes.view.innerHTML.includes('id="pf-note"'), "edit form loads live values from the sheet");
inputs["pf-milestonesDone"] = "1"; inputs["pf-milestonesTotal"] = "1"; inputs["pf-roi"] = "ROI text"; inputs["pf-note"] = "New note from the dashboard";
sheetNote = "Someone changed this in the sheet";
await click("pip-save");
const sc = calls.filter((c) => c[0] === "savePip").pop();
ok(sc && Object.keys(sc[2]).join() === "note" && sc[2].note.to === "New note from the dashboard", "only the changed field is sent: " + JSON.stringify(sc?.[2]));
ok(text().includes("Changed in the sheet since you opened this") && text().includes("Someone changed this in the sheet"), "conflict shows the sheet's current value");
await click("pip-overwrite");
const oc = calls.filter((c) => c[0] === "savePip").pop();
ok(oc[3]?.force === true && text().includes("Saved to the sheet"), "overwrite forces the save and confirms it");

// ---------- council: seed the tab, then add a member ----------
await go("#council");
ok(nodes.view.innerHTML.includes('data-act="mem-seed"') && !nodes.view.innerHTML.includes('data-act="mem-open"'), "before the tab exists: only 'create tab' is offered");
await click("mem-seed");
ok(calls.some((c) => c[0] === "seedMembers" && c[1] === D.councilTerms.terms.length) && text().includes("Created the \"Council members\" tab"), "tab created from the full record");
ok(nodes.view.innerHTML.includes('data-act="mem-open"'), "after creating the tab: adding members is offered");
await click("mem-open");
Object.assign(inputs, { "mf-name": "", "mf-role": "", "mf-term": "Term 5", "mf-start": "2027-07-11", "mf-end": "", "mf-pip": "40", "mf-x": "", "mf-discord": "", "mf-image": "" });
await click("mem-save");
ok(text().includes("required") && nodes.view.innerHTML.includes('value="Term 5"'), "error shown and the typed values are kept");
inputs["mf-name"] = "New Member";
await click("mem-save");
const mc = calls.filter((c) => c[0] === "addMember").pop();
ok(mc[1].name === "New Member" && mc[1].electedIn === 40 && mc[1].start === "2027-07-11", "member sent with parsed PIP number: " + JSON.stringify(mc[1]));
ok(text().includes("Added New Member"), "member added message shown");

// ---------- data health for editors ----------
await go("#health");
ok(nodes.view.innerHTML.includes('id="f-sev"'), "Data health page shown to signed-in editors");
await go("#overview");
ok(nodes.view.innerHTML.includes('href="#health"'), "overview shows the Data health tile to signed-in editors");

// ---------- update now ----------
ok(nodes.editbar.innerHTML.includes('data-act="ed-update"'), "Update now button shown to signed-in editors");
await click("ed-update");
ok(calls.some((c) => c[0] === "requestUpdate" && c[1] === "editor@example.org") && nodes.editbar.innerHTML.includes("Update requested at 12:34 UTC"), "Update now asks the sheet for a rebuild and confirms");

// ---------- labels can be changed; DAO-internal transfers cannot be labelled ----------
{
  await go("#payments");
  const html = nodes.view.innerHTML;
  const auto = D.payments.find((p) => p.direction === "out" && (p.confidence === "matches-sheet" || p.confidence === "matches-amount"));
  const dao = D.payments.find((p) => p.direction === "out" && p.confidence === "internal" && !p.labelled);
  ok(!auto || html.includes(`data-act="lbl-open" data-key="${auto.sig}:${auto.owner ?? ""}"`), "automatically matched payouts can be labelled too");
  ok(!dao || !html.includes(`data-act="lbl-open" data-key="${dao.sig}:${dao.owner ?? ""}"`), "transfers between DAO accounts get no Label button");
  const was = { ...need };
  Object.assign(need, { labelled: true, confidence: "internal", reason: "not a payout", pip: null, category: null });
  await go("#payments");
  ok(nodes.view.innerHTML.includes(`data-key="${key}">Relabel</button>`), "a labelled payout shows Relabel");
  await click("lbl-open", { key });
  ok(/<option value="not a payout" selected>/.test(nodes.view.innerHTML), "the relabel form preselects the current label");
  await click("lbl-cancel");
  Object.assign(need, was);
}

// ---------- wallets on the Balances page ----------
{
  const W = "B5hX2Aj8FYmdYjXQFVF1jpz7BkrdpLXgSPs92G6DFGjA";
  D.wallets = [
    { wallet: W, name: "Star Atlas Foundation", label: "Foundation", track: true, note: "", now: { ATLAS: 0, USDC: 1234.5, SOL: 0.25 } },
    { wallet: "9q3ZZnezQyVxxxxxxxxxxxxxxxxxxxxxxxxxxxxxhX7Y", name: "Untracked Wallet", label: "PIP-22", track: false, note: "", now: null },
  ];
  ctx.Editor.core.saveWallet = async (w) => { calls.push(["saveWallet", w]); return { saved: true, updated: true }; };
  await go("#balance");
  ok(nodes.view.innerHTML.includes("Star Atlas Foundation") && nodes.view.innerHTML.includes("1,234.5") && nodes.view.innerHTML.includes(">Foundation</span>") && nodes.view.innerHTML.includes("<th>Payout label</th>"), "tracked wallet listed with name, payout label and balances");
  ok(/<tr class="ed-only">\s*<td><strong>Untracked Wallet/.test(nodes.view.innerHTML), "editors also see untracked wallets, tinted");
  await click("wal-open", { wallet: W });
  ok(nodes.view.innerHTML.includes(`id="wf-wallet" placeholder="Solana address" value="${W}"`), "Edit opens the form filled with the wallet");
  Object.assign(inputs, { "wf-wallet": W, "wf-name": "Star Atlas Foundation", "wf-label": "Foundation", "wf-note": "", "wf-track": true });
  await click("wal-save");
  const sw = calls.find((c) => c[0] === "saveWallet");
  ok(sw && sw[1].wallet === W && sw[1].track === true && sw[1].label === "Foundation" && nodes.view.innerHTML.includes("Updated Star Atlas Foundation"), "saving sends the wallet to the sheet and confirms");
  ok(nodes.view.innerHTML.includes('data-act="wal-open">Add a wallet'), "editors can add another wallet");
}

// ---------- counterparty links show only transfers with the DAO account ----------
{
  await go("#payments");
  const wallet = D.accounts[need.account].wallet;
  ok(nodes.view.innerHTML.includes(`solscan.io/account/${need.owner}?exclude_amount_zero=true&amp;remove_spam=false&amp;from_address=${wallet}#transfers`), "payout counterparty link filters Solscan to transfers from the DAO account");
}

// ---------- payment documents ----------
D.editing.documents = { owner: "owner@example.org", folder: "Payment documents" };
ok(calls.some((c) => c[0] === "listDocs"), "documents are read from the sheet after sign-in");
const dkey = `${need.sig}:${need.owner ?? ""}`;
await go("#payments");
await click("doc-open", { key: dkey });
ok(nodes.view.innerHTML.includes("Only owner@example.org can upload documents") && /<button class="btn" disabled[^>]*>Upload PDF<\/button>/.test(nodes.view.innerHTML) && !nodes.view.innerHTML.includes('id="doc-files"'), "other editors see a disabled upload button naming the owner");
ctx.Editor.canUpload = () => true;
ctx.Editor.uploadDocs = async (a) => {
  calls.push(["uploadDocs", a]);
  docsInSheet = a.files.map((f) => ({ signature: a.signature, recipient: a.recipient, file: f.name, link: "https://drive.example/" + f.name, at: "2026-11-04 10:00:00", by: "owner@example.org" }));
  return { saved: true, files: a.files.map((f) => f.name) };
};
await go("#payments");
ok(nodes.view.innerHTML.includes('id="doc-files"') && nodes.view.innerHTML.includes("multiple"), "the owner gets a multi-file picker");
inputs["doc-files"] = [{ name: "a.pdf" }, { name: "b.pdf" }];
await click("doc-upload", { sig: need.sig, owner: need.owner ?? "" });
const upCall = calls.find((c) => c[0] === "uploadDocs");
ok(upCall && upCall[1].files.length === 2 && upCall[1].signature === need.sig, "upload sends every chosen file for that payout");
ok(nodes.view.innerHTML.includes("Uploaded 2 files") && nodes.view.innerHTML.includes("https://drive.example/b.pdf"), "uploaded files are listed on the payout");
await click("doc-close");
ok(nodes.view.innerHTML.includes("Documents (2)"), "the payout's button counts its documents");
docsInSheet.push({ signature: need.sig, recipient: need.owner ?? "", file: "evil.pdf", link: "javascript:alert(1)", at: "2026-11-04 10:00:00", by: "x@example.org" });
await click("doc-open", { key: dkey });
ok(nodes.view.innerHTML.includes("evil.pdf") && !nodes.view.innerHTML.includes("javascript:"), "a non-https document link from the sheet is shown as plain text, never as a link");
await click("doc-close");

// ---------- sign out ----------
ctx.Editor.state = { available: true, signedIn: false, email: null, error: null };
ctx.dispatchEvent(new ctx.CustomEvent("editor:change"));
await tick();
ok(!nodes.view.innerHTML.includes("Edit the Council list") && nodes.editbar.innerHTML.includes("Editor sign-in") && !nodes.editbar.innerHTML.includes("ed-update"), "signing out removes the editing controls");
await go("#balance");
ok(nodes.view.innerHTML.includes("Star Atlas Foundation") && !nodes.view.innerHTML.includes("Untracked Wallet") && !nodes.view.innerHTML.includes("not tracked"), "visitors see tracked wallets only");

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} editor UI checks passed`);
process.exit(failed ? 1 : 0);
