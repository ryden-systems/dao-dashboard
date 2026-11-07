// Two-way editing: writes the dashboard's editable fields into the Council's Google Sheet.
//
// The sheet stays the single source of truth; this file never keeps its own copy of data.
// Access uses the editor's own Google account and Google's spreadsheet permission. The token from
// the sign-in popup is used directly on the Sheets API, so it works with several Google accounts
// signed in to the browser. This page only ever addresses the one sheet in its configuration, and
// whether a save succeeds is decided by the sheet's normal sharing settings.
(function (root) {
  "use strict";
  const SM = root.SheetMap; // site/sheetmap.js must be loaded first
  const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets/";
  const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
  const SCOPE = "https://www.googleapis.com/auth/spreadsheets openid email";
  // Asked for separately, by the owner account only, on its first upload. It covers only files
  // this dashboard creates itself, never the rest of the account's Drive.
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE = "https://www.googleapis.com/drive/v3/";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const CRLF = String.fromCharCode(13, 10);
  const same = (a, b) => SM.clean(a) === SM.clean(b);

  // Sign-in problems in plain words: what happened and what to do. Google's own text is kept at the
  // end so it can still be looked up. Every failure is also written to the browser console.
  // The same cases in 2 to 4 words, for the header (the full text goes into its tooltip).
  // Remembered across reloads (when the browser allows it): the next sign-in asks for Google's permission screen.
  let consentFlag = false;
  function needConsent(set) {
    if (set === true || set === false) consentFlag = set;
    try {
      if (set === true) localStorage.setItem("dash.needConsent", "1");
      else if (set === false) localStorage.removeItem("dash.needConsent");
      else return consentFlag || localStorage.getItem("dash.needConsent") === "1";
    } catch { /* storage blocked */ }
    return consentFlag;
  }
  function signInShort(raw) {
    const s = String(raw || "");
    if (/^view-only/.test(s)) return "No edit rights";
    if (/insufficient.*scope|scopes? (were|was) not granted|sheets permission/i.test(s)) return "Sheets permission missing";
    if (/popup[_ ](window[_ ])?closed|cancel/i.test(s)) return "Sign-in cancelled";
    if (/popup_failed_to_open|popup.*block/i.test(s)) return "Pop-up blocked";
    if (/access_denied|access blocked/i.test(s)) return "Access refused";
    if (/\b403\b/.test(s)) return "No access to sheet";
    if (/\b404\b/.test(s)) return "Sheet not found";
    return "Sign-in failed";
  }
  function signInMessage(raw, email) {
    const s = String(raw || "");
    const google = s ? ` (Google: ${s})` : "";
    if (/^view-only/.test(s)) return `This Google account${email ? ` (${email})` : ""} can view the Council's sheet but not edit it, so it cannot sign in as an editor. Ask the Council for edit access to the sheet.`;
    if (/insufficient.*scope|scopes? (were|was) not granted|sheets permission/i.test(s)) return `The Google Sheets permission was not given. Click Editor sign-in again: Google shows its permission screen once more; tick the box for Google Sheets before Continue.${google}`;
    if (/popup[_ ](window[_ ])?closed|cancel/i.test(s)) return `The Google sign-in window was closed before it finished. Sign in again and complete every step in that window.${google}`;
    if (/popup_failed_to_open|popup.*block/i.test(s)) return `The browser blocked Google's sign-in window. Allow pop-ups for this page and sign in again.${google}`;
    if (/access_denied|access blocked/i.test(s)) return `Google refused the sign-in. Use an account that is registered as a tester of the dashboard's Google app (MANUAL_MAINTAINER.md, section 3), and allow the Google Sheets permission.${google}`;
    if (/\b403\b/.test(s)) return `This Google account${email ? ` (${email})` : ""} cannot edit the Council's sheet. Sign in with an account the sheet is shared with for editing, or ask for edit access.${google}`;
    if (/\b404\b/.test(s)) return `The Council's sheet was not found with this account${email ? ` (${email})` : ""}. Check that the account can open the sheet.${google}`;
    return `Sign-in failed.${google}`;
  }

  // ---------- core: Sheets API operations (no DOM; testable with a fake fetch) ----------
  function makeCore({ sheetId, tabs, fetchFn, getToken }) {
    async function call(path, { method = "GET", body } = {}) {
      const token = await getToken();
      const res = await fetchFn(SHEETS + encodeURIComponent(sheetId) + path, {
        method,
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const err = new Error(json?.error?.message || `Google Sheets answered ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return json;
    }
    const range = (r) => "/values/" + encodeURIComponent(r);

    const core = {
      call,
      // { ok: true } or { ok: false, status, message } with Google's own explanation.
      async accessCheck() {
        try { await call("?fields=properties.title"); return { ok: true }; }
        catch (e) { if (e.status === 403 || e.status === 404) return { ok: false, status: e.status, message: e.message }; throw e; }
      },
      async canAccess() { return (await core.accessCheck()).ok; },
      // Edit rights: opening the sheet is not enough (anyone with its link can view it). Setting the
      // sheet's title to the title it already has is accepted only from accounts that can edit, and
      // changes nothing. (Google refuses an update with no requests at all, so that cannot be used.)
      // Only a refusal (403) keeps an account out; if the check itself fails for another reason the
      // sign-in goes ahead, since Google refuses every save of a view-only account anyway.
      async canEdit() {
        try {
          const j = await call("?fields=properties.title");
          await call(":batchUpdate", { method: "POST", body: { requests: [{ updateSpreadsheetProperties: { properties: { title: j.properties.title }, fields: "title" } }] } });
          return { ok: true };
        } catch (e) {
          if (e.status === 403) return { ok: false, status: e.status, message: e.message };
          console.warn("[editor] edit-rights check could not run:", e.message);
          return { ok: true, unchecked: e.message };
        }
      },
      async tabTitles() {
        const j = await call("?fields=sheets.properties(title,sheetId)");
        return (j.sheets || []).map((s) => s.properties.title);
      },
      async readTab(title) {
        const j = await call(range(SM.a1Tab(title)) + "?valueRenderOption=FORMATTED_VALUE");
        return j.values || [];
      },
      async readCell(title, row0, col0) {
        const j = await call(range(SM.a1(title, row0, col0)) + "?valueRenderOption=FORMATTED_VALUE");
        return (j.values && j.values[0] && j.values[0][0]) ?? "";
      },
      async writeCell(title, row0, col0, value) {
        await call(range(SM.a1(title, row0, col0)) + "?valueInputOption=USER_ENTERED", { method: "PUT", body: { values: [[value]] } });
      },
      // Several single cells in one request.
      async writeCells(title, cells) {
        if (!cells.length) return;
        await call("/values:batchUpdate", { method: "POST", body: { valueInputOption: "USER_ENTERED", data: cells.map((c) => ({ range: SM.a1(title, c.row, c.col), values: [[c.value]] })) } });
      },
      async appendRow(title, values) {
        await call(range(SM.a1Tab(title)) + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", { method: "POST", body: { values: [values] } });
      },
      // Delete rows (0-based) from a tab, bottom first so the indexes stay valid.
      async deleteRows(title, rows0) {
        const j = await call("?fields=sheets.properties(title,sheetId)");
        const tab = (j.sheets || []).find((s) => s.properties.title === title);
        if (!tab) return;
        const requests = [...rows0].sort((a, b) => b - a).map((i) => ({ deleteDimension: { range: { sheetId: tab.properties.sheetId, dimension: "ROWS", startIndex: i, endIndex: i + 1 } } }));
        await call(":batchUpdate", { method: "POST", body: { requests } });
      },
      // Create a tab with a header row if it doesn't exist. Returns true if it was created.
      async ensureTab(title, headers) {
        const titles = await core.tabTitles();
        if (titles.includes(title)) return false;
        await call(":batchUpdate", { method: "POST", body: { requests: [{ addSheet: { properties: { title } } }] } });
        await core.appendRow(title, headers);
        return true;
      },

      // A PIP's Tracker fields, read live from the sheet: `values` as the sheet holds them, `form` as the
      // form shows them. `missing`: fields whose column the sheet does not have (and the dashboard does not add).
      async readPip(key) {
        const rows = await core.readTab(tabs.pips);
        const loc = SM.locatePip(rows, key);
        if (loc.error) return { error: loc.error };
        const values = {}, form = {};
        for (const [k, c] of Object.entries(loc.cols)) {
          values[k] = c >= 0 ? (rows[loc.row][c] ?? "") : "";
          form[k] = SM.pipFormValue(k, values[k]);
        }
        return { values, form, pip: loc.pip, missing: Object.keys(loc.cols).filter((k) => loc.cols[k] < 0 && !SM.PIP_FIELDS[k].add) };
      },

      // Save changed PIP fields. `key`: the PIP's number, or a draft's key (see SheetMap.locatePip).
      // `changes` = { field: { from, to } }: `from` is the sheet value the editor saw, `to` the form value.
      // If the sheet now holds something else, nothing is written and the conflicts are returned, unless
      // `force` is set (the editor chose to overwrite). Returns the key the PIP is found by from now on.
      async savePip(key, changes, { force = false } = {}) {
        for (const [k, ch] of Object.entries(changes)) {
          const f = SM.PIP_FIELDS[k];
          if (!f || f.type === "id") return { error: `Unknown field ${k}.` };
          const msg = SM.validate(f.type, ch.to);
          if (msg) return { error: `${f.label}: ${msg}` };
        }
        if (changes.name && !SM.clean(changes.name.to)) return { error: "Name: a PIP needs a name." };
        const rows = await core.readTab(tabs.pips);
        const loc = SM.locatePip(rows, key);
        if (loc.error) return { error: loc.error };
        const newNo = changes.pipNo ? SM.clean(changes.pipNo.to) : loc.pip == null ? "" : String(loc.pip);
        if (newNo && Number(newNo) !== loc.pip && takenPip(rows, loc, newNo)) return { error: `PIP-${Number(newNo)} already has a row in the sheet.` };
        const conflicts = [];
        for (const [k, ch] of Object.entries(changes)) {
          const c = loc.cols[k];
          if (c < 0) { if (SM.PIP_FIELDS[k].add) continue; return { error: `The sheet has no "${SM.PIP_FIELDS[k].header}" column.` }; }
          const now = rows[loc.row][c] ?? "";
          if (!force && !same(now, ch.from ?? "")) conflicts.push({ field: k, label: SM.PIP_FIELDS[k].label, yours: String(ch.to), sheet: now });
        }
        if (conflicts.length) return { conflicts };
        // A PIP without a number gets a Draft ID, so it is found again after a rename.
        let draftId = loc.cols.draftId >= 0 ? SM.clean(rows[loc.row][loc.cols.draftId]) : "";
        const give = !newNo && !draftId;
        if (give) draftId = newId("D");
        await addPipColumns(rows, loc, [...Object.keys(changes).filter((k) => SM.clean(SM.pipSheetValue(k, changes[k].to))), ...(give ? ["draftId"] : [])]);
        const cells = [];
        for (const [k, ch] of Object.entries(changes)) {
          const c = loc.cols[k];
          if (c < 0 || String(SM.pipFormValue(k, rows[loc.row][c] ?? "")) === String(ch.to)) continue;
          cells.push({ row: loc.row, col: c, value: SM.pipSheetValue(k, ch.to) });
        }
        if (give) cells.push({ row: loc.row, col: loc.cols.draftId, value: draftId });
        await core.writeCells(tabs.pips, cells);
        return { saved: true, key: newNo ? Number(newNo) : draftId };
      },

      // A new Tracker row. A PIP is often added while it is drafted, before it has a number: it then gets a
      // Draft ID. The row goes into the first empty row under the table (the sheet keeps prepared rows with
      // their checkboxes), otherwise after the last row. Returns the key the PIP is found by.
      async addPip(form) {
        for (const [k, v] of Object.entries(form)) {
          const f = SM.PIP_FIELDS[k];
          if (!f || f.type === "id") return { error: `Unknown field ${k}.` };
          const msg = SM.validate(f.type, v);
          if (msg) return { error: `${f.label}: ${msg}` };
        }
        if (!SM.clean(form.name)) return { error: "Name: a PIP needs a name." };
        const rows = await core.readTab(tabs.pips);
        const T = SM.trackerColumns(rows);
        if (T.error) return T;
        const no = SM.clean(form.pipNo);
        if (no && takenPip(rows, T, no)) return { error: `PIP-${Number(no)} already has a row in the sheet.` };
        const values = Object.fromEntries(Object.entries(form).map(([k, v]) => [k, SM.pipSheetValue(k, v)]));
        const draftId = no ? "" : newId("D");
        if (draftId) values.draftId = draftId;
        await addPipColumns(rows, T, Object.keys(values).filter((k) => values[k] !== ""));
        const blank = rows.findIndex((r, i) => i > T.headerRow && r.every((c) => !SM.clean(c) || /^false$/i.test(SM.clean(c))));
        if (blank >= 0) {
          await core.writeCells(tabs.pips, Object.entries(values).filter(([k, v]) => T.cols[k] >= 0 && v !== "").map(([k, v]) => ({ row: blank, col: T.cols[k], value: v })));
        } else {
          const row = [];
          for (const [k, v] of Object.entries(values)) if (T.cols[k] >= 0) row[T.cols[k]] = v;
          await core.appendRow(tabs.pips, Array.from(row, (v) => v ?? ""));
        }
        return { saved: true, key: no ? Number(no) : draftId };
      },

      // fiscalYear (optional): the budget year the payout belongs to. A tab made before the column
      // existed gets its "Fiscal year" header added the first time one is saved.
      async addLabel({ signature, recipient, pip, confirmed, fiscalYear = "" }) {
        const msg = SM.validate("pipLabel", pip);
        if (msg) return { error: msg };
        const fy = SM.clean(fiscalYear);
        const fyMsg = SM.validate("year", fy);
        if (fyMsg) return { error: `Fiscal year: ${fyMsg}` };
        await core.ensureTab(tabs.paymentLabels, SM.LABEL_HEADERS);
        const rows = await core.readTab(tabs.paymentLabels);
        const hi = SM.findHeaderRow(rows, ["Signature"]);
        if (hi >= 0) {
          const h = rows[hi], cSig = SM.colIndex(h, "Signature"), cRec = SM.colIndex(h, "Recipient"), cPip = SM.colIndex(h, "PIP"), cOk = SM.colIndex(h, "Confirmed");
          let cFy = SM.colIndex(h, "Fiscal year");
          if (cFy < 0 && fy) { cFy = h.length; await core.writeCell(tabs.paymentLabels, hi, cFy, "Fiscal year"); }
          const hits = [];
          for (let i = hi + 1; i < rows.length; i++) {
            if (same(rows[i][cSig], signature) && (cRec < 0 || same(rows[i][cRec], recipient))) hits.push(i);
          }
          if (hits.length) {
            await core.writeCell(tabs.paymentLabels, hits[0], cPip, pip);
            await core.writeCell(tabs.paymentLabels, hits[0], cOk, confirmed ? "TRUE" : "FALSE");
            if (cFy >= 0) await core.writeCell(tabs.paymentLabels, hits[0], cFy, fy);
            // One payout, one row: further rows for it would override this one (the last row wins).
            if (hits.length > 1) await core.deleteRows(tabs.paymentLabels, hits.slice(1));
            return { saved: true, updated: true, removed: hits.length - 1 };
          }
          // A new row, placed by the tab's own column order.
          const row = [];
          row[cSig] = signature; if (cRec >= 0) row[cRec] = recipient || ""; row[cPip] = pip; if (cOk >= 0) row[cOk] = confirmed ? "TRUE" : "FALSE"; if (cFy >= 0) row[cFy] = fy;
          await core.appendRow(tabs.paymentLabels, Array.from(row, (v) => v ?? ""));
          return { saved: true };
        }
        await core.appendRow(tabs.paymentLabels, [signature, recipient || "", pip, confirmed ? "TRUE" : "FALSE", fy]);
        return { saved: true };
      },

      // Remove every label row for one payout, so it goes back to automatic matching.
      async removeLabel({ signature, recipient }) {
        const rows = await core.readTab(tabs.paymentLabels);
        const hi = SM.findHeaderRow(rows, ["Signature"]);
        if (hi < 0) return { removed: 0 };
        const h = rows[hi], cSig = SM.colIndex(h, "Signature"), cRec = SM.colIndex(h, "Recipient");
        const hits = [];
        for (let i = hi + 1; i < rows.length; i++) {
          if (same(rows[i][cSig], signature) && (cRec < 0 || same(rows[i][cRec], recipient))) hits.push(i);
        }
        if (hits.length) await core.deleteRows(tabs.paymentLabels, hits);
        return { removed: hits.length };
      },

      async addMember(m) {
        for (const [k, kind] of [["name", "required"], ["start", "date"], ["end", "date"], ["image", "url"]]) {
          const msg = SM.validate(kind, m[k]);
          if (msg) return { error: `${k}: ${msg}` };
        }
        // Never create the tab with a single member: once the tab exists the site reads only the tab,
        // so a one-row tab would hide the whole Council history. It must be created by seedMembers first.
        if (!(await core.tabTitles()).includes(tabs.councilMembers)) {
          return { error: `Create the "${tabs.councilMembers}" tab first; it starts from the full Council history.` };
        }
        await core.appendRow(tabs.councilMembers, SM.memberRow(m));
        return { saved: true };
      },
      // Council members: every row of the tab (hidden ones too), each with the key it is found by again
      // (name, term and start), so an entry can be edited or deleted from the dashboard.
      async listMembers() {
        const tab = tabs.councilMembers;
        if (!(await core.tabTitles()).includes(tab)) return [];
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Name"]);
        if (hi < 0) return [];
        const g = memberCols(rows[hi]);
        return rows.slice(hi + 1).map((r) => memberOf(g, r)).filter((m) => m.name);
      },
      // Change a member's row (its wallet is left as it is). Hiding (show false) keeps the row.
      async updateMember(key, m) {
        const msg = memberCheck(m);
        if (msg) return { error: msg };
        const f = await findMember(key);
        if (f.error) return f;
        await core.writeCells(tabs.councilMembers, Object.entries(memberValues(m)).filter(([k]) => f.g[k] >= 0).map(([k, value]) => ({ row: f.row, col: f.g[k], value })));
        return { saved: true, updated: true };
      },
      async deleteMember(key) {
        const f = await findMember(key);
        if (f.error) return f;
        await core.deleteRows(tabs.councilMembers, [f.row]);
        return { saved: true, deleted: true };
      },

      // Payment documents: one row per file in their own tab, so a payout can have several.
      // The files themselves live in the owner account's Google Drive; the sheet holds their links.
      async listDocs() {
        const tab = tabs.paymentDocuments || "Payment documents";
        if (!(await core.tabTitles()).includes(tab)) return [];
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Signature"]);
        if (hi < 0) return [];
        const h = rows[hi], col = (n) => SM.colIndex(h, n);
        return rows.slice(hi + 1)
          .map((r) => ({ signature: SM.clean(r[col("Signature")]), recipient: SM.clean(r[col("Recipient")]), file: SM.clean(r[col("File")]), link: SM.clean(r[col("Link")]), at: SM.clean(r[col("Uploaded (UTC)")]), by: SM.clean(r[col("By")]) }))
          .filter((d) => d.signature && d.link);
      },
      async addDoc({ signature, recipient, file, link, by }) {
        const tab = tabs.paymentDocuments || "Payment documents";
        await core.ensureTab(tab, SM.DOC_HEADERS);
        const at = new Date().toISOString().slice(0, 19).replace("T", " ");
        await core.appendRow(tab, [signature, recipient || "", file, link, "'" + at, by || ""]);
        return { saved: true, at };
      },
      // Remove a document from its payout: its row in the documents tab. The file itself stays in the
      // owner's Drive folder.
      async deleteDoc({ signature, link }) {
        const tab = tabs.paymentDocuments || "Payment documents";
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Signature"]);
        if (hi < 0) return { error: `The "${tab}" tab was not found.` };
        const h = rows[hi], cS = SM.colIndex(h, "Signature"), cL = SM.colIndex(h, "Link");
        const hits = [];
        for (let i = hi + 1; i < rows.length; i++) if (same(rows[i][cS], signature) && same(rows[i][cL], link)) hits.push(i);
        if (!hits.length) return { error: "This document's row was changed in the sheet. Reload the page." };
        await core.deleteRows(tab, hits);
        return { saved: true, deleted: hits.length };
      },

      // Wallets tab: one row per wallet and purpose. Saving updates the wallet's row for the purpose being
      // edited (`at`: its Since as the editor saw it); `reuse` adds a row for a new purpose instead, which
      // needs its Since (the PIP it serves, or a date), so earlier payouts keep the earlier purpose.
      async saveWallet({ wallet, name, label, track, note, since = "", at = "", reuse = false }) {
        for (const [v, kind, what] of [[wallet, "wallet", "Wallet address"], [name, "required", "Name"], [SM.clean(since), "since", "Since"]]) {
          const msg = SM.validate(kind, v);
          if (msg) return { error: `${what}: ${msg}` };
        }
        if (label) { const msg = SM.validate("pipLabel", label); if (msg) return { error: `Payout label: ${msg}` }; }
        const sinceV = SM.clean(since).replace(/^pip-/i, "PIP-");
        if (reuse && !sinceV) return { error: "Since: enter the PIP the wallet serves now (e.g. PIP-36) or the date it changed." };
        const tab = tabs.wallets || "Wallets";
        await core.ensureTab(tab, SM.WALLET_HEADERS);
        const values = { Name: name, "Payout label": label || "", "Track balance": track ? "TRUE" : "FALSE", Note: note || "", Since: sinceV };
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Wallet"]);
        if (hi < 0) return { error: `The "${tab}" tab has no header row with "Wallet".` };
        const h = [...rows[hi]], cW = SM.colIndex(h, "Wallet");
        // A tab made before Since existed gets the column when one is first saved.
        if (sinceV && SM.colIndex(h, "Since") < 0) { await core.writeCell(tab, hi, h.length, "Since"); h.push("Since"); }
        // Tabs made before the rename still call the column "Label".
        const col = (k) => { const c = SM.colIndex(h, k); return c >= 0 || k !== "Payout label" ? c : SM.colIndex(h, "Label"); };
        const cS = SM.colIndex(h, "Since");
        const mine = [];
        for (let i = hi + 1; i < rows.length; i++) if (same(rows[i][cW], wallet)) mine.push(i);
        const sinceOf = (i) => (cS >= 0 ? SM.clean(rows[i][cS]).toUpperCase() : "");
        if (reuse && mine.some((i) => sinceOf(i) === sinceV.toUpperCase())) return { error: `This wallet already has a purpose since ${sinceV}.` };
        const at0 = reuse ? -1 : mine.find((i) => sinceOf(i) === SM.clean(at).toUpperCase()) ?? (at ? -1 : mine[0] ?? -1);
        if (!reuse && at && at0 < 0) return { error: "This wallet's row was changed in the sheet. Reload the page." };
        if (at0 >= 0) {
          await core.writeCells(tab, Object.entries(values).map(([k, v]) => ({ row: at0, col: col(k), value: v })).filter((c) => c.col >= 0));
          return { saved: true, updated: true };
        }
        const row = [];
        row[cW] = wallet;
        for (const [k, v] of Object.entries(values)) { const c = col(k); if (c >= 0) row[c] = v; }
        await core.appendRow(tab, Array.from(row, (v) => v ?? ""));
        return { saved: true, added: reuse ? "purpose" : "wallet" };
      },
      // Delete one of a wallet's rows: the purpose being edited (`at`: its Since as the editor saw it).
      // A wallet reused for several purposes keeps its other rows.
      async deleteWallet({ wallet, at = "" }) {
        const tab = tabs.wallets || "Wallets";
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Wallet"]);
        if (hi < 0) return { error: `The "${tab}" tab was not found.` };
        const h = rows[hi], cW = SM.colIndex(h, "Wallet"), cS = SM.colIndex(h, "Since");
        const sinceOf = (i) => (cS >= 0 ? SM.clean(rows[i][cS]).toUpperCase() : "");
        const hits = [];
        for (let i = hi + 1; i < rows.length; i++) if (same(rows[i][cW], wallet) && sinceOf(i) === SM.clean(at).toUpperCase()) hits.push(i);
        if (!hits.length) return { error: "This wallet's row was changed in the sheet. Reload the page." };
        await core.deleteRows(tab, hits);
        return { saved: true, deleted: hits.length };
      },

      // Meeting minutes: one row per meeting day. `from` is the text the editor started from (null for
      // new minutes). If the sheet's row for that day now holds something else, nothing is written and
      // the sheet's text is returned, unless `force` is set. Text is written with a leading apostrophe
      // so a line such as "- point" or "= result" is never read as a formula. Returns the tab's gid, so
      // the page can read a tab it has only just created.
      async saveMinutes({ day, title, text, from = null }, { force = false } = {}) {
        const msg = SM.validate("required", day) || SM.validate("date", day);
        if (msg) return { error: `Date: ${msg}` };
        const body = SM.minutesText(text);
        if (!body) return { error: "Minutes: This field is required." };
        if (body.length > SM.MINUTES_MAX) return { error: `Minutes: at most ${SM.MINUTES_MAX.toLocaleString("en-US")} characters fit in one sheet cell (these are ${body.length.toLocaleString("en-US")}).` };
        const tab = tabs.meetingMinutes || "Meeting minutes";
        await core.ensureTab(tab, SM.MINUTES_HEADERS);
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Date", "Minutes"]);
        if (hi < 0) return { error: `The "${tab}" tab has no header row with "Date" and "Minutes".` };
        const h = rows[hi], cD = SM.colIndex(h, "Date"), cT = SM.colIndex(h, "Title"), cM = SM.colIndex(h, "Minutes");
        const asText = (s) => (s ? "'" + s : "");
        let updated = false;
        const at = rows.findIndex((r, i) => i > hi && SM.isoDate(r[cD]) === day);
        if (at >= 0) {
          const now = SM.minutesText(rows[at][cM]);
          if (!force && now && now !== SM.minutesText(from)) return { conflict: { sheet: now } };
          if (cT >= 0) await core.writeCell(tab, at, cT, asText(SM.clean(title)));
          await core.writeCell(tab, at, cM, asText(body));
          updated = true;
        } else {
          await core.appendRow(tab, [SM.textDate(day), asText(SM.clean(title)), asText(body), "TRUE"]);
        }
        const j = await call("?fields=sheets.properties(title,sheetId)");
        const gid = (j.sheets || []).find((s) => s.properties.title === tab)?.properties.sheetId;
        return { saved: true, updated, tab, gid: gid == null ? null : String(gid) };
      },
      // Delete a meeting's minutes: every row for that day. A recording of the meeting stays listed.
      async deleteMinutes(day) {
        const tab = tabs.meetingMinutes || "Meeting minutes";
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Date", "Minutes"]);
        if (hi < 0) return { error: `The "${tab}" tab was not found.` };
        const cD = SM.colIndex(rows[hi], "Date");
        const hits = [];
        for (let i = hi + 1; i < rows.length; i++) if (SM.isoDate(rows[i][cD]) === day) hits.push(i);
        if (!hits.length) return { error: `No minutes for ${day} in the sheet; they may have been changed there. Reload the page.` };
        await core.deleteRows(tab, hits);
        return { saved: true, deleted: hits.length };
      },

      // Upcoming payments (e.g. an invoice that is due): one row each, with an ID that its documents
      // are filed under. Text is written with a leading apostrophe so nothing is read as a formula.
      // Returns the tab's gid, so the page can read a tab it has only just created.
      async addUpcoming(u) {
        const v = upcomingValues(u);
        if (v.error) return v;
        const tab = tabs.upcomingPayments || "Upcoming payments";
        await core.ensureTab(tab, SM.UPCOMING_HEADERS);
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Due", "Amount"]);
        if (hi < 0) return { error: `The "${tab}" tab has no header row with "Due" and "Amount".` };
        const id = "U" + Date.now().toString(36).toUpperCase();
        const values = { ID: id, ...v.values, "Paid by (tx)": "" };
        const h = await withColumns(tab, rows, hi), row = [];
        for (const [k, v] of Object.entries(values)) { const c = SM.colIndex(h, k); if (c >= 0) row[c] = v; }
        await core.appendRow(tab, Array.from(row, (v) => v ?? ""));
        const j = await call("?fields=sheets.properties(title,sheetId)");
        const gid = (j.sheets || []).find((s) => s.properties.title === tab)?.properties.sheetId;
        return { saved: true, id, tab, gid: gid == null ? null : String(gid) };
      },
      // Change an upcoming payment (found by its ID); its documents stay filed under the same ID.
      async updateUpcoming(id, u) {
        const v = upcomingValues(u);
        if (v.error) return v;
        const f = await findUpcoming(id);
        if (f.error) return f;
        for (const [k, val] of Object.entries(v.values)) { const c = SM.colIndex(f.h, k); if (c >= 0) await core.writeCell(f.tab, f.row, c, val); }
        return { saved: true, updated: true };
      },
      // Delete an upcoming payment's row. Its documents stay in Drive and in the documents tab.
      async deleteUpcoming(id) {
        const f = await findUpcoming(id);
        if (f.error) return f;
        await core.deleteRows(f.tab, [f.row]);
        return { saved: true, deleted: true };
      },
      // Mark an upcoming payment as paid by the payout (transaction signature) that settled it. For a
      // repeating payment the transaction is added to the ones before (one per payment made), which
      // moves its next due date on by one period; returns how many payments are recorded.
      async markUpcomingPaid(id, signature) {
        const tab = tabs.upcomingPayments || "Upcoming payments";
        const sig = SM.clean(signature);
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return { error: "Enter the payout's transaction signature." };
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Due", "Amount"]);
        if (hi < 0) return { error: `The "${tab}" tab was not found.` };
        const h = rows[hi], cId = SM.colIndex(h, "ID"), cPaid = SM.colIndex(h, "Paid by");
        if (cId < 0 || cPaid < 0) return { error: `The "${tab}" tab needs "ID" and "Paid by (tx)" columns.` };
        const at = rows.findIndex((r, i) => i > hi && same(r[cId], id));
        if (at < 0) return { error: `No upcoming payment with ID ${id} in the sheet.` };
        const cRep = SM.colIndex(h, "Repeats");
        if (cRep >= 0 && SM.clean(rows[at][cRep])) {
          const before = SM.clean(rows[at][cPaid]).split(/[\s,;]+/).filter(Boolean);
          if (before.includes(sig)) return { error: "This payout is already recorded for this payment." };
          await core.writeCell(tab, at, cPaid, [...before, sig].join(" "));
          return { saved: true, count: before.length + 1 };
        }
        await core.writeCell(tab, at, cPaid, sig);
        return { saved: true };
      },

      // PIP milestones and checklist items: one row each in their own tab (created on the first save),
      // found by their ID. Ticking an item saves the date and who ticked it.
      // Every milestone change also writes the PIP's counts into the Tracker (see syncTrackerCounts).
      async addMilestone(m) { const v = milestoneValues(m); return v.error ? v : synced(await ownAdd("milestones", v.values), [pipOf(m.pip)]); },
      async updateMilestone(id, m) { const v = milestoneValues(m); if (v.error) return v; const r = await ownWrite("milestones", id, v.values); return synced(r, [r.pip, pipOf(m.pip)]); },
      async deleteMilestone(id) { const r = await ownDelete("milestones", id); return synced(r, [r.pip]); },
      // Link the payout that paid a milestone (an empty signature removes the link).
      async setMilestonePayout(id, signature) {
        const sig = SM.clean(signature);
        if (sig && !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) return { error: "Enter the payout's transaction signature." };
        const r = await ownWrite("milestones", id, { "Paid by (tx)": sig });
        return synced(r, [r.pip]);
      },
      // The Council signs a milestone off (delivered); `done` false takes it back.
      async completeMilestone(id, done, by) {
        const r = await ownWrite("milestones", id, { "Completed on": done ? SM.textDate(new Date().toISOString().slice(0, 10)) : "", "Completed by": done ? by || "" : "" });
        return synced(r, [r.pip]);
      },
      // One-time: milestone lists from the Tracker's counts, for PIPs that have none yet. `list` =
      // [{ pip, done, total }]: "Milestone 1" to "Milestone <total>", the first <done> marked completed per the
      // Tracker. No payout is linked (the Tracker does not say which one paid what).
      async importMilestones(list) {
        const o = OWN.milestones, tab = ownTab("milestones");
        await core.ensureTab(tab, o.headers);
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, o.find);
        if (hi < 0) return { error: `The "${tab}" tab has no header row with "#" and "Milestone".` };
        const h = await withColumns(tab, rows, hi, o.headers), cP = SM.colIndex(h, "PIP");
        const has = new Set(rows.slice(hi + 1).map((r) => pipOf(r[cP])).filter(Boolean));
        const out = [], pips = [];
        for (const { pip, done, total } of list) {
          if (!(pip > 0) || !(total > 0) || has.has(pip)) continue;
          pips.push(pip);
          for (let i = 1; i <= total; i++) {
            const v = { ID: newId(o.prefix), PIP: `PIP-${pip}`, "#": String(i), Milestone: `Milestone ${i}`, "Completed by": i <= (done ?? 0) ? "Tracker" : "" };
            const row = [];
            for (const [key, val] of Object.entries(v)) { const c = SM.colIndex(h, key); if (c >= 0) row[c] = val; }
            out.push(Array.from({ length: h.length }, (_, c) => row[c] ?? ""));
          }
        }
        if (out.length) await call(range(SM.a1Tab(tab)) + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", { method: "POST", body: { values: out } });
        const j = await call("?fields=sheets.properties(title,sheetId)");
        const gid = (j.sheets || []).find((s) => s.properties.title === tab)?.properties.sheetId;
        return { saved: true, pips, rows: out.length, tab, gid: gid == null ? null : String(gid) };
      },
      async addCheckItem(c) { const v = checkValues(c); return v.error ? v : ownAdd("checklists", v.values); },
      async updateCheckItem(id, c) { const v = checkValues(c); return v.error ? v : ownWrite("checklists", id, v.values); },
      async deleteCheckItem(id) { return ownDelete("checklists", id); },
      async tickCheckItem(id, done, by) {
        return ownWrite("checklists", id, { "Done on": done ? SM.textDate(new Date().toISOString().slice(0, 10)) : "", "Done by": done ? by || "" : "" });
      },

      // "Update now": writes the request time into the sheet's Dashboard tab. The sheet's sync script
      // sees the sheet change and starts a rebuild; the page itself never holds a GitHub token.
      async requestUpdate(by) {
        const tab = tabs.dashboard || "Dashboard";
        await core.ensureTab(tab, ["Last update requested (UTC)", "By"]);
        const at = new Date().toISOString().slice(0, 19).replace("T", " ");
        await core.writeCell(tab, 1, 0, "'" + at);
        await core.writeCell(tab, 1, 1, by || "");
        return { saved: true, at };
      },

      // Create the Council members tab pre-filled with the dashboard's current record, so the
      // Council starts from the full history instead of an empty tab. Refuses if the tab exists.
      async seedMembers(terms) {
        const titles = await core.tabTitles();
        if (titles.includes(tabs.councilMembers)) return { error: `The "${tabs.councilMembers}" tab already exists.` };
        await core.ensureTab(tabs.councilMembers, SM.MEMBER_HEADERS);
        const rows = [];
        for (const t of [...terms].sort((a, b) => String(a.start).localeCompare(String(b.start)))) {
          for (const m of t.members) rows.push(SM.memberRow({ ...m, term: t.label, start: t.start, end: t.end, electedIn: t.electedIn }));
        }
        if (rows.length) {
          await call(range(SM.a1Tab(tabs.councilMembers)) + ":append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS", { method: "POST", body: { values: rows } });
        }
        return { saved: true, rows: rows.length };
      },
    };
    // An upcoming payment's sheet values from the form, checked; or { error }.
    function upcomingValues({ due, account, for: what, fiscalYear = "", amount, currency = "USDC", description = "", repeats = "", until = "" }) {
      for (const [v, kind, label] of [[due, "required", "Due"], [due, "date", "Due"], [what, "required", "For"], [fiscalYear, "year", "Fiscal year"], [until, "date", "Until"]]) {
        const msg = SM.validate(kind, v);
        if (msg) return { error: `${label}: ${msg}` };
      }
      if (!["", "Monthly", "Quarterly", "Yearly"].includes(repeats)) return { error: "Repeats: choose once, monthly, quarterly or yearly." };
      if (until && !repeats) return { error: "Until: only for a repeating payment." };
      if (until && SM.isoDate(until) < SM.isoDate(due)) return { error: "Until: the last due date cannot be before the first." };
      if (!["treasury", "fund"].includes(account)) return { error: "Paid from: choose the DAO Treasury or the Ecosystem Fund." };
      const n = Number(String(amount).replace(/[,\s]/g, ""));
      if (!(n > 0)) return { error: "Amount: enter a number above 0." };
      const text = (s) => (SM.clean(s) ? "'" + SM.clean(s) : "");
      // A repeating payment's fiscal year is the year each payment falls due, so the column stays empty.
      return { values: { Due: SM.textDate(due), "Paid from": account === "fund" ? "Ecosystem Fund" : "DAO Treasury", For: text(what), "Fiscal year": repeats ? "" : SM.clean(fiscalYear), Amount: String(n), Currency: currency, Description: text(description), Repeats: repeats, Until: until ? SM.textDate(until) : "" } };
    }
    // The header row of one of the dashboard's own tabs, with any of its columns that are missing (e.g.
    // an Upcoming payments tab made before Repeats and Until existed) added at the end, so no value is dropped on save.
    async function withColumns(tab, rows, hi, headers = SM.UPCOMING_HEADERS) {
      const h = [...rows[hi]];
      for (const name of headers) if (SM.colIndex(h, name) < 0) { await core.writeCell(tab, hi, h.length, name); h.push(name); }
      return h;
    }
    const txt = (s) => (SM.clean(s) ? "'" + SM.clean(s) : "");
    // The Council members tab's columns; tabs made by hand may name some of them differently.
    const memberCols = (h) => {
      const c = (...names) => { for (const n of names) { const i = SM.colIndex(h, n); if (i >= 0) return i; } return -1; };
      return { name: c("Name"), role: c("Role"), term: c("Term"), start: c("Start"), end: c("End"), pip: c("Elected", "PIP"), wallet: c("Wallet"), discord: c("Discord"), x: c("X", "Twitter"), image: c("Image", "Avatar", "Photo"), show: c("Show", "Active") };
    };
    const memberKey = (m) => [SM.clean(m.name), SM.clean(m.term), m.start].join("|");
    const memberOf = (g, r) => {
      const get = (k) => (g[k] >= 0 ? SM.clean(r[g[k]]) : "");
      const m = { name: get("name"), role: get("role"), term: get("term"), start: SM.isoDate(get("start")) || get("start"), end: SM.isoDate(get("end")) || get("end"), pip: (get("pip").match(/\d+/) || [""])[0], wallet: get("wallet"), discord: get("discord"), x: get("x").replace(/^@/, ""), image: get("image"), show: !/^(false|no)$/i.test(get("show")) };
      m.key = memberKey(m);
      return m;
    };
    function memberCheck(m) {
      for (const [k, kind] of [["name", "required"], ["start", "date"], ["end", "date"], ["image", "url"]]) {
        const msg = SM.validate(kind, m[k]);
        if (msg) return `${k}: ${msg}`;
      }
      return "";
    }
    // A member's sheet values by field (dates as text, like a new member's row).
    const memberValues = (m) => ({ name: SM.clean(m.name), role: SM.clean(m.role) || "Council member", term: SM.clean(m.term), start: SM.textDate(SM.clean(m.start)), end: SM.textDate(SM.clean(m.end)), pip: m.electedIn ? `PIP-${m.electedIn}` : "", discord: SM.clean(m.discord), x: SM.clean(m.x).replace(/^@/, ""), image: SM.clean(m.image), show: m.show === false ? "FALSE" : "TRUE" });
    async function findMember(key) {
      const rows = await core.readTab(tabs.councilMembers);
      const hi = SM.findHeaderRow(rows, ["Name"]);
      if (hi < 0) return { error: `The "${tabs.councilMembers}" tab was not found.` };
      const g = memberCols(rows[hi]);
      const hits = [];
      for (let i = hi + 1; i < rows.length; i++) if (memberOf(g, rows[i]).key === key) hits.push(i);
      if (!hits.length) return { error: "This member's row was changed in the sheet. Reload the page." };
      if (hits.length > 1) return { error: "This member is in the sheet twice with the same name, term and start; remove the duplicate there first." };
      return { g, row: hits[0] };
    }
    const newId = (prefix) => prefix + Date.now().toString(36).toUpperCase() + Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, "0");
    // Another Tracker row already holds PIP-<n>.
    const takenPip = (rows, T, n) => rows.some((r, i) => i > T.headerRow && i !== T.row && SM.clean(r[T.cols.pipNo]).toUpperCase() === `PIP-${Number(n)}`);
    // Columns the dashboard adds to the Tracker (e.g. Draft ID) go into the first column after the table
    // that is empty in every row; the sheet gets one more column when it has none left.
    async function addPipColumns(rows, T, keys) {
      for (const k of keys) {
        if (T.cols[k] >= 0 || !SM.PIP_FIELDS[k]?.add) continue;
        const used = (c) => rows.some((r) => SM.clean(r[c]));
        let c = Math.max(...Object.values(T.cols)) + 1;
        while (used(c)) c++;
        const j = await call("?fields=sheets.properties(title,sheetId,gridProperties)");
        const tab = (j.sheets || []).find((s) => s.properties.title === tabs.pips)?.properties;
        const width = tab?.gridProperties?.columnCount;
        if (width != null && c >= width) await call(":batchUpdate", { method: "POST", body: { requests: [{ appendDimension: { sheetId: tab.sheetId, dimension: "COLUMNS", length: c - width + 1 } }] } });
        await core.writeCell(tabs.pips, T.headerRow, c, SM.PIP_FIELDS[k].header);
        rows[T.headerRow][c] = SM.PIP_FIELDS[k].header;
        T.cols[k] = c;
      }
    }
    const pipOf = (v) => Number(String(v ?? "").replace(/\D/g, ""));
    // The dashboard's own row tabs with an ID column, besides Upcoming payments.
    const OWN = {
      milestones: { key: "pipMilestones", name: "PIP milestones", headers: SM.MILESTONE_HEADERS, find: ["#", "Milestone"], prefix: "M", what: "milestone" },
      checklists: { key: "checklists", name: "Checklists", headers: SM.CHECKLIST_HEADERS, find: ["Checklist", "Item"], prefix: "C", what: "checklist item" },
    };
    const ownTab = (k) => tabs[OWN[k].key] || OWN[k].name;
    async function ownAdd(k, values) {
      const o = OWN[k], tab = ownTab(k);
      await core.ensureTab(tab, o.headers);
      const rows = await core.readTab(tab);
      const hi = SM.findHeaderRow(rows, o.find);
      if (hi < 0) return { error: `The "${tab}" tab has no header row with ${o.find.map((x) => `"${x}"`).join(" and ")}.` };
      const h = await withColumns(tab, rows, hi, o.headers), row = [];
      const id = newId(o.prefix);
      for (const [key, v] of Object.entries({ ID: id, ...values })) { const c = SM.colIndex(h, key); if (c >= 0) row[c] = v; }
      await core.appendRow(tab, Array.from(row, (v) => v ?? ""));
      const j = await call("?fields=sheets.properties(title,sheetId)");
      const gid = (j.sheets || []).find((s) => s.properties.title === tab)?.properties.sheetId;
      return { saved: true, id, tab, gid: gid == null ? null : String(gid) };
    }
    async function ownFind(k, id) {
      const o = OWN[k], tab = ownTab(k);
      const rows = await core.readTab(tab);
      const hi = SM.findHeaderRow(rows, o.find);
      if (hi < 0) return { error: `The "${tab}" tab was not found.` };
      const h = await withColumns(tab, rows, hi, o.headers), cId = SM.colIndex(h, "ID");
      const row = cId < 0 ? -1 : rows.findIndex((r, i) => i > hi && same(r[cId], id));
      if (row < 0) return { error: `No ${o.what} with ID ${id} in the sheet; it may have been changed there. Reload the page.` };
      return { tab, h, row, pip: pipOf(rows[row][SM.colIndex(h, "PIP")]) };
    }
    async function ownWrite(k, id, values) {
      const f = await ownFind(k, id);
      if (f.error) return f;
      await core.writeCells(f.tab, Object.entries(values).map(([key, v]) => ({ row: f.row, col: SM.colIndex(f.h, key), value: v })).filter((c) => c.col >= 0));
      return { saved: true, updated: true, pip: f.pip };
    }
    async function ownDelete(k, id) {
      const f = await ownFind(k, id);
      if (f.error) return f;
      await core.deleteRows(f.tab, [f.row]);
      return { saved: true, deleted: true, pip: f.pip };
    }
    // The Tracker's "Completed Milestones" and "Total Payment Milestones" follow the PIP's milestone list:
    // completed = signed off or paid. A PIP without a Tracker row (or without those columns) is skipped.
    async function syncTrackerCounts(pip) {
      if (!(pip > 0)) return;
      const rows = await core.readTab(ownTab("milestones"));
      const hi = SM.findHeaderRow(rows, OWN.milestones.find);
      if (hi < 0) return;
      const h = rows[hi], col = (n) => SM.colIndex(h, n);
      const mine = rows.slice(hi + 1).filter((r) => pipOf(r[col("PIP")]) === pip && SM.clean(r[col("Milestone")]));
      const done = mine.filter((r) => ["Paid by", "Completed on", "Completed by"].some((n) => col(n) >= 0 && SM.clean(r[col(n)]))).length;
      const t = await core.readTab(tabs.pips);
      const loc = SM.locatePip(t, pip);
      if (loc.error) return;
      const cells = [["milestonesDone", done], ["milestonesTotal", mine.length]]
        .filter(([k, v]) => loc.cols[k] >= 0 && SM.clean(t[loc.row][loc.cols[k]]) !== String(v))
        .map(([k, v]) => ({ row: loc.row, col: loc.cols[k], value: String(v) }));
      await core.writeCells(tabs.pips, cells);
    }
    // After a milestone save: the Tracker counts of the PIP(s) it touched. The save itself stands even
    // if this fails; the result then says so.
    async function synced(r, pips) {
      if (!r?.saved) return r;
      try { for (const p of new Set(pips.filter(Boolean))) await syncTrackerCounts(p); }
      catch (e) { return { ...r, trackerError: e.message }; }
      return r;
    }
    // A milestone's sheet values from the form, checked; or { error }.
    function milestoneValues({ pip, n, name, amount = "", currency = "" }) {
      if (!(pipOf(pip) > 0)) return { error: "PIP: missing." };
      if (!/^\d+$/.test(String(n).trim()) || Number(n) < 1) return { error: "#: enter the milestone's number, e.g. 1." };
      if (!SM.clean(name)) return { error: "Milestone: enter its name." };
      const a = String(amount).replace(/[,\s]/g, "");
      if (a && !(Number(a) > 0)) return { error: "Amount: enter a number above 0, or leave it empty." };
      if (!["", "ATLAS", "USDC"].includes(currency)) return { error: "Currency: ATLAS or USDC." };
      return { values: { PIP: `PIP-${pipOf(pip)}`, "#": String(Number(n)), Milestone: txt(name), Amount: a, Currency: a ? currency : "" } };
    }
    // A checklist item's sheet values from the form, checked; or { error }.
    function checkValues({ pip, list, milestone = "", item, evidence = "" }) {
      if (!(pipOf(pip) > 0)) return { error: "PIP: missing." };
      if (!SM.clean(list)) return { error: "Checklist: enter its name, e.g. KPIs." };
      if (!SM.clean(item)) return { error: "Item: enter what has to be done or met." };
      if (String(milestone).trim() && !/^\d+$/.test(String(milestone).trim())) return { error: "Milestone: choose one, or none." };
      const msg = SM.validate("url", evidence);
      if (msg) return { error: `Evidence: ${msg.replace("Image links", "Links")}` };
      return { values: { PIP: `PIP-${pipOf(pip)}`, Checklist: txt(list), Milestone: String(milestone).trim(), Item: txt(item), Evidence: SM.clean(evidence) } };
    }
    // The sheet row of an upcoming payment, by its ID.
    async function findUpcoming(id) {
      const tab = tabs.upcomingPayments || "Upcoming payments";
      const rows = await core.readTab(tab);
      const hi = SM.findHeaderRow(rows, ["Due", "Amount"]);
      if (hi < 0) return { error: `The "${tab}" tab was not found.` };
      const h = await withColumns(tab, rows, hi), cId = SM.colIndex(h, "ID");
      const row = cId < 0 ? -1 : rows.findIndex((r, i) => i > hi && same(r[cId], id));
      if (row < 0) return { error: `No upcoming payment with ID ${id} in the sheet; it may have been changed there. Reload the page.` };
      return { tab, h, row };
    }
    return core;
  }

  // ---------- Google Drive: the owner's documents folder (no DOM; testable with a fake fetch) ----------
  function makeDrive({ fetchFn, getToken }) {
    async function call(url, opts = {}) {
      const token = await getToken();
      const res = await fetchFn(url, { ...opts, headers: { Authorization: "Bearer " + token, ...(opts.headers || {}) } });
      const text = await res.text();
      const json = text ? JSON.parse(text) : {};
      if (!res.ok) {
        const err = new Error(json?.error?.message || `Google Drive answered ${res.status}`);
        err.status = res.status;
        throw err;
      }
      return json;
    }
    return {
      // Which account the Drive permission belongs to.
      async who() { return (await call(DRIVE + "about?fields=user(emailAddress)")).user?.emailAddress || null; },
      // The documents folder, created on first use. The dashboard only sees folders it created itself.
      async folder(name) {
        const q = `name = '${name.split("'").join("")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
        const found = await call(DRIVE + "files?fields=files(id)&q=" + encodeURIComponent(q));
        if (found.files?.length) return found.files[0].id;
        const made = await call(DRIVE + "files?fields=id", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder" }) });
        return made.id;
      },
      // One multipart request: the file's name and folder, then its bytes.
      async upload(folderId, blob, name) {
        const b = "dao-dashboard-" + Math.random().toString(36).slice(2);
        const type = blob.type || "application/pdf";
        const meta = JSON.stringify({ name, parents: [folderId], mimeType: type });
        const body = new Blob([`--${b}${CRLF}Content-Type: application/json; charset=UTF-8${CRLF}${CRLF}${meta}${CRLF}--${b}${CRLF}Content-Type: ${type}${CRLF}${CRLF}`, blob, `${CRLF}--${b}--`]);
        return call(DRIVE_UPLOAD + "?uploadType=multipart&fields=id,name,webViewLink", { method: "POST", headers: { "Content-Type": `multipart/related; boundary=${b}` }, body });
      },
    };
  }

  // ---------- browser: Google sign-in ----------
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      if (document.querySelector(`script[src="${src}"]`)) return resolve();
      const s = document.createElement("script");
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error("Could not load " + src));
      document.head.appendChild(s);
    });
  }

  const Editor = {
    state: { available: false, signedIn: false, email: null, error: null },
    _cfg: null, _token: null, _expires: 0, _client: null, _driveToken: null, _driveExpires: 0, core: null,

    init(cfg) {
      this._cfg = cfg || null;
      // Preview mode: the button is shown, but there is no sign-in and no access to any sheet.
      this.state.preview = Boolean(cfg && cfg.preview);
      this.state.available = Boolean(cfg && cfg.googleClientId) || this.state.preview;
      if (this.state.preview) return;
      if (this.state.available) {
        this.core = makeCore({ sheetId: cfg.sheetId, tabs: cfg.tabs, fetchFn: (u, o) => fetch(u, o), getToken: () => this._getToken() });
        // Load Google's sign-in script in advance: browsers only allow the sign-in popup directly
        // after a click, so it must not wait for a download at that moment.
        loadScript("https://accounts.google.com/gsi/client").catch(() => {});
      }
    },
    _emit() { window.dispatchEvent(new CustomEvent("editor:change", { detail: this.state })); },

    _requestToken(prompt) {
      return new Promise((resolve, reject) => {
        this._client.callback = (r) => {
          if (r.error) return reject(new Error(r.error_description || r.error));
          // Google may let the user untick the Sheets permission: the sign-in "works", but every read fails.
          const granted = google.accounts.oauth2.hasGrantedAllScopes ? google.accounts.oauth2.hasGrantedAllScopes(r, SHEETS_SCOPE) : true;
          if (!granted) { needConsent(true); return reject(new Error("The Google Sheets permission was not granted.")); }
          this._token = r.access_token;
          this._expires = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
          resolve(this._token);
        };
        this._client.error_callback = (e) => reject(new Error(e?.message || e?.type || "Sign-in was cancelled."));
        this._client.requestAccessToken({ prompt });
      });
    },
    async _getToken() {
      if (this._token && Date.now() < this._expires) return this._token;
      if (!this._client) throw new Error("Not signed in.");
      return this._requestToken("");
    },

    async signIn() {
      this.state.error = null;
      try {
        await loadScript("https://accounts.google.com/gsi/client");
        this._client = google.accounts.oauth2.initTokenClient({ client_id: this._cfg.googleClientId, scope: SCOPE, callback: () => {} });
        // After a sign-in without the Sheets permission, Google keeps that answer and skips its
        // permission screen on "select_account", so the box could never be ticked: ask for it again.
        await this._requestToken(needConsent() ? "consent" : "select_account");
        needConsent(false);
        const who = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + this._token } }).then((r) => (r.ok ? r.json() : {}));
        this.state.email = who.email || null;
        const access = await this.core.accessCheck();
        if (!access.ok) throw new Error(`${access.status}: ${access.message}`);
        // Only accounts that can edit the sheet sign in: every editor function saves into it.
        const edit = await this.core.canEdit();
        if (!edit.ok) throw new Error(`view-only: ${edit.message}`);
        this.state.signedIn = true;
      } catch (e) {
        console.warn("[editor] sign-in failed:", e.message);
        this.state.error = signInMessage(e.message, this.state.email);
        this.state.errorShort = signInShort(e.message);
        this.state.signedIn = false;
        // Not signed in: the token is dropped. It is not revoked, since revoking removes the whole
        // Google permission (Sheets box included) and the next sign-in would have to grant it again.
        this._token = null; this._expires = 0;
      }
      this._emit();
    },

    // Documents are uploaded only by the configured owner account, so every file belongs to that account.
    canUpload() {
      const owner = this._cfg?.documents?.owner;
      return Boolean(owner && this.state.signedIn && this.state.email && owner.toLowerCase() === this.state.email.toLowerCase());
    },
    _getDriveToken() {
      if (this._driveToken && Date.now() < this._driveExpires) return Promise.resolve(this._driveToken);
      return new Promise((resolve, reject) => {
        const client = google.accounts.oauth2.initTokenClient({
          client_id: this._cfg.googleClientId, scope: DRIVE_SCOPE, login_hint: this.state.email || undefined,
          callback: (r) => {
            if (r.error) return reject(new Error(r.error_description || r.error));
            this._driveToken = r.access_token;
            this._driveExpires = Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60000;
            resolve(this._driveToken);
          },
          error_callback: (e) => reject(new Error(e?.message || e?.type || "The Drive permission was not given.")),
        });
        client.requestAccessToken({ prompt: "" });
      });
    },
    // Uploads the files into the owner's documents folder and lists each one in the sheet.
    async uploadDocs({ signature, recipient, files, prefix }) {
      const owner = this._cfg?.documents?.owner;
      if (!this.canUpload()) return { error: `Only ${owner || "the owner account"} can upload documents.` };
      // Started before any await: browsers allow the permission popup only right after the click.
      const token = this._getDriveToken();
      const drive = makeDrive({ fetchFn: (u, o) => fetch(u, o), getToken: () => token });
      const who = await drive.who();
      if (!who || who.toLowerCase() !== owner.toLowerCase()) return { error: `The Drive permission came from ${who || "another account"}; uploads must come from ${owner}.` };
      const folderId = await drive.folder(this._cfg.documents.folder || "Payment documents");
      const saved = [];
      for (const f of files) {
        const up = await drive.upload(folderId, f, `${prefix} ${f.name}`);
        await this.core.addDoc({ signature, recipient, file: up.name, link: up.webViewLink, by: this.state.email });
        saved.push(up.name);
      }
      return { saved: true, files: saved };
    },

    // Signing out forgets the tokens in this page. The Google permission itself stays (as for any site
    // with Google sign-in), so the next sign-in does not ask for the Sheets box again; it can be removed
    // in the Google account under Security, Third-party connections (DAOdash).
    signOut() {
      this._token = null; this._expires = 0; this._driveToken = null; this._driveExpires = 0;
      this.state = { ...this.state, signedIn: false, email: null, error: null };
      this._emit();
    },
  };

  Editor.makeCore = makeCore; // exposed for tests
  Editor.signInMessage = signInMessage;
  Editor.signInShort = signInShort;
  Editor.makeDrive = makeDrive;
  root.Editor = Editor;
})(typeof window !== "undefined" ? window : globalThis);
