// Pure helpers shared by the build (Node) and the dashboard page (browser): no file or network access.

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
