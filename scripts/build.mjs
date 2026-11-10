// Build entry point.
//   node scripts/build.mjs            fetch every source, update data/, then compute dist/
//   node scripts/build.mjs --offline  compute dist/ from data/ only (no network)
//
// Phase 1 (fetch) writes raw inputs to data/ — this directory is committed, so the
// repository itself carries the ledger history between runs.
// Phase 2 (compute) derives everything the site shows into dist/data/dashboard.json.
// With config.local.json present, phase 1 writes to data.local/ instead (git-ignored), so a
// local test build never changes the committed data/.
import fs from "node:fs";
import path from "node:path";
import { ROOT, readJSON, writeJSON, log, warn, parseCSV, useLocalData, dataPath } from "./lib/util.mjs";
import { makeRpc } from "./lib/rpc.mjs";
import { fetchTabRaw, fetchTabIndex, resolveTab, sheetSources } from "./lib/sheet.mjs";
import { writeSheetBackup } from "./lib/backup.mjs";
import { loadGovernance } from "./lib/governance.mjs";
import { updateLedger } from "./lib/ledger.mjs";
import { readBalances, readTracked, recordSnapshot } from "./lib/balances.mjs";
import { compute } from "./lib/compute.mjs";
import { updateMultisigActivity } from "./lib/multisig.mjs";
import { updateWalletKinds } from "./lib/walletkinds.mjs";
import { updatePolisLocks } from "./lib/polislocks.mjs";
import { updateYoutube } from "./lib/youtube.mjs";

