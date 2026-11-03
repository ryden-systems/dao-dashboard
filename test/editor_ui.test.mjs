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
    querySelector: (s) => nodes[s.replace(/^#/, "")] ?? (s.startsWith("#") && s.slice(1) in inputs ? { value: inputs[s.slice(1)], checked: inputs[s.slice(1)] === true } : null),
    querySelectorAll: () => [], getElementById: (id) => nodes[id] ?? null, head: { appendChild() {} }, createElement: () => ({}),
  },
  addEventListener: (t, fn) => { (winListeners[t] ??= []).push(fn); },
  dispatchEvent: (ev) => { for (const fn of winListeners[ev.type] ?? []) fn(ev); },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  fetch: async (u) => ({ ok: true, status: 200, json: async () => (String(u).includes("dashboard.json") ? D : {}) }),
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

// ---------- sign in with a stub core ----------
const calls = [];
let sheetNote = "Transitioning from Eveeye Star Atlas";
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
};
ctx.Editor.state = { available: true, signedIn: true, email: "editor@example.org", error: null };
ctx.dispatchEvent(new ctx.CustomEvent("editor:change"));
await tick();
ok(nodes.editbar.innerHTML.includes("editor@example.org") && nodes.editbar.innerHTML.includes("Sign out"), "header shows the signed-in editor");
ok(text().includes("Editor mode"), "editor banner on the payments page");

// ---------- label a payout ----------
const need = D.payments.find((p) => p.direction === "out" && (p.confidence === "unlabelled" || p.confidence === "inferred"));
const key = `${need.sig}:${need.owner ?? ""}`;
ok(nodes.view.innerHTML.includes(`data-key="${key}"`), "Label button on a payout that needs a label");
await click("lbl-open", { key });
ok(nodes.view.innerHTML.includes('id="lbl-pip"') && nodes.view.innerHTML.includes("PIP-28"), "label form opens with the funded PIPs");
inputs["lbl-pip"] = "PIP-28"; inputs["lbl-ok"] = true;
await click("lbl-save", { sig: need.sig, owner: need.owner ?? "" });
const lc = calls.find((c) => c[0] === "addLabel");
ok(lc && lc[1].signature === need.sig && lc[1].recipient === (need.owner ?? "") && lc[1].pip === "PIP-28" && lc[1].confirmed === true, "label saved with signature, recipient, PIP and confirmed: " + JSON.stringify(lc?.[1]));
ok(text().includes("Labelled PIP-28"), "saved message shown on the payout");

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

// ---------- sign out ----------
ctx.Editor.state = { available: true, signedIn: false, email: null, error: null };
ctx.dispatchEvent(new ctx.CustomEvent("editor:change"));
await tick();
ok(!nodes.view.innerHTML.includes("Edit the Council list") && nodes.editbar.innerHTML.includes("Editor sign-in") && !nodes.editbar.innerHTML.includes("ed-update"), "signing out removes the editing controls");

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} editor UI checks passed`);
process.exit(failed ? 1 : 0);
