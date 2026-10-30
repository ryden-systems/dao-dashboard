// Pure helpers that map dashboard fields onto the Council's sheet: header rows, columns,
// PIP rows, A1 addresses, and input validation. No network, no DOM; shared by the browser
// editor and the Node tests.
(function (root) {
  "use strict";

  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  // Headers of the tabs the dashboard writes to.
  const LABEL_HEADERS = ["Signature", "Recipient", "PIP", "Confirmed"];
  const MEMBER_HEADERS = ["Name", "Role", "Term", "Start", "End", "Elected (PIP)", "Wallet", "Discord", "X", "Image", "Show"];

  // Editable PIP fields -> header text in the Tracker tab (matched by prefix, like the importer).
  const PIP_FIELDS = {
    phase: { header: "PIP Phase", label: "PIP phase" },
    milestonesDone: { header: "Completed Milestones", label: "Completed milestones", type: "int" },
    milestonesTotal: { header: "Total Payment Milestones", label: "Total payment milestones", type: "int" },
    roi: { header: "DAO ROI", label: "DAO ROI", type: "text" },
    note: { header: "Note", label: "Note", type: "text" },
  };

  function findHeaderRow(rows, required) {
    return rows.findIndex((r) => required.every((h) => r.some((c) => clean(c).toLowerCase() === h.toLowerCase())));
  }

  function colIndex(header, name) {
    const h = header.map((c) => clean(c).toLowerCase());
    const n = name.toLowerCase();
    const exact = h.indexOf(n);
    return exact >= 0 ? exact : h.findIndex((x) => x.startsWith(n));
  }

  // 0-based column index -> letters (0 -> A, 25 -> Z, 26 -> AA).
  function colLetter(i) {
    let s = "";
    for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
    return s;
  }

  // A1 address of one cell; tab names are quoted, with embedded quotes doubled.
  function a1(tab, row0, col0) {
    return `'${String(tab).replace(/'/g, "''")}'!${colLetter(col0)}${row0 + 1}`;
  }
  const a1Tab = (tab) => `'${String(tab).replace(/'/g, "''")}'`;

  // Locate a PIP's row in the Tracker tab. Returns { header, headerRow, row, cols } or an error.
  function locatePip(rows, pipNumber) {
    const headerRow = findHeaderRow(rows, ["PIP", "PIP Name"]);
    if (headerRow < 0) return { error: "The PIP tab's header row (with 'PIP' and 'PIP Name') was not found." };
    const header = rows[headerRow];
    const pipCol = header.findIndex((c) => clean(c) === "PIP");
    const want = `PIP-${pipNumber}`;
    const matches = [];
    for (let i = headerRow + 1; i < rows.length; i++) if (clean(rows[i][pipCol]).toUpperCase() === want) matches.push(i);
    if (!matches.length) return { error: `${want} has no row in the sheet.` };
    if (matches.length > 1) return { error: `${want} appears ${matches.length} times in the sheet; fix the duplicate first.` };
    const cols = {};
    for (const [k, f] of Object.entries(PIP_FIELDS)) cols[k] = colIndex(header, f.header);
    return { header, headerRow, row: matches[0], cols };
  }

  // Validation. Returns an error message, or "" when the value is acceptable.
  function validate(kind, value) {
    const v = clean(value);
    switch (kind) {
      case "int": return v === "" || /^\d+$/.test(v) ? "" : "Enter a whole number.";
      case "pipLabel": return /^PIP-\d+$/i.test(v) || ["internal", "refund", "not a payout"].includes(v.toLowerCase()) ? "" : "Choose a PIP, or internal / refund / not a payout.";
      case "date": return v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v) ? "" : "Use the format YYYY-MM-DD.";
      case "url": return v === "" || /^https:\/\/\S+$/i.test(v) ? "" : "Image links must start with https://";
      case "required": return v ? "" : "This field is required.";
      default: return "";
    }
  }

  // Dates are written as text ("'2026-10-11"; Google hides the apostrophe) so the sheet's locale
  // can never turn them into an ambiguous 10/11/2026 vs 11/10/2026.
  const textDate = (d) => (d ? `'${d}` : "");

  // Row for the Council members tab, in MEMBER_HEADERS order.
  function memberRow(m) {
    return [m.name, m.role || "Council member", m.term || "", textDate(m.start), textDate(m.end), m.electedIn ? `PIP-${m.electedIn}` : "", m.wallet || "", m.discord || "", m.x ? String(m.x).replace(/^@/, "") : "", m.image || "", "TRUE"];
  }

  root.SheetMap = { clean, LABEL_HEADERS, MEMBER_HEADERS, PIP_FIELDS, findHeaderRow, colIndex, colLetter, a1, a1Tab, locatePip, validate, memberRow };
})(typeof window !== "undefined" ? window : globalThis);
