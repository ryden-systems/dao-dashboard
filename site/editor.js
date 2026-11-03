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
          for (let i = hi + 1; i < rows.length; i++) {
            if (same(rows[i][cSig], signature) && (cRec < 0 || same(rows[i][cRec], recipient))) {
              await core.writeCell(tabs.paymentLabels, i, cPip, pip);
              await core.writeCell(tabs.paymentLabels, i, cOk, confirmed ? "TRUE" : "FALSE");
              return { saved: true, updated: true };
            }
          }
        }
        await core.appendRow(tabs.paymentLabels, [signature, recipient || "", pip, confirmed ? "TRUE" : "FALSE"]);
        return { saved: true };
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
    _cfg: null, _token: null, _expires: 0, _client: null, core: null,

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

    signOut() {
      try { if (this._token) google.accounts.oauth2.revoke(this._token, () => {}); } catch { /* already gone */ }
      this._token = null; this._expires = 0;
      this.state = { ...this.state, signedIn: false, email: null, error: null };
      this._emit();
    },
  };

  Editor.makeCore = makeCore; // exposed for tests
  root.Editor = Editor;
})(typeof window !== "undefined" ? window : globalThis);
