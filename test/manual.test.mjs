// Keeps the Council manual and the dashboard in step. In MANUAL_COUNCIL.md bold is used only for what the
// dashboard shows (buttons, fields, tags), so:
//  - every bold text in the manual must appear in the dashboard's code (a renamed or removed button fails here),
//  - every editor button of the dashboard must be named in the manual (a new, undocumented button fails here).
//   node test/manual.test.mjs
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../scripts/lib/util.mjs";

let failed = 0, passed = 0;
const ok = (cond, msg) => { if (cond) passed++; else { failed++; console.log("FAIL", msg); } };
const flat = (s) => s.replace(/\s+/g, " ");

const manual = fs.readFileSync(path.join(ROOT, "MANUAL_COUNCIL.md"), "utf8");
const source = flat(["site/app.js", "site/index.html"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n"));
const bold = [...new Set([...manual.matchAll(/\*\*([^*]+)\*\*/g)].map((m) => flat(m[1]).trim()))];

// Manual -> dashboard
for (const b of bold) ok(source.includes(b), `the manual names "${b}", which the dashboard no longer shows`);

// Dashboard -> manual: buttons with a fixed label, plus the ones whose label changes with their state.
const app = fs.readFileSync(path.join(ROOT, "site", "app.js"), "utf8");
const fixed = [...app.matchAll(/data-act="([a-z-]+)"[^>]*>([^<$]{2,60})</g)].map((m) => flat(m[2]).trim()).filter(Boolean);
const changing = ["Label", "Relabel", "Documents", "Complete", "Reopen", "Mark paid", "Tick", "Untick", "Create the list from the Tracker", "Edit minutes"];
// Steps inside a form the manual describes as a whole (confirm, cancel, close, formatting).
const generic = new Set(["Cancel", "Close", "Keep", "Keep it", "Keep them", "Keep editing", "Yes, delete", "Yes, remove", "Discard changes", "Edit", "Delete", "Preview", "Hide preview", "Mark as paid", "Use the sheet's", "Save mine anyway", "Save changes", "Add milestone", "Add item", "Add member", "Save wallet"]);
const needed = [...new Set([...fixed, ...changing])].filter((l) => !generic.has(l));
for (const l of needed) ok(bold.includes(l), `the dashboard has a button "${l}" that MANUAL_COUNCIL.md does not name in bold`);

ok(bold.length > 20 && needed.length > 20, `the check found the labels (${bold.length} in the manual, ${needed.length} buttons)`);

console.log(failed ? `\n${failed} failed, ${passed} passed` : `\nall ${passed} manual checks passed`);
process.exit(failed ? 1 : 0);
