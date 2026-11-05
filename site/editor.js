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
  const SCOPE = "https://www.googleapis.com/auth/spreadsheets openid email";
  // Asked for separately, by the owner account only, on its first upload. It covers only files
  // this dashboard creates itself, never the rest of the account's Drive.
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE = "https://www.googleapis.com/drive/v3/";
  const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
  const CRLF = String.fromCharCode(13, 10);
  const same = (a, b) => SM.clean(a) === SM.clean(b);

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

      // Current values of a PIP's editable fields, read live from the sheet.
      async readPip(pip) {
        const rows = await core.readTab(tabs.pips);
        const loc = SM.locatePip(rows, pip);
        if (loc.error) return { error: loc.error };
        const values = {};
        for (const [k, c] of Object.entries(loc.cols)) values[k] = c >= 0 ? (rows[loc.row][c] ?? "") : null;
        return { values, missing: Object.keys(loc.cols).filter((k) => loc.cols[k] < 0) };
      },

      // Save changed PIP fields. `changes` = { field: { from, to } }, where `from` is the value the
      // editor saw. If the sheet now holds something else, nothing is written and the conflicts
      // are returned, unless `force` is set (the editor chose to overwrite).
      async savePip(pip, changes, { force = false } = {}) {
        for (const [k, ch] of Object.entries(changes)) {
          const f = SM.PIP_FIELDS[k];
          if (!f) return { error: `Unknown field ${k}.` };
          const msg = SM.validate(f.type, ch.to);
          if (msg) return { error: `${f.label}: ${msg}` };
        }
        const rows = await core.readTab(tabs.pips);
        const loc = SM.locatePip(rows, pip);
        if (loc.error) return { error: loc.error };
        const conflicts = [];
        for (const [k, ch] of Object.entries(changes)) {
          const c = loc.cols[k];
          if (c < 0) return { error: `The sheet has no "${SM.PIP_FIELDS[k].header}" column.` };
          const now = rows[loc.row][c] ?? "";
          if (!force && !same(now, ch.from)) conflicts.push({ field: k, label: SM.PIP_FIELDS[k].label, yours: ch.to, sheet: now });
        }
        if (conflicts.length) return { conflicts };
        for (const [k, ch] of Object.entries(changes)) {
          if (same(rows[loc.row][loc.cols[k]] ?? "", ch.to)) continue;
          await core.writeCell(tabs.pips, loc.row, loc.cols[k], SM.clean(ch.to));
        }
        return { saved: true };
      },

      async addLabel({ signature, recipient, pip, confirmed }) {
        const msg = SM.validate("pipLabel", pip);
        if (msg) return { error: msg };
        await core.ensureTab(tabs.paymentLabels, SM.LABEL_HEADERS);
        const rows = await core.readTab(tabs.paymentLabels);
        const hi = SM.findHeaderRow(rows, ["Signature"]);
        if (hi >= 0) {
          const h = rows[hi], cSig = SM.colIndex(h, "Signature"), cRec = SM.colIndex(h, "Recipient"), cPip = SM.colIndex(h, "PIP"), cOk = SM.colIndex(h, "Confirmed");
          const hits = [];
          for (let i = hi + 1; i < rows.length; i++) {
            if (same(rows[i][cSig], signature) && (cRec < 0 || same(rows[i][cRec], recipient))) hits.push(i);
          }
          if (hits.length) {
            await core.writeCell(tabs.paymentLabels, hits[0], cPip, pip);
            await core.writeCell(tabs.paymentLabels, hits[0], cOk, confirmed ? "TRUE" : "FALSE");
            // One payout, one row: further rows for it would override this one (the last row wins).
            if (hits.length > 1) await core.deleteRows(tabs.paymentLabels, hits.slice(1));
            return { saved: true, updated: true, removed: hits.length - 1 };
          }
        }
        await core.appendRow(tabs.paymentLabels, [signature, recipient || "", pip, confirmed ? "TRUE" : "FALSE"]);
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

      // Wallets tab: one row per wallet; saving an address that is already listed updates its row.
      async saveWallet({ wallet, name, label, track, note }) {
        for (const [v, kind, what] of [[wallet, "wallet", "Wallet address"], [name, "required", "Name"]]) {
          const msg = SM.validate(kind, v);
          if (msg) return { error: `${what}: ${msg}` };
        }
        if (label) { const msg = SM.validate("pipLabel", label); if (msg) return { error: `Payout label: ${msg}` }; }
        const tab = tabs.wallets || "Wallets";
        await core.ensureTab(tab, SM.WALLET_HEADERS);
        const values = { Name: name, "Payout label": label || "", "Track balance": track ? "TRUE" : "FALSE", Note: note || "" };
        const rows = await core.readTab(tab);
        const hi = SM.findHeaderRow(rows, ["Wallet"]);
        if (hi >= 0) {
          const h = rows[hi], cW = SM.colIndex(h, "Wallet");
          // Tabs made before the rename still call the column "Label".
          const col = (k) => { const c = SM.colIndex(h, k); return c >= 0 || k !== "Payout label" ? c : SM.colIndex(h, "Label"); };
          for (let i = hi + 1; i < rows.length; i++) {
            if (!same(rows[i][cW], wallet)) continue;
            for (const [k, v] of Object.entries(values)) { const c = col(k); if (c >= 0) await core.writeCell(tab, i, c, v); }
            return { saved: true, updated: true };
          }
        }
        await core.appendRow(tab, [wallet, ...Object.values(values)]);
        return { saved: true };
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
        await this._requestToken("select_account");
        const who = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: "Bearer " + this._token } }).then((r) => (r.ok ? r.json() : {}));
        this.state.email = who.email || null;
        const access = await this.core.accessCheck();
        if (!access.ok) throw new Error(`This Google account cannot open the sheet (${access.status}): ${access.message}`);
        this.state.signedIn = true;
      } catch (e) {
        this.state.error = e.message;
        this.state.signedIn = false;
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

    signOut() {
      try { if (this._token) google.accounts.oauth2.revoke(this._token, () => {}); } catch { /* already gone */ }
      try { if (this._driveToken) google.accounts.oauth2.revoke(this._driveToken, () => {}); } catch { /* already gone */ }
      this._token = null; this._expires = 0; this._driveToken = null; this._driveExpires = 0;
      this.state = { ...this.state, signedIn: false, email: null, error: null };
      this._emit();
    },
  };

  Editor.makeCore = makeCore; // exposed for tests
  Editor.makeDrive = makeDrive;
  root.Editor = Editor;
})(typeof window !== "undefined" ? window : globalThis);
