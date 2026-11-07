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
ok(!nodes.view.innerHTML.includes('data-go="#health"'), "overview hides the Data health tile while signed out");
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
  async readPip(n) {
    calls.push(["readPip", n]);
    const values = { pipNo: typeof n === "number" ? `PIP-${n}` : "", phase: "Voting", milestonesDone: "1", milestonesTotal: "1", roi: "ROI text", note: sheetNote };
    return { values, form: { ...values, pipNo: typeof n === "number" ? String(n) : "" }, pip: typeof n === "number" ? n : null, missing: [] };
  },
  async savePip(n, changes, opts) {
    calls.push(["savePip", n, changes, opts]);
    if (!opts?.force && changes.note && changes.note.from !== sheetNote) return { conflicts: [{ field: "note", label: "Note", yours: changes.note.to, sheet: sheetNote }] };
    return { saved: true, key: changes.pipNo?.to ? Number(changes.pipNo.to) : n };
  },
  async addPip(f) { calls.push(["addPip", f]); return f.name ? { saved: true, key: f.pipNo ? Number(f.pipNo) : "DTEST1" } : { error: "Name: a PIP needs a name." }; },
  async seedMembers(terms) { calls.push(["seedMembers", terms.length]); return { saved: true, rows: terms.reduce((s, t) => s + t.members.length, 0) }; },
  async addMember(m) { calls.push(["addMember", m]); return m.name ? { saved: true } : { error: "name: This field is required." }; },
  async listDocs() { calls.push(["listDocs"]); return docsInSheet; },
};
ctx.Editor.state = { available: true, signedIn: true, email: "editor@example.org", error: null };
ctx.dispatchEvent(new ctx.CustomEvent("editor:change"));
await tick();
ok(nodes.editbar.innerHTML.includes("editor@example.org") && nodes.editbar.innerHTML.includes("Sign out"), "header shows the signed-in editor");
ok(nodes.view.innerHTML.includes('<div class="kpi ed-only"><span class="k">Payouts to label'), "Payouts to label shown to editors, with the editor tint");

// ---------- label a payout ----------
await go("#transactions");
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
  await go("#transactions");
}

// ---------- edit a PIP: conflict, then overwrite ----------
ctx.location.hash = "#payments";
const funded = D.pips.find((p) => p.pip === 16);
// open PIP-16's detail row, as a click on its row would
for (const fn of viewClick) fn({ target: { closest: (s) => (s === "tr.click[data-pip]" ? { dataset: { pip: "16" } } : null) }, preventDefault() {} });
await tick();
ok(funded && nodes.view.innerHTML.includes('data-act="pip-edit"'), "PIP detail offers editing");
await click("pip-edit", { key: "16" });
ok(!nodes.view.innerHTML.includes('id="pf-pipNo"') && !nodes.view.innerHTML.includes('id="pf-name"') && nodes.view.innerHTML.includes('id="pf-amount"') && nodes.view.innerHTML.includes('id="pf-pdfSent"'), "a numbered PIP's form has the funding and process fields, not its number and name");
ok(!nodes.view.innerHTML.includes('id="pf-milestonesDone"') && !nodes.view.innerHTML.includes('id="pf-milestonesTotal"'), "the milestone counts are not edited by hand any more");
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
for (const k of Object.keys(inputs)) if (k.startsWith("pf-")) delete inputs[k];
await click("pip-cancel");

// ---------- Add PIP and PIPs without a number (editors only) ----------
D.drafts = [{ draftId: null, name: "Old withdrawn idea", phase: "Withdrawn", status: "Actionable", step: "3", draftDate: "2025-07-28", amount: 600000, currency: "USDC" }];
await go("#votes");
ok(text().includes("Not numbered yet") && text().includes("Old withdrawn idea") && nodes.view.innerHTML.includes('data-act="pip-new"'), "editors see the PIPs without a number, and Add PIP");
await click("pip-new");
ok(nodes.view.innerHTML.includes('id="np-name"') && nodes.view.innerHTML.includes('id="np-pdfSent"') && nodes.view.innerHTML.includes('id="np-authUsdc"') && nodes.view.innerHTML.includes('id="np-pipNo"'), "the Add PIP form has the process and funding fields");
inputs["np-name"] = "Council expense wallet"; inputs["np-amount"] = "50000"; inputs["np-currency"] = "USDC";
await click("pip-add");
const ap = calls.filter((c) => c[0] === "addPip").pop();
ok(ap && ap[1].name === "Council expense wallet" && ap[1].phase === "Draft" && ap[1].amount === "50000" && !("pipNo" in ap[1]) && text().includes("without a number yet"), "Add PIP sends the form, as a draft by default: " + JSON.stringify(ap?.[1]));
await click("pip-edit", { key: "name:Old withdrawn idea" });
ok(calls.some((c) => c[0] === "readPip" && c[1] === "name:Old withdrawn idea") && nodes.view.innerHTML.includes('id="pf-pipNo"') && nodes.view.innerHTML.includes('id="pf-name"'), "a PIP without a number opens by its name and offers its number");
inputs["pf-pipNo"] = "99";
await click("pip-save");
const an = calls.filter((c) => c[0] === "savePip").pop();
ok(an && an[1] === "name:Old withdrawn idea" && Object.keys(an[2]).join() === "pipNo" && an[2].pipNo.to === "99" && text().includes("PIP-99 now"), "assigning the number saves only the number: " + JSON.stringify(an?.[2]));
delete inputs["pf-pipNo"];
ctx.Editor.state = { available: true, signedIn: false, email: null, error: null };
ctx.dispatchEvent(new ctx.CustomEvent("editor:change"));
await go("#votes");
ok(!text().includes("Not numbered yet") && !text().includes("Old withdrawn idea"), "visitors do not see PIPs without a number");
ctx.Editor.state = { available: true, signedIn: true, email: "editor@example.org", error: null };
ctx.dispatchEvent(new ctx.CustomEvent("editor:change"));
await tick();

