// Preview mode (evaluation copies only): the "Editor sign-in" button is shown and opens an
// explanation, but nothing can sign in and no editing controls or sheet access exist.
//   node test/editor_preview.test.mjs   (after a build)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "../scripts/lib/util.mjs";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log("FAIL", m); } };
const dist = path.join(ROOT, "dist");
const D = JSON.parse(fs.readFileSync(path.join(dist, "data", "dashboard.json"), "utf8"));
D.editing = { preview: true };

const el = (id) => ({ id, hidden: false, innerHTML: "", dataset: {}, style: {}, addEventListener() {}, querySelectorAll: () => [] });
const nodes = { view: el("view"), stamp: el("stamp"), foot: el("foot"), tip: el("tip"), editbar: el("editbar") };
// The header bar and the page body have separate click listeners, as in the browser.
const barClicks = [], viewClicks = [], winL = {};
nodes.view.addEventListener = (t, fn) => { if (t === "click") viewClicks.push(fn); };
nodes.editbar.addEventListener = (t, fn) => { if (t === "click") barClicks.push(fn); };
const loaded = [];
const ctx = {
  console, setTimeout, clearTimeout, Intl, Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise,
  location: { hash: "#payments" }, innerWidth: 1200, scrollTo() {},
  document: { querySelector: (s) => nodes[s.replace(/^#/, "")] ?? null, querySelectorAll: () => [], getElementById: (id) => nodes[id] ?? null, head: { appendChild: (s) => loaded.push(s.src) }, createElement: () => ({}) },
  addEventListener: (t, fn) => { (winL[t] ??= []).push(fn); },
  dispatchEvent: (ev) => { for (const fn of winL[ev.type] ?? []) fn(ev); },
  CustomEvent: class { constructor(t, i) { this.type = t; this.detail = i?.detail; } },
  fetch: async () => ({ ok: true, status: 200, json: async () => D }),
};
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ["charts.js", "sheetmap.js", "editor.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(dist, f), "utf8"), ctx, { filename: f });
await new Promise((r) => setTimeout(r, 30));

ok(nodes.editbar.innerHTML.includes("Editor sign-in") && nodes.editbar.innerHTML.includes('data-act="ed-preview"'), "preview shows the Editor sign-in button");
ok(!ctx.Editor.core, "preview has no sheet access at all");
ok(!loaded.some((s) => /accounts\.google\.com|apis\.google\.com/.test(s)), "preview loads no Google sign-in scripts");
const target = { dataset: { act: "ed-preview" }, closest: (s) => (s === "[data-act]" ? target : null) };
const send = async (fns) => { for (const fn of fns) fn({ target, preventDefault() {} }); await new Promise((r) => setTimeout(r, 20)); };
await send(barClicks); // the header button
const html = nodes.view.innerHTML;
ok(html.includes("Editing from the dashboard") && html.includes("switched off in this preview"), "header button opens the explanation");
ok(!html.includes('data-act="lbl-open"') && !html.includes('data-act="pip-edit"') && !html.includes("Edit the Council list"), "no editing controls in preview");
await send(viewClicks); // the panel's own Close button lives in the page body
ok(!nodes.view.innerHTML.includes("Editing from the dashboard"), "Close button hides the explanation again");

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} preview checks passed`);
process.exit(failed ? 1 : 0);
