// Small shared helpers. No dependencies.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export function log(...a) { console.log("[build]", ...a); }
export function warn(...a) { console.warn("[warn]", ...a); }

// A local test build (config.local.json present) keeps its state in data.local/ (git-ignored)
// instead of the committed data/, so test data never mixes with what gets published. Reads fall
// back to data/ for files the local build has not written yet (ledger so far, Council history,
// vote cache), so a fresh local build starts from the committed state.
let localDataDir = null;
export function useLocalData(dir) { localDataDir = dir; }
export function dataPath(rel) { return localDataDir && rel.startsWith("data/") ? localDataDir + rel.slice(4) : rel; }

export function readJSON(rel, fallback) {
  const local = path.join(ROOT, dataPath(rel));
  const p = fs.existsSync(local) ? local : path.join(ROOT, rel);
  if (!fs.existsSync(p)) return fallback;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeJSON(rel, data, pretty = true) {
  const p = path.join(ROOT, dataPath(rel));
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, pretty ? 1 : 0) + "\n");
}

import { parseCSV, clean, parseNum, sleep, isoDay, quarterOf, quarterStart } from "./pure.mjs";
export { parseCSV, clean, parseNum, sleep, isoDay, quarterOf, quarterStart };

export async function fetchText(url, { tries = 4, timeoutMs = 30000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), timeoutMs);
      const r = await fetch(url, { redirect: "follow", signal: ctl.signal });
      clearTimeout(t);
      if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
      return await r.text();
    } catch (e) {
      last = e;
      await sleep(1000 * 2 ** i);
    }
  }
  throw last;
}

export async function fetchJSON(url, opts) { return JSON.parse(await fetchText(url, opts)); }