// ---------- milestones: Complete, and the one-time lists from the Tracker ----------
{
  ctx.Editor.core.completeMilestone = async (id, done, by) => { calls.push(["completeMilestone", id, done, by]); return { saved: true, updated: true, pip: 36 }; };
  ctx.Editor.core.importMilestones = async (list) => { calls.push(["importMilestones", list]); return { saved: true, rows: list.reduce((s, x) => s + x.total, 0), pips: list.map((x) => x.pip) }; };
  const p36 = D.pips.find((p) => p.pip === 36);
  if (p36?.milestones?.length) {
    await go("#votes/36");
    const m = p36.milestones[0];
    ok(nodes.view.innerHTML.includes(`data-act="ms-done" data-id="${m.id}"`) && /\d+ completed · \d+ paid of \d+/.test(text()), "a milestone has Complete; the list counts completed and paid");
    await click("ms-done", { id: m.id, pip: "36", done: "1" });
    const cm = calls.find((c) => c[0] === "completeMilestone");
    ok(cm && cm[1] === m.id && cm[2] === true && cm[3] === "editor@example.org" && text().includes("Marked completed"), "Complete saves who signed the milestone off");
  }
  // Two funded PIPs with Tracker counts and no list yet (whatever the test sheet holds now).
  const [imp, imp2] = D.pips.filter((p) => p.funding && p.pip !== 36).slice(0, 2);
  for (const [x, done, total] of [[imp, 1, 2], [imp2, 0, 1]]) { x.milestones = []; x.funding = { ...x.funding, milestones: { done, total } }; }
  await go(`#votes/${imp.pip}`);
  ok(nodes.view.innerHTML.includes(`data-act="ms-import" data-pip="${imp.pip}"`) && text().includes(`The Tracker counts ${imp.funding.milestones.done ?? 0} of ${imp.funding.milestones.total} completed`), "a PIP without a list offers to create it from the Tracker");
  await click("ms-import", { pip: String(imp.pip) });
  const im = calls.find((c) => c[0] === "importMilestones");
  ok(im && im[1].length === 1 && im[1][0].pip === imp.pip && im[1][0].total === imp.funding.milestones.total && text().includes("Created"), "it sends that PIP's Tracker counts: " + JSON.stringify(im?.[1]));
  await go("#payments");
  ok(nodes.view.innerHTML.includes('data-act="ms-import-all"'), "Payments offers the one-time import for every PIP without a list");
  await click("ms-import-all");
  const ia = calls.filter((c) => c[0] === "importMilestones").pop();
  ok(ia && ia[1].length > 1 && ia[1].every((x) => x.total > 0) && text().includes(`for ${ia[1].length} PIPs`), "the import sends every such PIP: " + ia?.[1].length);
}

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
// Existing members: listed live from the tab, edited (incl. hiding) and deleted after a confirm.
{
  let rows = [{ key: "Winston|Term 3|2025-10-01", name: "Winston", role: "Council member", term: "Term 3", start: "2025-10-01", end: "2026-10-01", pip: "25", x: "", discord: "", image: "", wallet: "", show: true }];
  Object.assign(ctx.Editor.core, {
    listMembers: async () => { calls.push(["listMembers"]); return rows; },
    updateMember: async (key, m) => { calls.push(["updateMember", key, m]); return { saved: true, updated: true }; },
    deleteMember: async (key) => { calls.push(["deleteMember", key]); rows = []; return { saved: true, deleted: true }; },
  });
  ok(nodes.view.innerHTML.includes('data-act="mem-list"'), "editors can open the existing members");
  await click("mem-list");
  ok(text().includes("Winston") && nodes.view.innerHTML.includes('data-act="mem-edit" data-key="Winston|Term 3|2025-10-01"'), "the members tab is listed with Edit and Delete");
  await click("mem-edit", { key: "Winston|Term 3|2025-10-01" });
  ok(nodes.view.innerHTML.includes("Save changes") && nodes.view.innerHTML.includes('id="mf-show"') && nodes.view.innerHTML.includes('value="Winston"'), "Edit opens the form filled, with Shown");
  Object.assign(inputs, { "mf-name": "Winston", "mf-role": "Chair", "mf-term": "Term 3", "mf-start": "2025-10-01", "mf-end": "2026-10-01", "mf-pip": "25", "mf-x": "", "mf-discord": "", "mf-image": "", "mf-show": false });
  await click("mem-save");
  const um = calls.filter((c) => c[0] === "updateMember").pop();
  ok(um && um[1] === "Winston|Term 3|2025-10-01" && um[2].role === "Chair" && um[2].show === false && um[2].electedIn === 25 && text().includes("Saved Winston"), "saving sends the row's key, the changes and Shown: " + JSON.stringify(um?.[2]));
  await click("mem-del", { key: "Winston|Term 3|2025-10-01" });
  ok(!calls.some((c) => c[0] === "deleteMember") && text().includes("Delete Winston (Term 3) from the sheet?"), "Delete asks first, in place");
  await click("mem-del-yes", { key: "Winston|Term 3|2025-10-01" });
  ok(calls.some((c) => c[0] === "deleteMember" && c[1] === "Winston|Term 3|2025-10-01") && text().includes("Deleted from the Council members tab") && !text().includes("Delete Winston"), "confirming deletes the row and reloads the list");
}
// Minutes: existing minutes can be deleted after a confirm; new ones have no Delete.
{
  const mt = (D.videos?.meetings ?? []).find((m) => m.minutes);
  if (mt) {
    ctx.Editor.core.deleteMinutes = async (day) => { calls.push(["deleteMinutes", day]); return { saved: true, deleted: 1 }; };
    await click("min-open", { day: mt.day });
    ok(nodes.view.innerHTML.includes('data-act="min-del"'), "existing minutes offer Delete minutes");
    await click("min-del");
    ok(!calls.some((c) => c[0] === "deleteMinutes") && text().includes(`Delete the minutes of ${mt.day} from the sheet?`), "Delete minutes asks first");
    await click("min-del-yes");
    ok(calls.some((c) => c[0] === "deleteMinutes" && c[1] === mt.day) && text().includes(`Deleted the minutes of ${mt.day}`), "confirming deletes that day's minutes");
  }
  await click("min-open");
  ok(!nodes.view.innerHTML.includes('data-act="min-del"'), "new minutes have no Delete");
  await click("min-cancel");
}

