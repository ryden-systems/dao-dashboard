// Raw sheet backup (data/sheet/): exact copies, safe names, failed downloads keep the previous
// copy, and deleted tabs are only removed when the tab list is known to be complete.
//   node test/backup.test.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../scripts/lib/util.mjs";
import { writeSheetBackup, backupFileName } from "../scripts/lib/backup.mjs";

let failed = 0, passed = 0;
const ok = (c, m) => { if (c) passed++; else { failed++; console.log("FAIL", m); } };
const dir = "test/tmp-backup";
const abs = path.join(ROOT, dir);
fs.rmSync(abs, { recursive: true, force: true });
const read = (f) => fs.readFileSync(path.join(abs, f), "utf8");

const tracker = fs.readFileSync(path.join(ROOT, "test", "fixtures", "tracker.csv"), "utf8");
const tricky = 'a,"b, with comma","multi\nline",d\n1,2,3,4\n';

// 1. first run
let r = writeSheetBackup([
  { name: "Tracker", gid: "0", text: tracker },
  { name: "Odd/Name: here?", gid: "11", text: tricky },
  { name: "tracker", gid: "12", text: "x\n" },
], { complete: true, fetchedAt: "2026-10-09T00:00:00Z", dir });
ok(read("Tracker.csv") === tracker, "Tracker copied byte for byte");
ok(fs.existsSync(path.join(abs, "Odd_Name_ here_.csv")) && read("Odd_Name_ here_.csv") === tricky, "unsafe characters replaced, quoted newlines preserved");
ok(fs.existsSync(path.join(abs, "tracker (12).csv")), "same name in different case gets the tab id appended");
const idx = JSON.parse(read("index.json"));
ok(idx.tabs.length === 3 && idx.tabs[0].bytes === Buffer.byteLength(tracker), "index lists tabs with sizes");
ok(idx.tabs[1].rows === 2, "row count respects quoted newlines");
ok(backupFileName("", "99", new Set()) === "tab-99.csv", "unnamed tab gets a stable name");

// 2. second run: one tab failed, one tab deleted from the sheet
r = writeSheetBackup([
  { name: "Tracker", gid: "0", text: null },
  { name: "Odd/Name: here?", gid: "11", text: "changed\n" },
], { complete: true, fetchedAt: "2026-10-10T00:00:00Z", dir });
ok(read("Tracker.csv") === tracker, "failed download keeps the previous copy");
ok(r.stale.includes("Tracker") && JSON.parse(read("index.json")).tabs[0].stale === true, "failed tab marked stale");
ok(read("Odd_Name_ here_.csv") === "changed\n", "changed tab overwritten");
ok(!fs.existsSync(path.join(abs, "tracker (12).csv")) && r.removed.includes("tracker (12).csv"), "tab deleted from the sheet is removed");

// 3. incomplete tab list: nothing is removed
fs.writeFileSync(path.join(abs, "Extra.csv"), "keep me\n");
writeSheetBackup([{ name: "Tracker", gid: "0", text: tracker }], { complete: false, dir });
ok(fs.existsSync(path.join(abs, "Extra.csv")), "nothing removed when the tab list may be incomplete");

fs.rmSync(abs, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} backup checks passed`);
process.exit(failed ? 1 : 0);
