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

// RFC 4180 CSV parser (quoted fields, embedded newlines and commas).
export function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Collapse whitespace, including the line breaks the sheet uses inside headers.
export const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

// Parse a sheet number. Returns { value, raw, state } where state is
// "ok" | "blank" | "unknown" (a "?" cell) | "na" (N/A) | "invalid".
export function parseNum(raw) {
  const s = clean(raw);
  if (s === "") return { value: null, raw: s, state: "blank" };
  if (s === "?") return { value: null, raw: s, state: "unknown" };
  if (/^n\/?a$/i.test(s)) return { value: null, raw: s, state: "na" };
  const n = Number(s.replace(/[,$\s]/g, ""));
  return Number.isFinite(n) ? { value: n, raw: s, state: "ok" } : { value: null, raw: s, state: "invalid" };
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isoDay(ts) { return new Date(ts * 1000).toISOString().slice(0, 10); }

// Calendar quarter containing a unix timestamp, e.g. "2026-Q3".
export function quarterOf(ts) {
  const d = new Date(ts * 1000);
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}

// Unix timestamp of the first instant of a quarter key ("2026-Q3").
export function quarterStart(key) {
  const [y, q] = key.split("-Q").map(Number);
  return Date.UTC(y, (q - 1) * 3, 1) / 1000;
}

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