// ---------- data health for editors ----------
await go("#health");
ok(nodes.view.innerHTML.includes('id="f-sev"'), "Data health page shown to signed-in editors");
await go("#overview");
ok(nodes.view.innerHTML.includes('data-go="#health"'), "overview shows the Data health tile to signed-in editors");

// ---------- update now ----------
ok(nodes.editbar.innerHTML.includes('data-act="ed-update"'), "Update now button shown to signed-in editors");
await click("ed-update");
ok(calls.some((c) => c[0] === "requestUpdate" && c[1] === "editor@example.org") && nodes.editbar.innerHTML.includes("Update requested at 12:34 UTC"), "Update now asks the sheet for a rebuild and confirms");

// ---------- labels can be changed; DAO-internal transfers cannot be labelled ----------
{
  await go("#transactions");
  const html = nodes.view.innerHTML;
  const auto = D.payments.find((p) => p.direction === "out" && (p.confidence === "matches-sheet" || p.confidence === "matches-amount"));
  const dao = D.payments.find((p) => p.direction === "out" && p.confidence === "internal" && !p.labelled);
  ok(!auto || html.includes(`data-act="lbl-open" data-key="${auto.sig}:${auto.owner ?? ""}"`), "automatically matched payouts can be labelled too");
  ok(!dao || !html.includes(`data-act="lbl-open" data-key="${dao.sig}:${dao.owner ?? ""}"`), "transfers between DAO accounts get no Label button");
  const was = { ...need };
  Object.assign(need, { labelled: true, confidence: "internal", reason: "not a payout", pip: null, category: null });
  await go("#transactions");
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
  D.wallets[1] = { ...D.wallets[1], multisig: { program: "Squads v3", account: "X", label: "Iris Bounty Feast" }, since: "PIP-30", history: [{ name: "Arty", label: "PIP-24", since: null }, { name: "Untracked Wallet", label: "PIP-22", since: "PIP-30" }] };
  await go("#balance");
  ok(text().includes("Multisig") && text().includes("Arty (PIP-24) → PIP-30: Untracked Wallet (PIP-22)"), "a multisig wallet is tagged and a reused wallet shows its purposes");
  await click("wal-reuse", { wallet: D.wallets[1].wallet });
  ok(nodes.view.innerHTML.includes("New purpose for") && nodes.view.innerHTML.includes('id="wf-since"') && !nodes.view.innerHTML.includes('id="wf-wallet"'), "Reuse opens a form for the new purpose with its Since");
  Object.assign(inputs, { "wf-name": "Dashboard", "wf-label": "PIP-36", "wf-since": "PIP-36" });
  delete inputs["wf-wallet"];
  ctx.Editor.core.saveWallet = async (w) => { calls.push(["saveWallet", w]); return { saved: true, added: "purpose" }; };
  await click("wal-save");
  const rw = calls.filter((c) => c[0] === "saveWallet").pop();
  ok(rw && rw[1].reuse === true && rw[1].wallet === D.wallets[1].wallet && rw[1].since === "PIP-36" && text().includes("Added the new purpose Dashboard"), "saving a reuse sends the wallet with reuse and Since: " + JSON.stringify(rw?.[1]));
  // Delete: the purpose being edited, after a confirm; a reused wallet keeps its other purposes.
  ctx.Editor.core.deleteWallet = async (a) => { calls.push(["deleteWallet", a]); return { saved: true, deleted: 1 }; };
  await click("wal-reuse", { wallet: D.wallets[1].wallet });
  ok(!nodes.view.innerHTML.includes('data-act="wal-del"'), "a new purpose has no Delete");
  await click("wal-cancel");
  await click("wal-open", { wallet: D.wallets[1].wallet });
  await click("wal-del");
  ok(!calls.some((c) => c[0] === "deleteWallet") && text().includes("Delete this purpose (since PIP-30) from the sheet? The wallet's other purposes stay."), "Delete asks first and names the purpose");
  await click("wal-del-yes");
  const dw = calls.filter((c) => c[0] === "deleteWallet").pop();
  ok(dw && dw[1].wallet === D.wallets[1].wallet && dw[1].at === "PIP-30" && text().includes("Deleted"), "confirming deletes that purpose: " + JSON.stringify(dw?.[1]));
}