// config.local.json (git-ignored, optional) is layered over config.json for local testing,
// e.g. a copy of the sheet and test Google IDs, so they never end up in the shared config.
const deepMerge = (a, b) => {
  if (!b || typeof b !== "object" || Array.isArray(b)) return b ?? a;
  const out = { ...(a ?? {}) };
  for (const [k, v] of Object.entries(b)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? deepMerge(out[k], v) : v;
  return out;
};
// NO_LOCAL_CONFIG=1 builds exactly what the shared config describes (e.g. before publishing).
const localConfig = process.env.NO_LOCAL_CONFIG ? null : readJSON("config.local.json", null);
const config = deepMerge(readJSON("config.json"), localConfig);
if (localConfig) {
  console.log("[build] using config.local.json overrides:", Object.keys(localConfig).join(", "), "; state in data.local/");
  useLocalData("data.local");
}
// Safety: local editing must target a copy of the sheet, never the Council's real one.
if (localConfig?.editing?.enabled && !localConfig?.sheet?.id) {
  console.warn("[warn] config.local.json enables editing without a sheet copy (sheet.id); editing stays OFF so a test cannot write to the Council's real sheet.");
  config.editing.enabled = false;
}
const offline = process.argv.includes("--offline");

async function fetchPhase() {
  const rpcUrl = process.env.RPC_URL || config.rpc.default;
  const sigUrl = process.env.SIGNATURES_RPC_URL || config.rpc.signatures;
  const pace = (u) => ({ minIntervalMs: u.includes("api.mainnet-beta") ? 250 : 60 });
  const rpc = makeRpc(rpcUrl, pace(rpcUrl));
  const sigRpc = sigUrl === rpcUrl ? rpc : makeRpc(sigUrl, pace(sigUrl));
  log(`RPC: ${new URL(rpcUrl).host} (signature history: ${new URL(sigUrl).host})`);

  // Tabs are configured by gid or by name; named tabs that don't exist yet resolve to null.
  const tabIndex = await fetchTabIndex(config.sheet.id);
  const T = Object.fromEntries(Object.entries(config.sheet.tabs).map(([k, ref]) => [k, resolveTab(ref, tabIndex)]));
  if (!T.pips) throw new Error(`sheet: PIP tab "${config.sheet.tabs.pips}" not found`);

  // Download every tab once. The raw text is backed up to data/sheet/ (all tabs, cell for cell),
  // and the tabs the dashboard uses are parsed from that same text.
  const allTabs = Object.entries(tabIndex).map(([name, gid]) => ({ name, gid }));
  for (const gid of Object.values(T)) if (gid && !allTabs.some((t) => t.gid === gid)) allTabs.push({ name: null, gid });
  for (const t of allTabs) {
    try { t.text = await fetchTabRaw(config.sheet.id, t.gid); }
    catch (e) { t.text = null; warn(`sheet: tab "${t.name ?? t.gid}" could not be downloaded: ${e.message}`); }
  }
  const byGid = Object.fromEntries(allTabs.map((t) => [t.gid, t.text]));
  // A tab the dashboard uses must download; otherwise the build stops and the last good site stays.
  const rowsOf = (gid) => {
    if (byGid[gid] == null) throw new Error(`sheet: tab ${gid} could not be downloaded`);
    return parseCSV(byGid[gid]);
  };
  const nameOf = (gid) => Object.keys(tabIndex).find((n) => tabIndex[n] === gid) ?? null;
  const tabs = Object.fromEntries(Object.entries(config.sheet.tabs).map(([k, ref]) => [k, { gid: T[k], name: /^\d+$/.test(String(ref)) ? nameOf(T[k]) : ref }]));
  const sources = sheetSources({ rowsOf: (key) => (T[key] ? rowsOf(T[key]) : null), tabs });
  const { labels, members, wallets, council } = sources;
  const pipTab = { pips: sources.pips };
  const backup = writeSheetBackup(allTabs, { complete: Object.keys(tabIndex).length > 0 });
  log(`sheet backup: ${backup.index.length} tabs in ${dataPath("data/sheet")}/${backup.removed.length ? `, removed ${backup.removed.join(", ")}` : ""}${backup.stale.length ? `, kept previous copy of ${backup.stale.join(", ")}` : ""}`);
  writeJSON("data/sources.json", sources);
  log(`sheet: tabs ${Object.entries(tabs).map(([k, t]) => `${k}=${t.name ?? "?"}${t.gid ? "" : " (not created yet)"}`).join(", ")}`);
  log(`sheet: ${pipTab.pips.length} PIPs, ${council?.months.length ?? 0} council months, ${labels.length} payment labels, ${members.length} council members`);

  const gov = await loadGovernance(config.governance.api);
  writeJSON("data/governance.json", { proposals: gov.proposals, fetchedAt: new Date().toISOString() });

  await updateLedger({ rpc, sigRpc }, config);
  await updateMultisigActivity({ rpc, sigRpc }, config);
  await updateYoutube(config);
  const now = await readBalances(rpc, config);
  // A reused wallet has one Wallets row per purpose: each address is read once.
  const tracked = await readTracked(rpc, config, [...new Set(wallets.filter((w) => w.track).map((w) => w.wallet))]);
  await updateWalletKinds({ rpc, sigRpc }, config, wallets.map((w) => w.wallet));
  // POLIS locks: the configured RPC first, the public endpoint as fallback (some providers refuse getProgramAccounts).
  await updatePolisLocks([rpc, ...(rpcUrl === config.rpc.default ? [] : [makeRpc(config.rpc.default, pace(config.rpc.default))])], config);
  recordSnapshot({ ...now, tracked });
  writeJSON("data/now.json", { at: new Date().toISOString(), balances: now, tracked });
  log(`sheet: ${wallets.length} wallets, ${Object.keys(tracked).length} tracked`);
  log(`fetch: ${rpc.calls + (sigRpc === rpc ? 0 : sigRpc.calls)} RPC calls`);
}

function computePhase() {
  const sources = readJSON("data/sources.json");
  const { proposals } = readJSON("data/governance.json");
  const ledger = readJSON("data/ledger.json");
  const history = readJSON("data/balances.json", { days: {} });
  const { balances: now, at: nowAt, tracked = {} } = readJSON("data/now.json");
  const seedLabels = readJSON("data/labels.seed.json", { labels: [] }).labels;
  const councilHistory = readJSON("data/council_history.json", { terms: [] });
  const imported = readJSON("data/balance_history_import.json", {});
  const multisigActivity = readJSON("data/multisig_activity.json", { accounts: {} });
  // Only the answer per wallet; the read cursors stay in the file.
  const walletKinds = { wallets: Object.fromEntries(Object.entries(readJSON("data/wallet_kinds.json", { wallets: {} }).wallets).map(([w, k]) => [w, { multisig: k.multisig, program: k.program ?? null, account: k.account ?? null }])) };
  const youtube = readJSON("data/youtube.json", { videos: {} });
  const polisLocks = readJSON("data/polis_locks.json", { latest: null }).latest;
  const { out, recon, flags } = compute({
    config, sources, proposals, ledger, history, now, nowAt, tracked, seedLabels, councilHistory, imported, multisigActivity, walletKinds, youtube, polisLocks,
    votesOf: (pip) => readJSON(`data/votes/${pip}.json`, null), editingPreview: Boolean(process.env.EDITING_PREVIEW),
  });
  const dist = path.join(ROOT, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  copyDir(path.join(ROOT, "site"), dist);
  // The Council manual, shown to signed-in editors on the Help page.
  fs.copyFileSync(path.join(ROOT, "MANUAL_COUNCIL.md"), path.join(dist, "MANUAL_COUNCIL.md"));
  fs.mkdirSync(path.join(dist, "lib"), { recursive: true });
  writeJSON("dist/data/dashboard.json", out, false);
  copyDir(path.join(ROOT, "data", "votes"), path.join(dist, "data", "votes"));
  if (dataPath("data/votes") !== "data/votes") copyDir(path.join(ROOT, dataPath("data/votes")), path.join(dist, "data", "votes"));

  // Live sheet: the page reads the sheet's tabs itself and redoes this calculation in the browser, so
  // a sheet edit shows on the next page load. It needs the calculation modules and the chain-side
  // inputs; those only change with a build. The RPC settings stay out (the page never reads the chain).
  // Served as .js (every web server sends that as JavaScript; some send .mjs as a download), imports renamed to match.
  for (const f of LIVE_MODULES) {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "lib", f), "utf8").replace(/(from\s+"\.\/[a-z]+)\.mjs"/g, '$1.js"');
    fs.writeFileSync(path.join(dist, "lib", f.replace(/\.mjs$/, ".js")), src);
  }
  const { rpc: _rpc, ...pageConfig } = config;
  writeJSON("dist/data/live.json", {
    // Named tabs that did not exist at build time are listed without a gid; the page looks them up.
    builtAt: out.generatedAt, sheetId: config.sheet.id,
    tabs: { ...Object.fromEntries(Object.entries(config.sheet.tabs).filter(([, ref]) => !/^\d+$/.test(String(ref))).map(([k, ref]) => [k, { name: ref, gid: null }])), ...(sources.tabs ?? {}) },
    // Ledger rows carry only what the calculation reads (no token accounts or slots), to keep the file small.
    inputs: { config: pageConfig, proposals, ledger: { rows: ledger.rows.map((r) => ({ sig: r.sig, t: r.t, account: r.account, symbol: r.symbol, delta: r.delta, legs: r.legs.map((l) => ({ owner: l.owner, amount: l.amount, dao: l.dao })) })), unread: ledger.unread ?? [] }, history, now, nowAt, tracked, seedLabels, councilHistory, imported, walletKinds, youtube, polisLocks,
      // The page only needs each multisig's transactions per day, not the transaction records.
      multisigActivity: { accounts: Object.fromEntries(Object.entries(multisigActivity.accounts ?? {}).map(([k, v]) => [k, { days: v.days }])) } },
  }, false);

  const paidCount = recon.summary.filter((s) => s.state === "paid").length;
  log(`compute: ${out.pips.length} PIPs, ${recon.summary.length} funded, ${paidCount} fully paid, ${out.payments.length} payment legs, ${flags.length} health flags`);
  return out;
}

// The calculation and the sheet parsers, served to the page as ES modules (no other files: these import only each other).
const LIVE_MODULES = ["compute.mjs", "reconcile.mjs", "limit.mjs", "budget.mjs", "health.mjs", "members.mjs", "series.mjs", "pure.mjs", "sheetparse.mjs", "videos.mjs", "plans.mjs"];

function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name), b = path.join(to, e.name);
    if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}
const round2 = (n) => Math.round(n * 100) / 100;

async function main() {
  const t0 = Date.now();
  if (!offline) await fetchPhase();
  computePhase();
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch((e) => { console.error(e); process.exit(1); });
