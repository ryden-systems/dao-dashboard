// Smoke test: renders every page of the built site against the real dist/data
// with a minimal DOM stand-in, and fails on any runtime error or empty page.
//   node test/smoke.mjs   (run after a build)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { ROOT } from "../scripts/lib/util.mjs";

const dist = path.join(ROOT, "dist");
if (!fs.existsSync(path.join(dist, "data", "dashboard.json"))) { console.error("dist/ not built; run the build first"); process.exit(1); }

function el(id) {
  return {
    id, hidden: false, dataset: {}, style: {}, innerHTML: "", clientWidth: 900,
    addEventListener() {}, setAttribute() {}, scrollIntoView() {},
    querySelector: () => null, querySelectorAll: () => [],
  };
}
const nodes = { view: el("view"), stamp: el("stamp"), foot: el("foot"), notice: el("notice"), tip: el("tip") };
const listeners = {};
const errors = [];

const ctx = {
  console,
  setTimeout, clearTimeout, Intl, Date, Math, JSON, Number, String, Object, Array, Map, Set, Promise,
  location: { hash: "" },
  innerWidth: 1200,
  scrollTo() {},
  document: {
    querySelector: (s) => nodes[s.replace(/^#/, "")] ?? null,
    querySelectorAll: () => [],
    getElementById: (id) => nodes[id] ?? null,
  },
  addEventListener: (type, fn) => { (listeners[type] ??= []).push(fn); },
  fetch: async (url) => {
    const file = path.join(dist, url.split("?")[0]);
    const ok = fs.existsSync(file);
    return { ok, status: ok ? 200 : 404, json: async () => JSON.parse(fs.readFileSync(file, "utf8")) };
  },
};
ctx.window = ctx;
vm.createContext(ctx);
ctx.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
ctx.dispatchEvent = (ev) => { for (const fn of listeners[ev.type] ?? []) fn(ev); };
for (const f of ["charts.js", "sheetmap.js", "editor.js", "app.js"]) vm.runInContext(fs.readFileSync(path.join(dist, f), "utf8"), ctx, { filename: f });

const tick = () => new Promise((r) => setTimeout(r, 30));
await tick();

const D = JSON.parse(fs.readFileSync(path.join(dist, "data", "dashboard.json"), "utf8"));
const lastPip = D.pips[D.pips.length - 1].pip;
const routes = ["overview", "payments", "council", "limit", "balance", "votes", `votes/${lastPip}`, "health"];
let failed = 0;
for (const r of routes) {
  ctx.location.hash = "#" + r;
  try {
    for (const fn of listeners.hashchange ?? []) fn();
    await tick(); // vote detail loads asynchronously and re-renders
    const html = nodes.view.innerHTML;
    const len = html.length;
    const bad = /undefined|NaN|\[object Object\]/.exec(html.replace(/<[^>]+>/g, " "));
    if (len < 200) throw new Error(`page is nearly empty (${len} chars)`);
    if (bad) throw new Error(`rendered text contains "${bad[0]}"`);
    // Council members: every term (current, incoming, past) is listed on the Council page.
    if (r === "council") {
      const expected = (D.councilTerms?.terms ?? []).flatMap((t) => t.members);
      const htmlText = html.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
      const missing = expected.filter((m) => !htmlText.includes(m.name));
      if (missing.length) throw new Error(`council members missing from #${r}: ${missing.map((m) => m.name).join(", ")}`);
    }
    console.log(`ok   #${r.padEnd(14)} ${len} chars`);
  } catch (e) {
    failed++;
    console.log(`FAIL #${r.padEnd(14)} ${e.message}`);
  }
}
if (!nodes.stamp.innerHTML.includes("Data as of")) { failed++; console.log("FAIL header stamp not set"); }
const builtData = JSON.parse(fs.readFileSync(path.join(dist, "data", "dashboard.json"), "utf8"));
if (builtData.testNotice && !nodes.notice.innerHTML.includes(builtData.testNotice.slice(0, 12))) { failed++; console.log("FAIL test-sheet notice not shown"); }
if (!nodes.foot.innerHTML.includes("third-party created service")) { failed++; console.log("FAIL third-party disclaimer missing from footer"); }
if (errors.length) failed += errors.length;
console.log(failed ? `\n${failed} failure(s)` : "\nall pages render");
process.exit(failed ? 1 : 0);
