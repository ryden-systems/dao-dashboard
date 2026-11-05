// Live sheet: the page redoes the build's calculation in the browser from the raw sheet tabs.
// This runs that same path (the modules the build copies to dist/lib, data/live.json and the sheet's
// raw CSV backup) and checks it gives exactly what the build published in dashboard.json.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "../scripts/lib/util.mjs";

const dist = path.join(ROOT, "dist");
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log("FAIL " + m); } };

const lib = (f) => import(pathToFileURL(path.join(dist, "lib", f)).href);
const { compute } = await lib("compute.js");
const { sheetSources } = await lib("sheetparse.js");
const { parseCSV } = await lib("pure.js");
for (const f of fs.readdirSync(path.join(dist, "lib"))) {
  ok(!/from\s+["']node:/.test(fs.readFileSync(path.join(dist, "lib", f), "utf8")), `dist/lib/${f} must not use Node modules (it runs in the browser)`);
}

const live = JSON.parse(fs.readFileSync(path.join(dist, "data", "live.json"), "utf8"));
const built = JSON.parse(fs.readFileSync(path.join(dist, "data", "dashboard.json"), "utf8"));
ok(!("rpc" in live.inputs.config), "the page's copy of the config leaves out the RPC settings");

// The raw sheet backup the build wrote (data.local/ for a local test build, data/ otherwise).
const localDir = path.join(ROOT, "data.local", "sheet");
const useLocal = fs.existsSync(path.join(ROOT, "config.local.json")) && !process.env.NO_LOCAL_CONFIG && fs.existsSync(localDir);
const sheetDir = useLocal ? localDir : path.join(ROOT, "data", "sheet");
const index = JSON.parse(fs.readFileSync(path.join(sheetDir, "index.json"), "utf8"));
const fileOf = Object.fromEntries(index.tabs.map((t) => [String(t.gid), t.file]));
const rowsOf = (key) => {
  const gid = live.tabs[key]?.gid;
  return gid && fileOf[gid] ? parseCSV(fs.readFileSync(path.join(sheetDir, fileOf[gid]), "utf8")) : null;
};

const sources = sheetSources({ rowsOf, tabs: live.tabs });
const { out } = compute({ ...live.inputs, sources, generatedAt: live.builtAt });
out.voters = built.voters; out.editing = built.editing;
const strip = (d) => { const c = structuredClone(d); delete c.sources.sheetFetchedAt; return c; };
const a = strip(out), b = strip(built);
for (const k of Object.keys(b)) ok(JSON.stringify(a[k]) === JSON.stringify(b[k]), `live calculation differs from the build in "${k}"`);
ok(Object.keys(a).length === Object.keys(b).length, "live calculation has the same sections as the build");

console.log(failed ? `\n${failed} failed, ${passed} passed` : `all ${passed} live-sheet checks passed`);
process.exit(failed ? 1 : 0);
