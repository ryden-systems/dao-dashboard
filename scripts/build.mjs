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
import { fetchTabRaw, fetchTabIndex, resolveTab, parsePipTab, parseCouncilTab, parseLabelTab, parseMembersTab, parseWalletsTab } from "./lib/sheet.mjs";
import { writeSheetBackup } from "./lib/backup.mjs";
import { councilTerms } from "./lib/members.mjs";
import { loadGovernance } from "./lib/governance.mjs";
import { updateLedger } from "./lib/ledger.mjs";
import { readBalances, readTracked, recordSnapshot, rebuildSeries, fullyIndexed } from "./lib/balances.mjs";
import { reconcile } from "./lib/reconcile.mjs";
import { fundLimits } from "./lib/limit.mjs";
import { healthChecks } from "./lib/health.mjs";

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
  const pipTab = parsePipTab(rowsOf(T.pips));
  const council = T.council ? parseCouncilTab(rowsOf(T.council)) : null;
  const labels = T.paymentLabels ? parseLabelTab(rowsOf(T.paymentLabels)) : [];
  const members = T.councilMembers ? parseMembersTab(rowsOf(T.councilMembers)) : [];
  const wallets = T.wallets ? parseWalletsTab(rowsOf(T.wallets)) : [];
  const backup = writeSheetBackup(allTabs, { complete: Object.keys(tabIndex).length > 0 });
  log(`sheet backup: ${backup.index.length} tabs in ${dataPath("data/sheet")}/${backup.removed.length ? `, removed ${backup.removed.join(", ")}` : ""}${backup.stale.length ? `, kept previous copy of ${backup.stale.join(", ")}` : ""}`);
  const nameOf = (gid) => Object.keys(tabIndex).find((n) => tabIndex[n] === gid) ?? null;
  const tabs = Object.fromEntries(Object.entries(config.sheet.tabs).map(([k, ref]) => [k, { gid: T[k], name: /^\d+$/.test(String(ref)) ? nameOf(T[k]) : ref }]));
  writeJSON("data/sources.json", { ...pipTab, council, labels, members, wallets, tabs, fetchedAt: new Date().toISOString() });
  log(`sheet: tabs ${Object.entries(tabs).map(([k, t]) => `${k}=${t.name ?? "?"}${t.gid ? "" : " (not created yet)"}`).join(", ")}`);
  log(`sheet: ${pipTab.pips.length} PIPs, ${council?.months.length ?? 0} council months, ${labels.length} payment labels, ${members.length} council members`);

  const gov = await loadGovernance(config.governance.api);
  writeJSON("data/governance.json", { proposals: gov.proposals, fetchedAt: new Date().toISOString() });

  await updateLedger({ rpc, sigRpc }, config);
  const now = await readBalances(rpc, config);
  const tracked = await readTracked(rpc, config, wallets.filter((w) => w.track).map((w) => w.wallet));
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
  const nowTs = Date.parse(nowAt) / 1000;

  // Sheet labels override seed labels for the same payout.
  const labels = [...seedLabels.filter((s) => !sources.labels.some((l) => l.signature === s.signature)), ...sources.labels];
  const recon = reconcile({ pips: sources.pips, ledger, labels, wallets: sources.wallets ?? [], config });
  const limit = fundLimits({ ledger, fundNow: now.fund.ATLAS, percent: config.fundLimit.percent, nowTs });
  const flags = healthChecks({ pips: sources.pips, missingColumns: sources.missingColumns, proposals, recon, ledger, history, now, config, nowTs });
  // A payout labelled in more than one row: the last row is used, which is easy to miss in the sheet.
  const labelCount = new Map();
  for (const l of sources.labels) labelCount.set(`${l.signature}:${l.recipient}`, (labelCount.get(`${l.signature}:${l.recipient}`) ?? 0) + 1);
  for (const [k, n] of labelCount) {
    if (n > 1) flags.push({ severity: "warning", area: "payments", message: `Payment labels: payout ${k.slice(0, 8)}… is labelled in ${n} rows; the last one is used. Delete the others, or relabel it from the dashboard (that removes them).` });
  }
  const council = councilTerms({ sheetMembers: sources.members ?? [], proposals, history: readJSON("data/council_history.json", { terms: [] }) });
  for (const w of council.warnings) flags.push({ severity: "warning", area: "council", message: w });
  const sevOrder = { critical: 0, warning: 1, info: 2 };
  flags.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity] || (a.pip ?? 0) - (b.pip ?? 0));

  // Balance history: exact series where the ledger is complete, daily snapshots elsewhere. Where
  // snapshots started late, a one-time import of earlier daily balances (balance_history_import.json)
  // fills the time before the first snapshot.
  const imported = readJSON("data/balance_history_import.json", {});
  const series = {};
  for (const account of Object.keys(config.accounts)) {
    for (const symbol of ["ATLAS", "USDC"]) {
      const key = `${account}${symbol}`;
      if (fullyIndexed(config, account, symbol)) {
        series[key] = { source: "ledger", points: rebuildSeries(ledger, now[account][symbol], account, symbol, nowTs) };
        continue;
      }
      const snaps = Object.entries(history.days).sort().map(([d, s]) => [d, s[account]?.[symbol] ?? null]).filter(([, v]) => v != null);
      const before = (imported[account]?.[symbol] ?? []).filter(([d]) => !snaps.length || d < snaps[0][0]);
      series[key] = { source: before.length ? "import+snapshots" : "snapshots", snapshotsFrom: snaps[0]?.[0] ?? null, points: [...before, ...snaps] };
    }
  }

  // One record per PIP: sheet + governance API + payment summary.
  const api = new Map(proposals.map((p) => [p.pip, p]));
  const pay = new Map(recon.summary.map((s) => [s.pip, s]));
  const pipNums = [...new Set([...sources.pips.map((p) => p.pip), ...proposals.map((p) => p.pip)])].sort((a, b) => a - b);
  const pips = pipNums.map((n) => {
    const s = sources.pips.find((p) => p.pip === n);
    const a = api.get(n);
    return {
      pip: n,
      name: s?.name || a?.title,
      title: a?.title ?? s?.name,
      id: a?.id ?? null,
      url: a ? `${config.governance.site}${a.id}` : null,
      categories: a?.categories ?? [],
      category: s?.category ?? null,
      sacTerm: s?.sacTerm ?? null,
      phase: s?.phase ?? null,
      outcome: a?.outcome ?? (s?.voteResult || "").toLowerCase(),
      votingStartsAt: a?.votingStartsAt ?? null,
      votingEndsAt: a?.votingEndsAt ?? null,
      options: a?.options ?? [],
      totalVotes: a?.totalVotes ?? s?.sheetVotes ?? null,
      totalPvp: a?.totalPvp ?? null,
      daoPvpM: s?.sheetTotalPvpM ?? null,
      ranked: Boolean(a?.ranked),
      seats: a?.ranked ? a.winners : null,
      distinctBallots: a?.distinctBallots ?? null,
      candidates: a?.candidates ?? null,
      amount: s?.amount?.value ?? null,
      currency: s?.currency ?? null,
      ecosystemFund: s?.ecosystemFund ?? false,
      roi: s?.roi ?? "",
      note: s?.note ?? "",
      funding: pay.get(n) ?? null,
    };
  });

  // Recurring inflow sources (e.g. marketplace fee sweeps) are summarised per month;
  // every other movement is listed individually.
  const incomeLegs = recon.legs.filter((l) => l.direction === "in" && l.confidence === "income");
  const perOwner = new Map();
  for (const l of incomeLegs) perOwner.set(l.owner, (perOwner.get(l.owner) ?? 0) + 1);
  const known = config.knownWallets ?? {};
  const recurring = new Set([...perOwner].filter(([o, n]) => n >= (config.income?.recurringMinTransfers ?? 20) || known[o]).map(([o]) => o));
  const monthly = new Map();
  const sourceTotals = new Map();
  for (const l of incomeLegs) {
    if (!recurring.has(l.owner)) continue;
    const m = new Date(l.t * 1000).toISOString().slice(0, 7);
    const row = monthly.get(m) ?? { month: m, ATLAS: 0, USDC: 0, transfers: 0 };
    row[l.symbol] = (row[l.symbol] ?? 0) + l.amount;
    row.transfers++;
    monthly.set(m, row);
    const s = sourceTotals.get(l.owner) ?? { owner: l.owner, label: known[l.owner] ?? null, transfers: 0, totals: {} };
    s.transfers++;
    s.totals[l.symbol] = round2((s.totals[l.symbol] ?? 0) + l.amount);
    sourceTotals.set(l.owner, s);
  }
  const income = {
    sources: [...sourceTotals.values()],
    monthly: [...monthly.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({ ...r, ATLAS: round2(r.ATLAS), USDC: round2(r.USDC) })),
  };

  const out = {
    generatedAt: new Date().toISOString(),
    dataAt: nowAt,
    sources: {
      sheet: `https://docs.google.com/spreadsheets/d/${config.sheet.id}`,
      governance: config.governance.api,
      sheetFetchedAt: sources.fetchedAt,
    },
    accounts: Object.fromEntries(Object.entries(config.accounts).map(([k, a]) => [k, { label: a.label, wallet: a.wallet, now: now[k] }])),
    pips,
    knownWallets: known,
    // Names for counterparties: the Council's "Wallets" tab, plus known income sources from config.
    walletNames: { ...known, ...Object.fromEntries((sources.wallets ?? []).filter((w) => w.name).map((w) => [w.wallet, w.name])) },
    wallets: (sources.wallets ?? []).map((w) => ({ ...w, now: w.track ? tracked[w.wallet] ?? null : null })),
    income,
    payments: recon.legs
      .filter((l) => l.amount > 0 && !(l.confidence === "income" && recurring.has(l.owner)))
      .map((l) => ({ sig: l.sig, t: l.t, account: l.account, symbol: l.symbol, amount: round2(l.amount), direction: l.direction, owner: l.owner, confidence: l.confidence, pip: l.pip, category: l.category ?? null, labelled: Boolean(l.labelled), reason: l.reason, isReturn: Boolean(l.isReturn) }))
      .sort((a, b) => b.t - a.t),
    limit,
    series,
    council: sources.council,
    councilTerms: { source: council.source, note: council.note, terms: council.terms },
    testNotice: config.sheet.testNotice || null,
    // Two-way editing: public identifiers only. Off unless enabled and a client ID is set.
    // EDITING_PREVIEW=1 (evaluation previews only) shows the sign-in button with an explanation
    // instead of a working sign-in, so no preview can write to any sheet.
    editing: config.editing?.enabled && config.editing.googleClientId
      ? {
          googleClientId: config.editing.googleClientId,
          sheetId: config.sheet.id,
          tabs: Object.fromEntries(Object.entries(sources.tabs ?? {}).map(([k, t]) => [k, t.name])),
          // Payment documents: only this account may upload (named on the disabled button for everyone else).
          documents: config.editing.documents?.owner ? { owner: config.editing.documents.owner, folder: config.editing.documents.folder || "Payment documents" } : null,
        }
      : process.env.EDITING_PREVIEW ? { preview: true } : null,
    health: flags,
  };

  const dist = path.join(ROOT, "dist");
  fs.rmSync(dist, { recursive: true, force: true });
  copyDir(path.join(ROOT, "site"), dist);
  writeJSON("dist/data/dashboard.json", out, false);
  copyDir(path.join(ROOT, "data", "votes"), path.join(dist, "data", "votes"));
  if (dataPath("data/votes") !== "data/votes") copyDir(path.join(ROOT, dataPath("data/votes")), path.join(dist, "data", "votes"));

  const paidCount = recon.summary.filter((s) => s.state === "paid").length;
  log(`compute: ${pips.length} PIPs, ${recon.summary.length} funded, ${paidCount} fully paid, ${out.payments.length} payment legs, ${flags.length} health flags`);
  return out;
}

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
