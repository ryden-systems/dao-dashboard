// Live sheet: reads the Council's sheet straight from Google when the page opens (and again after an
// editor saves, when the tab comes back into view, and every few minutes), then redoes the build's
// calculation in the browser with the same code. A sheet edit therefore shows without waiting for a
// build. Chain data (transactions, balances) still comes from the last build. If anything here
// fails, the page simply keeps the built data.
import { compute } from "./lib/compute.js";
import { sheetSources } from "./lib/sheetparse.js";
import { parseCSV } from "./lib/pure.js";

const EVERY_MS = 3 * 60 * 1000;
let base = null, live = null, running = null, lastAt = 0;

async function readSheet() {
  const tabs = Object.entries(live.tabs).filter(([, t]) => t?.gid);
  const texts = await Promise.all(tabs.map(async ([key, t]) => {
    const r = await fetch(`https://docs.google.com/spreadsheets/d/${live.sheetId}/export?format=csv&gid=${t.gid}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`sheet tab ${t.name ?? t.gid}: HTTP ${r.status}`);
    return [key, await r.text()];
  }));
  const csv = Object.fromEntries(texts);
  return sheetSources({ rowsOf: (key) => (csv[key] != null ? parseCSV(csv[key]) : null), tabs: live.tabs });
}

async function run() {
  live ??= await (await fetch("data/live.json", { cache: "no-cache" })).json();
  const sources = await readSheet();
  const { out } = compute({ ...live.inputs, sources, generatedAt: live.builtAt });
  // Kept from the build: the largest-voters table (needs every vote file) and the editing setup.
  out.voters = base.voters;
  out.editing = base.editing;
  lastAt = Date.now();
  window.dispatchEvent(new CustomEvent("dash:data", { detail: { D: out, at: new Date(lastAt) } }));
}

function refresh() {
  if (!base) return Promise.resolve();
  running ??= run().catch((e) => { console.info("[live] sheet not read, showing the built data:", e.message); }).finally(() => { running = null; });
  return running;
}

function start() {
  base = window.__dashBase;
  if (!base) return;
  refresh();
  setInterval(() => { if (document.visibilityState === "visible") refresh(); }, EVERY_MS);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && Date.now() - lastAt > 60000) refresh(); });
}

window.DashLive = { refresh };
if (window.__dashBase) start(); else window.addEventListener("dash:ready", start, { once: true });
