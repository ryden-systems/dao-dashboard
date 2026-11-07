// Pure helpers that map dashboard fields onto the Council's sheet: header rows, columns,
// PIP rows, A1 addresses, and input validation. No network, no DOM; shared by the browser
// editor and the Node tests.
(function (root) {
  "use strict";

  const clean = (s) => String(s ?? "").replace(/\s+/g, " ").trim();

  // Headers of the tabs the dashboard writes to.
  // "Fiscal year": the budget year a payout belongs to (e.g. a January payment for last year's costs).
  const LABEL_HEADERS = ["Signature", "Recipient", "PIP", "Confirmed", "Fiscal year"];
  const DOC_HEADERS = ["Signature", "Recipient", "File", "Link", "Uploaded (UTC)", "By"];
  // "Payout label" (formerly "Label"): applied to payouts to the wallet only, never to inflows.
  // "Since": a wallet reused for a new purpose gets one row per purpose; Since is the PIP (its vote end)
  // or the date the purpose starts. The first purpose's row leaves it empty.
  const WALLET_HEADERS = ["Wallet", "Name", "Payout label", "Track balance", "Note", "Since"];
  const MEMBER_HEADERS = ["Name", "Role", "Term", "Start", "End", "Elected (PIP)", "Wallet", "Discord", "X", "Image", "Show"];
  const MINUTES_HEADERS = ["Date", "Title", "Minutes", "Show"];
  // Payments the DAO knows are coming (e.g. an invoice). "Paid by (tx)" is filled in once it is paid.
  const UPCOMING_HEADERS = ["ID", "Due", "Paid from", "For", "Fiscal year", "Amount", "Currency", "Description", "Paid by (tx)", "Repeats", "Until"];
  // "Completed on" / "Completed by": the Council signed the milestone off (delivered); "Paid by (tx)": the
  // payout that paid it. Milestones made from the Tracker's old counts say "Tracker" in Completed by.
  const MILESTONE_HEADERS = ["ID", "PIP", "#", "Milestone", "Amount", "Currency", "Paid by (tx)", "Completed on", "Completed by"];
  const CHECKLIST_HEADERS = ["ID", "PIP", "Checklist", "Milestone", "Item", "Done on", "Done by", "Evidence"];
  // Google Sheets holds at most 50,000 characters in one cell.
  const MINUTES_MAX = 50000;
  // Minutes keep their line breaks, so they are compared without collapsing whitespace.
  const minutesText = (s) => String(s ?? "").replace(/\r\n?/g, "\n").trim();
  // A sheet date as YYYY-MM-DD: ISO, or the sheet's US format M/D/YYYY.
  function isoDate(raw) {
    const s = clean(raw);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
  }

  // Editable PIP fields -> header text in the Tracker tab (matched by prefix, like the importer).
  // type: how the form shows the field and how it is written. opts: the sheet's own spellings (a value
  // already in the sheet stays selectable). add: a column the dashboard adds to the Tracker when it is
  // missing and a value is saved.
  const PHASES = ["Idea", "Draft", "Voting", "Withdrawn", "Closed", "Completed"];
  const PIP_FIELDS = {
    pipNo: { header: "PIP", label: "PIP number", type: "pipno" },
    name: { header: "PIP Name", label: "Name", type: "line" },
    phase: { header: "PIP Phase", label: "PIP phase", type: "choice", opts: PHASES },
    status: { header: "Status", label: "Status", type: "choice", opts: ["Actionable", "Non-actionable"] },
    draftDate: { header: "Draft Date", label: "Draft date", type: "date" },
    step: { header: "Step", label: "Step", type: "line" },
    pdfSent: { header: "PDF sent", label: "PDF sent to the Foundation", type: "bool" },
    mdSent: { header: "Markdown sent", label: "Markdown sent to ATMTA", type: "bool" },
    amount: { header: "Amount", label: "Amount", type: "num" },
    currency: { header: "Type", label: "Currency", type: "choice", opts: ["ATLAS", "USDC", "Pounds", "Euros"] },
    authUsdc: { header: "Authorized USDC", label: "Authorized USDC", type: "num", add: true },
    authAtlas: { header: "Authorized ATLAS", label: "Authorized ATLAS", type: "num", add: true },
    eco: { header: "Ecosystem Fund", label: "Paid from the Ecosystem Fund?", type: "choice", opts: ["YES", "NO"] },
    category: { header: "Category", label: "Category", type: "choice", opts: ["Governance", "Ecosystem Fund", "DAO Treasury"] },
    sacTerm: { header: "SAC Term", label: "Council term", type: "choice", opts: ["N/A", "SAC-1", "SAC-2", "SAC-3", "SAC-4"] },
    milestonesDone: { header: "Completed Milestones", label: "Completed milestones", type: "int" },
    milestonesTotal: { header: "Total Payment Milestones", label: "Total payment milestones", type: "int" },
    roi: { header: "DAO ROI", label: "DAO ROI", type: "text" },
    note: { header: "Note", label: "Note", type: "text" },
    // Set by the dashboard on a PIP without a number, so it is found again after a rename.
    draftId: { header: "Draft ID", label: "Draft ID", type: "id", add: true },
  };

  // A Tracker cell as the form shows it.
  function pipFormValue(k, raw) {
    const f = PIP_FIELDS[k], s = clean(raw);
    switch (f?.type) {
      case "date": return isoDate(s) || s;
      case "bool": return /^(true|yes)$/i.test(s);
      case "num": return s.replace(/[,\s]/g, "");
      case "pipno": return (s.match(/^PIP-(\d+)$/i) || [])[1] || "";
      case "choice": return f.opts.find((o) => o.toLowerCase() === s.toLowerCase()) || s;
      case "line": return s;
      default: return String(raw ?? "");
    }
  }
  // A form value as it is written into the Tracker (USER_ENTERED, so a date or number is read as one).
  function pipSheetValue(k, v) {
    switch (PIP_FIELDS[k]?.type) {
      case "bool": return v === true || v === "true" ? "TRUE" : "FALSE";
      case "num": return clean(v) === "" ? "" : String(Number(clean(v).replace(/[,\s]/g, "")));
      case "pipno": return clean(v) ? `PIP-${Number(clean(v))}` : "";
      default: return clean(v);
    }
  }

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

  // The Tracker tab's header row and the column of every PIP field (-1 when missing).
  function trackerColumns(rows) {
    const headerRow = findHeaderRow(rows, ["PIP", "PIP Name"]);
    if (headerRow < 0) return { error: "The PIP tab's header row (with 'PIP' and 'PIP Name') was not found." };
    const header = rows[headerRow];
    const cols = {};
    for (const [k, f] of Object.entries(PIP_FIELDS)) cols[k] = colIndex(header, f.header);
    return { header, headerRow, cols };
  }

  // Locate a PIP's row in the Tracker tab: by its number, or for a PIP without one (a draft) by its Draft
  // ID ("D...") or, before it has one, by "name:<PIP Name>". Returns { header, headerRow, row, cols, pip } or an error.
  function locatePip(rows, key) {
    const T = trackerColumns(rows);
    if (T.error) return T;
    const { cols } = T;
    const num = (r) => clean(r[cols.pipNo]).toUpperCase();
    let want, test;
    if (typeof key === "number" || /^\d+$/.test(String(key))) {
      want = `PIP-${Number(key)}`;
      test = (r) => num(r) === want;
    } else if (String(key).startsWith("name:")) {
      const name = clean(String(key).slice(5));
      want = `The PIP "${name}"`;
      test = (r) => !num(r) && clean(r[cols.name]) === name;
    } else {
      want = `The PIP with Draft ID ${key}`;
      test = (r) => cols.draftId >= 0 && clean(r[cols.draftId]) === String(key);
    }
    const matches = [];
    for (let i = T.headerRow + 1; i < rows.length; i++) if (test(rows[i])) matches.push(i);
    if (!matches.length) return { error: `${want} has no row in the sheet; it may have been changed there. Reload the page.` };
    if (matches.length > 1) return { error: `${want} appears ${matches.length} times in the sheet; fix the duplicate first.` };
    const m = num(rows[matches[0]]).match(/^PIP-(\d+)$/);
    return { ...T, row: matches[0], pip: m ? Number(m[1]) : null };
  }

  // Validation. Returns an error message, or "" when the value is acceptable.
  function validate(kind, value) {
    const v = clean(value);
    switch (kind) {
      case "int": return v === "" || /^\d+$/.test(v) ? "" : "Enter a whole number.";
      case "pipno": return v === "" || /^\d+$/.test(v) ? "" : "Enter the PIP's number, e.g. 37.";
      case "num": return v === "" || /^\d+(\.\d+)?$/.test(v.replace(/[,\s]/g, "")) ? "" : "Enter a number.";
      case "pipLabel": return /^PIP-\d+$/i.test(v) || (/[a-z]{2}/i.test(v) && !/^PIP/i.test(v)) ? "" : "Choose a PIP, a cost category such as Foundation, or internal / refund / not a payout.";
      case "wallet": return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v) ? "" : "Enter a Solana address.";
      case "date": return v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v) ? "" : "Use the format YYYY-MM-DD.";
      case "url": return v === "" || /^https:\/\/\S+$/i.test(v) ? "" : "Image links must start with https://";
      case "required": return v ? "" : "This field is required.";
      case "year": return v === "" || /^(19|20)\d{2}$/.test(v) ? "" : "Enter a year, e.g. 2025.";
      case "since": return v === "" || /^PIP-\d+$/i.test(v) || /^\d{4}-\d{2}-\d{2}$/.test(v) ? "" : "Enter the PIP it serves (e.g. PIP-36) or a date (YYYY-MM-DD).";
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

  root.SheetMap = { clean, LABEL_HEADERS, DOC_HEADERS, WALLET_HEADERS, MEMBER_HEADERS, MINUTES_HEADERS, UPCOMING_HEADERS, MILESTONE_HEADERS, CHECKLIST_HEADERS, MINUTES_MAX, PHASES, PIP_FIELDS, pipFormValue, pipSheetValue, minutesText, isoDate, textDate, findHeaderRow, colIndex, colLetter, a1, a1Tab, trackerColumns, locatePip, validate, memberRow };
})(typeof window !== "undefined" ? window : globalThis);
