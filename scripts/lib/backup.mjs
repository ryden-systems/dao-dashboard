// Raw backup of the Council's sheet: every tab, cell for cell, exactly as Google's CSV export
// returns it, written to data/sheet/ and versioned by git on every build. If Google Sheets ever
// became unavailable, every value of every tab (not just the columns the dashboard uses) would
// still be in the repository and its history. Formulas and formatting are not included: the
// export only contains values.
import fs from "node:fs";
import path from "node:path";
import { ROOT, writeJSON, parseCSV, dataPath } from "./util.mjs";

export const BACKUP_DIR = "data/sheet";

// "Lanzer Grading Rubric" -> "Lanzer Grading Rubric.csv"; unsafe characters become "_".
export function backupFileName(name, gid, taken) {
  let base = String(name || `tab-${gid}`).replace(/[^A-Za-z0-9 _.-]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80) || `tab-${gid}`;
  if (taken.has(base.toLowerCase())) base = `${base} (${gid})`;
  taken.add(base.toLowerCase());
  return `${base}.csv`;
}

// tabs: [{ name, gid, text }] where text is the raw CSV, or null if that tab failed to download.
// complete: true when the list of tabs itself is known to be complete (so files of tabs that no
// longer exist may be removed). A failed download never deletes the previous copy of that tab.
export function writeSheetBackup(tabs, { complete, fetchedAt = new Date().toISOString(), dir = BACKUP_DIR } = {}) {
  const abs = path.join(ROOT, dataPath(dir));
  fs.mkdirSync(abs, { recursive: true });
  const prev = (() => { try { return JSON.parse(fs.readFileSync(path.join(abs, "index.json"), "utf8")); } catch { return { tabs: [] }; } })();
  const taken = new Set();
  const index = [];
  const keep = new Set(["index.json"]);
  for (const t of tabs) {
    const file = backupFileName(t.name, t.gid, taken);
    keep.add(file);
    if (t.text == null) {
      const old = prev.tabs.find((x) => x.gid === t.gid);
      index.push({ name: t.name, gid: t.gid, file, bytes: old?.bytes ?? null, rows: old?.rows ?? null, fetchedAt: old?.fetchedAt ?? null, stale: true });
      continue;
    }
    fs.writeFileSync(path.join(abs, file), t.text);
    const rows = t.text ? parseCSV(t.text).length : 0;
    index.push({ name: t.name, gid: t.gid, file, bytes: Buffer.byteLength(t.text), rows, fetchedAt });
  }
  const removed = [];
  if (complete) {
    for (const f of fs.readdirSync(abs)) {
      if (!keep.has(f) && f.endsWith(".csv")) { fs.unlinkSync(path.join(abs, f)); removed.push(f); }
    }
  }
  writeJSON(`${dir}/index.json`, { note: "Raw CSV export of every tab of the Council's sheet (values only), one file per tab.", fetchedAt, tabs: index });
  return { index, removed, stale: index.filter((t) => t.stale).map((t) => t.name) };
}