// ---------- counterparty links show only transfers with the DAO account ----------
{
  await go("#transactions");
  const wallet = D.accounts[need.account].wallet;
  ok(nodes.view.innerHTML.includes(`solscan.io/account/${need.owner}?exclude_amount_zero=true&amp;remove_spam=false&amp;from_address=${wallet}#transfers`), "payout counterparty link filters Solscan to transfers from the DAO account");
}

// ---------- payment documents ----------
D.editing.documents = { owner: "owner@example.org", folder: "Payment documents" };
ok(calls.some((c) => c[0] === "listDocs"), "documents are read from the sheet after sign-in");
const dkey = `${need.sig}:${need.owner ?? ""}`;
await go("#transactions");
await click("doc-open", { key: dkey });
ok(nodes.view.innerHTML.includes("Only owner@example.org can upload documents") && /<button class="btn" disabled[^>]*>Upload PDF<\/button>/.test(nodes.view.innerHTML) && !nodes.view.innerHTML.includes('id="doc-files"'), "other editors see a disabled upload button naming the owner");
ctx.Editor.canUpload = () => true;
ctx.Editor.uploadDocs = async (a) => {
  calls.push(["uploadDocs", a]);
  docsInSheet = a.files.map((f) => ({ signature: a.signature, recipient: a.recipient, file: f.name, link: "https://drive.example/" + f.name, at: "2026-11-04 10:00:00", by: "owner@example.org" }));
  return { saved: true, files: a.files.map((f) => f.name) };
};
await go("#transactions");
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
// The owner can remove a document from the payout (the Drive file stays), after a confirm.
ctx.Editor.core.deleteDoc = async (a) => { calls.push(["deleteDoc", a]); docsInSheet = docsInSheet.filter((d) => d.link !== a.link); return { saved: true, deleted: 1 }; };
await click("doc-del", { key: dkey, i: "0" });
ok(!calls.some((c) => c[0] === "deleteDoc") && text().includes("Remove this document from the payout?"), "Remove asks first");
await click("doc-del-yes", { key: dkey });
const dd = calls.filter((c) => c[0] === "deleteDoc").pop();
ok(dd && dd[1].signature === need.sig && dd[1].link === "https://drive.example/a.pdf" && text().includes("Removed from the payout") && !nodes.view.innerHTML.includes("https://drive.example/a.pdf"), "confirming removes that document's row: " + JSON.stringify(dd?.[1]));
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
