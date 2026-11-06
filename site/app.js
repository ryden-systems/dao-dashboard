// Star Atlas DAO Dashboard — client. Reads data/dashboard.json (built by scripts/build.mjs).
(() => {
  "use strict";

  const KB_URL = "https://star-atlas-dao.gitbook.io/knowledge-base";

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const nf = (d = 0) => new Intl.NumberFormat("en-US", { maximumFractionDigits: d, minimumFractionDigits: 0 });
  const num = (v, d = 0) => (v == null || Number.isNaN(v) ? "—" : nf(d).format(v));
  const compact = (v) => {
    if (v == null) return "—";
    const a = Math.abs(v);
    if (a >= 1e9) return nf(2).format(v / 1e9) + "B";
    if (a >= 1e6) return nf(2).format(v / 1e6) + "M";
    if (a >= 1e4) return nf(1).format(v / 1e3) + "K";
    return nf(a < 10 ? 2 : 0).format(v);
  };
  const day = (ts) => (ts ? new Date(ts * 1000).toISOString().slice(0, 10) : "—");
  const isoDay = (s) => (s ? String(s).slice(0, 10) : "—");
  const short = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "—");
  // A small copy button after every Solana address; the click is handled once for the whole page (copyClick).
  const COPY_ICON = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><rect x="5" y="5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2h-6A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`;
  const copyBtn = (a) => (a ? `<button type="button" class="copy" data-copy="${esc(a)}" title="Copy address" aria-label="Copy address">${COPY_ICON}</button>` : "");
  const solTx = (sig) => `<a class="mono" href="https://solscan.io/tx/${esc(sig)}" target="_blank" rel="noopener">${esc(sig.slice(0, 8))}…</a>`;
  // A counterparty's transfers on Solscan, filtered to those with the DAO account of this movement,
  // e.g. every payment from the Treasury to the Foundation.
  const solFlow = (p, label) => {
    const dao = D.accounts[p.account]?.wallet;
    const filter = dao ? `&amp;${p.direction === "in" ? "to_address" : "from_address"}=${esc(dao)}` : "";
    return `<span class="nw"><a class="mono addr" href="https://solscan.io/account/${esc(p.owner)}?exclude_amount_zero=true&amp;remove_spam=false${filter}#transfers" target="_blank" rel="noopener" title="Transfers between this wallet and the ${esc(D.accounts[p.account]?.label ?? "DAO account")}">${esc(label ?? short(p.owner))}</a>${copyBtn(p.owner)}</span>`;
  };
  const solAcc = (a, label) => `<span class="nw"><a class="mono addr" href="https://solscan.io/account/${esc(a)}" target="_blank" rel="noopener">${esc(label ?? short(a))}</a>${copyBtn(a)}</span>`;
  const pipLink = (n) => `<a class="mono" href="#votes/${n}">PIP-${n}</a>`;
  const css = (v) => `var(${v})`;

  const CONF = {
    "confirmed": { cls: "good", label: "confirmed" },
    "matches-sheet": { cls: "good", label: "matches sheet" },
    "matches-amount": { cls: "good", label: "matches amount" },
    "inferred": { cls: "warn", label: "inferred — confirm" },
    "category": { cls: "good", label: "cost category" },
    "internal": { cls: "", label: "internal" },
    "unlabelled": { cls: "crit", label: "needs label" },
    "income": { cls: "acc", label: "inflow" },
  };
  const confChip = (c) => { const x = CONF[c] ?? { cls: "", label: c }; return `<span class="chip ${x.cls}">${esc(x.label)}</span>`; };
  // A date in table rows: the year on one line and month-day below it, so the column stays narrow.
  const dayCell = (t) => { const d = day(t); return `<span class="dy">${d.slice(0, 4)}</span><span class="dy">${d.slice(5)}</span>`; };
  // Text filter for the movements list: every word must appear in the payout's address, the name
  // the dashboard shows for it, its account, PIP, category, reason or transaction signature.
  const matchesQuery = (p) => {
    const words = ui.payQuery.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const hay = [p.owner, ownerLabel(p.owner), accLabel(p.account), p.pip != null ? `pip-${p.pip}` : "", p.category, p.reason, p.sig, p.symbol].filter(Boolean).join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const PAID = new Set(["confirmed", "matches-sheet", "matches-amount"]);
  // What a payout was for: a PIP or a cost category (e.g. Foundation), with its match state.
  const matchCell = (p) => p.confidence === "category" ? `<span class="chip good">${esc(p.category)}</span>`
    : `${p.pip ? pipLink(p.pip) + " " : ""}${p.category ? `<span class="chip">${esc(p.category)}</span> ` : ""}${confChip(p.confidence)}`;
  const STATE = {
    "paid": ["good", "paid"], "partly-paid": ["warn", "partly paid"], "unpaid": ["", "awaiting payment"], "returned": ["acc", "returned"],
  };
  const stateChip = (s) => { const [c, l] = STATE[s] ?? ["", s]; return `<span class="chip ${c}">${esc(l)}</span>`; };
  const outcomeChip = (o) => o === "passed" ? `<span class="chip good">passed</span>` : o === "failed" ? `<span class="chip crit">failed</span>` : o === "open" ? `<span class="chip acc">voting</span>` : `<span class="chip">${esc(o || "—")}</span>`;

  const kpi = (k, v, unit, s, cls = "") => `<div class="kpi${cls}"><span class="k">${esc(k)}</span><span class="v">${v}${unit ? `<small>${esc(unit)}</small>` : ""}</span>${s ? `<span class="s">${s}</span>` : ""}</div>`;
  const head = (title, right = "") => `<div class="sec-head"><h2>${esc(title)}</h2>${right}</div>`;
  const sub = (title, right = "") => `<div class="sec-head"><h3>${esc(title)}</h3>${right}</div>`;

  let D = null;
  const voteCache = new Map();
  const ui = { payAccount: "all", payConf: "all", payDir: "all", payQuery: "", openPip: null, openVideo: null, openMinutes: null, healthSev: "all" };

  const accLabel = (k) => D.accounts[k]?.label ?? k;
  const ownerLabel = (owner) => {
    for (const a of Object.values(D.accounts)) if (a.wallet === owner) return a.label;
    return D.walletNames?.[owner] ?? D.knownWallets?.[owner] ?? null;
  };
  // Display name of a vote option (election candidates have one in the API).
  const optName = (p, o) => p.candidates?.find((c) => c.value === o)?.display ?? o;

  // Vote detail for a ranked election. Many candidates do not fit one colour each, so only the four
  // with the most first-choice PVP get a colour (chart lines, names); everyone else is drawn together
  // as "Other candidates" in grey and listed in plain text. Tables run down by candidate, not across.
  function rankedDetail(p, v, top, tl) {
    const totalOf = (o) => tl.length ? tl[tl.length - 1][o] ?? 0 : 0;
    const cands = [...new Set(v.votes.map((x) => x.first))].sort((a, b) => totalOf(b) - totalOf(a));
    const lead = cands.slice(0, 4), rest = cands.slice(4);
    const color = (o) => (lead.includes(o) ? css(`--series-${lead.indexOf(o) + 1}`) : null);
    const name = (o) => { const c = color(o); return c ? `<span style="color:${c}">${esc(optName(p, o))}</span>` : esc(optName(p, o)); };
    const series = [
      ...lead.map((o) => ({ name: optName(p, o), color: color(o), points: tl.map((d) => [d.day, d[o] ?? 0]) })),
      ...(rest.length ? [{ name: `Other candidates (${rest.length})`, color: css("--abstain"), points: tl.map((d) => [d.day, rest.reduce((s, o) => s + (d[o] ?? 0), 0)]) }] : []),
    ];
    const ballot = (x) => {
      const picks = String(x.choice).split(",").filter(Boolean);
      return `<strong>${name(picks[0])}</strong>${picks.length > 1 ? `<div class="sub">then ${picks.slice(1).map((o) => esc(optName(p, o))).join(", ")}</div>` : ""}`;
    };
    return `
      <section class="sec panel">
        ${sub("Voting power over the voting period", `<span class="src">cumulative first-choice PVP · the ${lead.length} leading candidates</span>`)}
        ${Charts.line({ label: "Cumulative PVP", yFmt: compact, area: false, legend: true, series })}
      </section>
      <div class="grid-2">
        <section class="sec">
          ${sub("By voter size", `<span class="src">first choice: ballots and PVP</span>`)}
          <div class="tbl"><table><thead><tr><th>Candidate</th>${v.buckets.map((b) => `<th class="r">${esc(b.label)}</th>`).join("")}</tr></thead>
          <tbody>${cands.map((o) => `<tr><td>${name(o)}</td>${v.buckets.map((b) => `<td class="n">${num(b.byOption[o]?.count ?? 0)}<div class="sub">${compact(b.byOption[o]?.pvp ?? 0)} PVP</div></td>`).join("")}</tr>`).join("")}</tbody></table></div>
        </section>
        <section class="sec">
          ${sub("Largest voters", `<span class="src">first choice, then the rest of the ballot</span>`)}
          <div class="tbl"><table><thead><tr><th>Wallet</th><th>Ballot</th><th class="r">PVP</th><th>POLIS locked until</th></tr></thead>
          <tbody>${top.map((x) => `<tr><td>${solAcc(x.wallet)}</td><td>${ballot(x)}</td><td class="n">${num(x.pvp)}</td><td class="mono sub">${x.lockedUntil ? day(x.lockedUntil) : "—"}</td></tr>`).join("")}</tbody></table></div>
        </section>
      </div>`;
  }
  // Net amount the DAO is out for a PIP (sent minus returned), never negative.
  const netOf = (p, sym) => Math.max(0, p.funding?.net?.[sym] ?? 0);
  const yesShare = (p) => {
    const y = p.options.find((o) => o.option === "yes")?.pvp ?? 0;
    const n = p.options.find((o) => o.option === "no")?.pvp ?? 0;
    return y + n > 0 ? y / (y + n) : null;
  };
  const splitBar = (p) => {
    const tot = p.options.reduce((s, o) => s + o.pvp, 0) || 1;
    const col = { yes: css("--yes"), no: css("--no"), abstain: css("--abstain") };
    return `<div class="split" title="${esc(p.options.map((o) => `${o.option}: ${compact(o.pvp)} PVP`).join(" · "))}">${p.options
      .filter((o) => o.pvp > 0)
      .map((o, i) => `<span style="width:${((o.pvp / tot) * 100).toFixed(2)}%;background:${col[o.option] ?? `var(--series-${(i % 4) + 1})`}"></span>`)
      .join("")}</div>`;
  };

  // ---------- council members (shared by Overview and Council) ----------
  const longDate = (iso) => (iso ? new Date(iso + "T00:00:00Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }) : "");
  const initials = (n) => String(n).replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).slice(-2).map((w) => w[0]).join("").toUpperCase() || "?";
  // A term's status is evaluated against the viewer's date, so a static copy moves terms
  // from incoming to current to past on their dates without a rebuild.
  const termsWithStatus = () => {
    const today = new Date().toISOString().slice(0, 10);
    return (D.councilTerms?.terms ?? []).map((t) => ({ ...t, status: t.start && today < t.start ? "incoming" : t.end && today >= t.end ? "past" : "current" }));
  };
  const termDates = (t) => (t.start && t.end ? `${longDate(t.start)} – ${longDate(t.end)}` : "");
  const memberLinks = (m) => [
    m.x ? `<a href="https://x.com/${esc(m.x)}" target="_blank" rel="noopener">@${esc(m.x)}</a>` : "",
    m.discord ? (/^https:\/\/discord\.com\//i.test(m.discord) ? `<a href="${esc(m.discord)}" target="_blank" rel="noopener">Discord</a>` : `<span class="sub">Discord ${esc(m.discord)}</span>`) : "",
    m.wallet ? solAcc(m.wallet) : "",
  ].filter(Boolean).join(" · ");
  const avatar = (m) => `<div class="avatar" aria-hidden="true"><span>${esc(initials(m.name))}</span>${m.image ? `<img src="${esc(m.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : ""}</div>`;
  const memberCard = (m, t) => `
      <div class="member">
        ${avatar(m)}
        <div class="who">
          <span class="nm">${esc(m.name)}</span>
          <span class="rl">${esc(m.role)}</span>
          ${t.status === "incoming" ? `<span class="chip acc">takes office ${esc(longDate(t.start))}</span>` : ""}
          <span class="links">${memberLinks(m)}</span>
        </div>
      </div>`;
  const termMeta = (t) => `${esc([t.label, termDates(t)].filter(Boolean).join(" · "))}${t.electedIn ? ` · elected in ${pipLink(t.electedIn)}` : ""}`;
  // A link taken from the sheet or another source: only https:// becomes a link, anything else
  // (javascript:, data: ...) is shown as plain text so it can never run in an editor's session.
  const extLink = (url, html) => (url && /^https:\/\//i.test(url) ? `<a href="${esc(url)}" target="_blank" rel="noopener">${html}</a>` : html);
  const termSource = (t) => extLink(t.sourceUrl, esc(t.source));

  // Current Council, then any incoming Council (handover overlap). Top of the Council page, inside
  // the page heading's section so the gap under the heading matches every other page.
  function membersBlocks() {
    const terms = termsWithStatus();
    const live = [...terms.filter((t) => t.status === "current"), ...terms.filter((t) => t.status === "incoming").reverse()];
    if (!live.length) return "";
    // The current Council sits right under the page heading; only an incoming one gets its own heading.
    // The term, its dates, the electing PIP and the source go below the cards.
    const block = (t) => `
      ${t.status === "incoming" ? sub("Incoming Council") : ""}
      ${t.members.length ? `<div class="members">${t.members.map((m) => memberCard(m, t)).join("")}</div>` : `<p class="muted">The result of this election has not been published yet.</p>`}
      <p class="src">${termMeta(t)} · Source: ${termSource(t)}</p>`;
    return live.map(block).join("");
  }

  // Every finished term, newest first, with its roster and source (Council page).
  function pastCouncilsSection() {
    const past = termsWithStatus().filter((t) => t.status === "past");
    if (!past.length) return "";
    return `
    <section class="sec">
      ${sub("Past Councils")}
      <div class="terms">${past.map((t) => `
        <div class="panel term">
          <div class="term-head"><span class="term-label">${esc(t.label)}</span><span class="src">${esc(termDates(t))}${t.electedIn ? ` · elected in ${pipLink(t.electedIn)}` : ""}</span></div>
          ${t.members.length ? `<ul class="roster">${t.members.map((m) => `<li>${avatar(m)}<span class="who"><span class="nm">${esc(m.name)}</span>${m.role && m.role !== "Council member" ? `<span class="rl">${esc(m.role)}</span>` : ""}${memberLinks(m) ? `<span class="links">${memberLinks(m)}</span>` : ""}</span></li>`).join("")}</ul>` : `<p class="muted">Result not published.</p>`}
          <p class="src">Source: ${termSource(t)}</p>
        </div>`).join("")}
      </div>
    </section>`;
  }

  // ---------- two-way editing (only when enabled and an editor is signed in) ----------
  const ED = window.Editor;
  const SMap = window.SheetMap;
  const ed = { labelFor: null, msgs: {}, pip: null, member: false, memberMsg: null, seeded: false, docs: null, docFor: null, docMsg: {}, minutes: null, minutesMsg: null };
  const editing = () => Boolean(ED && ED.state.signedIn);
  // Maintenance elements (Data health, "Payouts to label"): shown to signed-in editors. Without
  // editing (or in a preview, where no one can sign in) they stay public. Not secret: their data is
  // in the public dashboard.json. While gated they carry the editor tint (class ed-only).
  const maintOpen = () => !D.editing || Boolean(D.editing.preview) || editing();
  const maintCls = () => (D.editing && !D.editing.preview ? " ed-only" : "");
  const legKey = (p) => `${p.sig}:${p.owner ?? ""}`;
  // Every payout can be (re)labelled, except transfers between the DAO's own accounts.
  // Payouts and inflows can both be labelled; transfers between DAO accounts cannot.
  const canLabel = (p) => !(p.confidence === "internal" && !p.labelled);
  const okMsg = (m) => (m ? `<p class="${m.err ? "ed-err" : "ed-ok"}">${esc(m.err || m.ok)}</p>` : "");

  function editBar() {
    if (!ED || !ED.state.available) return "";
    const s = ED.state;
    if (s.preview) return `<button class="btn" data-act="ed-preview" aria-expanded="${ed.previewInfo ? "true" : "false"}">Editor sign-in</button>`;
    // While a rebuild runs, the buttons are hidden and only the slowly pulsing status stays.
    if (s.signedIn && ed.updating) return `<span class="ed-zone"><span class="sub">Editing as ${esc(s.email ?? "signed-in editor")}</span><span class="sub pulse">${esc(ed.updateMsg?.ok ?? "Updating...")}</span></span>`;
    if (s.signedIn) return `<span class="ed-zone"><span class="sub">Editing as ${esc(s.email ?? "signed-in editor")}</span><button class="btn ed-btn" data-act="ed-update" title="Rebuild the dashboard from the sheet now">Update now</button><button class="btn ed-btn" data-act="ed-signout">Sign out</button>${ed.updateMsg ? `<span class="${ed.updateMsg.err ? "ed-err" : "sub"}">${esc(ed.updateMsg.err || ed.updateMsg.ok)}</span>` : ""}</span>`;
    return `<button class="btn" data-act="ed-signin">Editor sign-in</button>${s.error ? `<span class="ed-err">${esc(s.error)}</span>` : ""}`;
  }
  // Preview mode: what the sign-in does in the delivered dashboard, without signing anyone in.
  const previewInfo = () => (ED?.state.preview && ed.previewInfo ? `
    <section class="panel edpanel preview-info" aria-label="Editing in the delivered dashboard">
      ${sub("Editing from the dashboard", `<button class="btn" data-act="ed-preview">Close</button>`)}
      <p class="lede">In the delivered dashboard, Council members sign in here with their Google account and edit straight from these pages:</p>
      <ul class="clean">
        <li><strong>Label payouts:</strong> a <em>Label</em> button next to every on-chain payout that still needs one; pick the PIP or a cost category such as Foundation, and confirm.</li>
        <li><strong>Update PIPs:</strong> milestones, DAO ROI and notes, from the PIP's row on the payments page.</li>
        <li><strong>Maintain the Council:</strong> create the Council members list from the full history, then add members.</li>
        <li><strong>Name wallets:</strong> give other wallets a name, a label for every payout to them (e.g. Foundation), and track their balances.</li>
        <li><strong>Attach documents:</strong> invoices and receipts as PDF files on any payout, uploaded by the DAO's owner account into its own Google Drive.</li>
      </ul>
      <p>Every save is written straight into the Council's sheet, under the editor's own permissions on that sheet, and appears in its version history. If a value was changed in the sheet in the meantime, the dashboard shows both versions instead of overwriting. Edits made directly in the sheet appear here within about five minutes.</p>
      <p class="src">Sign-in is switched off in this preview, because the preview is not connected to the Council's sheet.</p>
    </section>` : "");

  const editBanner = () => (editing() ?`<div class="note ed-note">Editor mode. Saves go straight into the Council's sheet, and the page reads the sheet live, so everyone sees them on their next page load. The sheet's version history records every change.</div>` : "");

  // Documents on a payout, read live from the sheet's "Payment documents" tab (signed-in editors only).
  const docsOf = (p) => (ed.docs ?? []).filter((d) => d.signature === p.sig && (!d.recipient || d.recipient === (p.owner ?? "")));
  async function loadDocs() {
    if (ed.docsLoading) return;
    ed.docsLoading = true;
    try { ed.docs = await ED.core.listDocs(); } catch (e) { ed.docs = []; ed.docsErr = e.message; }
    ed.docsLoading = false;
    render();
  }
  function docPanel(p) {
    const key = legKey(p), docs = docsOf(p), owner = D.editing?.documents?.owner;
    const list = docs.length
      ? `<ul class="clean">${docs.map((d) => `<li>${extLink(d.link, esc(d.file || "document"))} <span class="sub">${esc(d.at)}${d.by ? " · " + esc(d.by) : ""}</span></li>`).join("")}</ul>`
      : `<p class="muted">${ed.docsErr ? esc(ed.docsErr) : ed.docs ? "No documents on this payout yet." : "Loading documents…"}</p>`;
    const close = `<button class="btn" data-act="doc-close">Close</button>`;
    const upload = !owner ? `<div class="edact wide">${close}</div>`
      : ED.canUpload()
        ? `<label class="wide">Add PDF files<input type="file" id="doc-files" accept="application/pdf" multiple></label>
           <div class="edact wide"><button class="btn primary" data-act="doc-upload" data-sig="${esc(p.sig)}" data-owner="${esc(p.owner ?? "")}">Upload</button>${close}</div>`
        : `<div class="edact wide"><button class="btn" disabled title="Documents are uploaded by ${esc(owner)} only, so every file belongs to that account">Upload PDF</button>${close}<span class="sub">Only ${esc(owner)} can upload documents.</span></div>`;
    return `<div class="edform"><div class="wide">${list}</div>${upload}${okMsg(ed.docMsg[key])}</div>`;
  }

  function labelForm(p) {
    const funded = D.pips.filter((x) => x.funding).map((x) => [`PIP-${x.pip}`, `PIP-${x.pip}: ${x.name}`]);
    // Inflows: a source category (e.g. Initial funding) or a PIP whose money came back.
    const inflow = p.direction === "in";
    const used = (dir) => [...new Set(D.payments.filter((x) => x.direction === dir).map((x) => x.category).filter(Boolean))];
    const cats = inflow
      ? [...new Set(["Initial funding", ...used("in")])].map((c) => [c, `${c} (income)`])
      : [...new Set(["Foundation", ...used("out")])].map((c) => [c, `${c} (cost)`]);
    const pipOpts = inflow ? funded.map(([v, l]) => [v, `${l} (returned)`]) : funded;
    // "unknown" clears any automatic match until someone finds out what the money was.
    const opts = inflow
      ? [["unknown", "Not known yet (no match)"], ...cats, ...pipOpts, ["refund", "refund"], ["not a payout", "not income"]]
      : [["unknown", "Not known yet (no match)"], ...funded, ...cats, ["internal", "internal (between DAO accounts)"], ["refund", "refund"], ["not a payout", "not a payout"]];
    const pick = (v) => (p.pip && v === `PIP-${p.pip}`) || (!p.pip && p.category === v) || (p.labelled && p.confidence === "internal" && p.reason === v) || (p.labelled && v === "unknown" && p.reason === "Council: not known yet");
    return `<div class="edform">
      <label class="wide">${inflow ? "Received as" : "Paid for"}<select id="lbl-pip">${opts.map(([v, l]) => `<option value="${esc(v)}" ${pick(v) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>
      <label class="wide">${inflow ? "Or a new income category" : "Or a new cost category"}<input id="lbl-cat" placeholder="${inflow ? "e.g. Initial funding, Grant" : "e.g. Legal, Hosting"} (leave empty to use the choice above)"></label>
      <label class="chk wide"><input type="checkbox" id="lbl-ok" checked> ${inflow ? "Confirmed" : "Confirmed: counts as paid"}</label>
      <div class="edact wide"><button class="btn primary" data-act="lbl-save" data-sig="${esc(p.sig)}" data-owner="${esc(p.owner ?? "")}">Save label</button><button class="btn" data-act="lbl-cancel">Cancel</button>${p.labelled ? `<button class="btn danger" data-act="lbl-clear" data-sig="${esc(p.sig)}" data-owner="${esc(p.owner ?? "")}">Remove label</button>` : ""}</div>
      ${p.labelled && ed.clearFor === `${p.sig}:${p.owner ?? ""}` ? `<div class="edact wide"><span>Remove the Council label from this payout? It goes back to automatic matching after the next update.</span><button class="btn danger" data-act="lbl-clear-yes" data-sig="${esc(p.sig)}" data-owner="${esc(p.owner ?? "")}">Yes, remove</button><button class="btn" data-act="lbl-clear-no">Keep it</button></div>` : ""}
    </div>`;
  }

  function pipEditor(p) {
    if (!editing()) return "";
    const st = ed.pip && ed.pip.pip === p.pip ? ed.pip : null;
    if (!st) return `<p class="edact"><button class="btn ed-btn" data-act="pip-edit" data-pip="${p.pip}">Edit milestones, ROI and note</button></p>`;
    if (st.loading) return `<p class="muted">Reading the current values from the sheet…</p>`;
    if (!st.values) return `${okMsg({ err: st.error })}<p class="edact"><button class="btn" data-act="pip-cancel">Close</button></p>`;
    const F = SMap.PIP_FIELDS;
    const field = (k) => {
      if (st.missing?.includes(k)) return "";
      const v = esc(st.draft[k] ?? "");
      return F[k].type === "text"
        ? `<label class="wide">${esc(F[k].label)}<textarea id="pf-${k}" rows="2">${v}</textarea></label>`
        : `<label>${esc(F[k].label)}<input id="pf-${k}" inputmode="numeric" value="${v}"></label>`;
    };
    return `<div class="ed-zone"><div class="edform">
      ${["milestonesDone", "milestonesTotal", "roi", "note"].map(field).join("")}
      ${st.conflicts ? `<div class="ed-conflict wide"><strong>Changed in the sheet since you opened this:</strong>${st.conflicts.map((c) => `<div>${esc(c.label)}: the sheet now says “${esc(c.sheet)}”, you entered “${esc(c.yours)}”.</div>`).join("")}
        <div class="edact"><button class="btn danger" data-act="pip-overwrite">Overwrite with mine</button><button class="btn" data-act="pip-reload">Use the sheet's values</button></div></div>` : ""}
      ${st.error ? `<p class="ed-err wide">${esc(st.error)}</p>` : ""}
      ${st.saved ? `<p class="ed-ok wide">Saved to the sheet. Visible to everyone now.</p>` : ""}
      <div class="edact wide"><button class="btn primary" data-act="pip-save">Save to sheet</button><button class="btn" data-act="pip-cancel">Close</button></div>
    </div></div>`;
  }

  function membersEditor() {
    if (!editing()) return "";
    const tabExists = D.councilTerms?.source === "sheet" || ed.seeded;
    const f = (id, label, ph = "", cls = "") => `<label class="${cls}">${label}<input id="mf-${id}" placeholder="${esc(ph)}" value="${esc(ed.memberDraft?.[id] ?? "")}"></label>`;
    const form = `<div class="edform">
      ${f("name", "Name *", "as shown on the site", "wide")}${f("role", "Role", "Council member")}${f("term", "Term", "Term 5")}
      ${f("start", "Start", "YYYY-MM-DD")}${f("end", "End", "YYYY-MM-DD")}${f("pip", "Elected in PIP", "e.g. 40")}
      ${f("x", "X handle", "@handle")}${f("discord", "Discord", "name or https://discord.com/users/…")}${f("image", "Image link", "https://…", "wide")}
      <div class="edact wide"><button class="btn primary" data-act="mem-save">Add member</button><button class="btn" data-act="mem-cancel">Cancel</button></div>
    </div>`;
    return `<section class="sec panel edpanel">
      ${sub("Edit the Council list")}
      ${tabExists
        ? (ed.member ? form : `<p class="edact"><button class="btn ed-btn" data-act="mem-open">Add a member</button></p>`)
        : `<p class="lede">The list above comes from the dashboard's record. Create the sheet's "Council members" tab from it (all ${(D.councilTerms?.terms ?? []).reduce((s, t) => s + t.members.length, 0)} entries across every term), then keep it up to date there or here.</p>
           <p class="edact"><button class="btn primary" data-act="mem-seed">Create the Council members tab</button></p>`}
      ${okMsg(ed.memberMsg)}
      <p class="src">To change or remove existing entries, edit the tab in the sheet; set Show to FALSE to hide a row without deleting it.</p>
    </section>`;
  }

  // ---------- live token prices (Jupiter, fetched by the visitor's browser) ----------
  // Loaded when the page opens and every five minutes while it stays open; no key, no server.
  // Without an answer the USD columns show "—" rather than a stale or made-up value.
  const PRICE_MINTS = { ATLAS: "ATLASXmbPQxBUYbxPsV97usA3fPQYEqzQBUHgiFCUsXx", POLIS: "poLisWXnNRwC6oBu1vHiuKQzFjGL4XDSu4g9qjz9qVk", SOL: "So11111111111111111111111111111111111111112" };
  const prices = { usd: null, at: null, err: null };
  async function loadPrices() {
    try {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${Object.values(PRICE_MINTS).join(",")}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const usd = { USDC: 1 };
      for (const [sym, mint] of Object.entries(PRICE_MINTS)) if (typeof j[mint]?.usdPrice === "number") usd[sym] = j[mint].usdPrice;
      Object.assign(prices, { usd, at: new Date(), err: null });
    } catch (e) { prices.err = e.message; }
    const fp = $("#foot-prices");
    if (fp) fp.innerHTML = prices.usd
      ? `Prices ${priceList()} at ${prices.at.toISOString().slice(11, 16)} UTC, from the <a href="https://dev.jup.ag/docs/price" target="_blank" rel="noopener">Jupiter Price API</a>; USD values on this site use them.`
      : `Live prices from the <a href="https://dev.jup.ag/docs/price" target="_blank" rel="noopener">Jupiter Price API</a> are unavailable right now${prices.err ? ` (${esc(prices.err)})` : ""}.`;
    // Redraw only the page that shows prices, and never under an open form (it would lose typing).
    const formOpen = anyFormOpen();
    if (["overview", "balance", "payments"].includes((location.hash.slice(1) || "overview").split("/")[0]) && !formOpen) render();
  }
  // USD value of a balance set; null when a held token has no price.
  const usdOf = (b) => {
    if (!prices.usd || !b) return null;
    let v = 0;
    for (const sym of ["ATLAS", "USDC", "SOL", "POLIS"]) {
      if (!b[sym]) continue;
      if (prices.usd[sym] == null) return null;
      v += b[sym] * prices.usd[sym];
    }
    return v;
  };
  // A card whose headline is the USD value at live prices, with the token amounts below it. Until
  // prices arrive (or if they never do) the headline is the ATLAS amount, as before.
  // Below it: one line per currency when only amounts are shown, otherwise one line joined by " · ".
  // A card that opens a page when clicked (links inside it still work on their own).
  const goKpi = (hash, html) => html.replace('<div class="kpi', `<div data-go="${hash}" class="kpi`);
  const usdKpi = (label, b, extra = "") => {
    const v = usdOf(b);
    const amounts = [b.ATLAS ? `${compact(b.ATLAS)} ATLAS` : "", b.USDC ? `${num(b.USDC, 0)} USDC` : ""].filter(Boolean);
    if (v == null) return b.ATLAS || !b.USDC
      ? kpi(label, compact(b.ATLAS ?? 0), "ATLAS", [...amounts.slice(b.ATLAS ? 1 : 0), extra].filter(Boolean).join(" · "))
      : kpi(label, num(b.USDC, 0), "USDC", extra);
    return kpi(label, "$" + compact(v), "", extra ? [...amounts, extra].join(" · ") : amounts.join("<br>"));
  };
  const usdCell = (b) => { const v = usdOf(b); return `<td class="n">${v == null ? `<span class="blank">—</span>` : "$" + num(v, 0)}</td>`; };
  const priceList = () => ["ATLAS", "POLIS", "SOL"].filter((s) => prices.usd[s] != null).map((s) => `${s} $${prices.usd[s] < 0.01 ? prices.usd[s].toPrecision(3) : num(prices.usd[s], 2)}`).join(" · ");
  const pricesNote = () => prices.usd
    ? `USD at live prices: ${priceList()} · Jupiter, ${prices.at.toISOString().slice(11, 16)} UTC`
    : prices.err ? `Live prices unavailable (${esc(prices.err)}), so no USD values.` : "Loading live prices...";

  // Other wallets the Council names, labels or tracks (the sheet's "Wallets" tab).
  function walletsSection() {
    // Visitors see tracked wallets only; untracked ones (names and labels) are listed for editors, tinted.
    const W = (D.wallets ?? []).filter((w) => w.track || editing());
    if (!W.length && !editing()) return "";
    const rows = W.map((w) => `<tr${w.track ? "" : ` class="ed-only"`}>
      <td><strong>${esc(w.name || short(w.wallet))}</strong>${w.note ? `<div class="sub">${esc(w.note)}</div>` : ""}</td>
      <td>${solAcc(w.wallet)}</td>
      <td>${w.label ? `<span class="chip">${esc(w.label)}</span>` : `<span class="blank">—</span>`}</td>
      ${w.now ? `<td class="n">${num(w.now.ATLAS)}</td><td class="n">${num(w.now.USDC, 2)}</td><td class="n">${num(w.now.SOL, 2)}</td>${usdCell(w.now)}` : `<td colspan="4" class="sub">${w.track ? "balances appear after the next update" : "balance not tracked"}</td>`}
      ${editing() ? `<td><button class="btn sm ed-btn" data-act="wal-open" data-wallet="${esc(w.wallet)}">Edit</button></td>` : ""}
    </tr>`).join("");
    const d = ed.walletDraft ?? {};
    const f = (id, label, ph = "", cls = "") => `<label class="${cls}">${label}<input id="wf-${id}" placeholder="${esc(ph)}" value="${esc(d[id] ?? "")}"></label>`;
    const form = `<div class="edform">
      ${f("wallet", "Wallet address *", "Solana address", "wide")}${f("name", "Name *", "e.g. Star Atlas Foundation")}${f("label", "Payout label", "e.g. Foundation or PIP-36")}
      ${f("note", "Note", "optional", "wide")}
      <label class="chk wide"><input type="checkbox" id="wf-track" ${d.track ? "checked" : ""}> Track its balances on this page</label>
      <div class="edact wide"><button class="btn primary" data-act="wal-save">Save wallet</button><button class="btn" data-act="wal-cancel">Cancel</button></div>
    </div>`;
    return `<section class="sec">
      ${sub("Other wallets", `<span class="src">Council's sheet, "Wallets" tab${W.some((w) => w.track) ? " · balances from Solana mainnet" : ""}</span>`)}
      ${W.length ? `<div class="tbl"><table>
        <thead><tr><th>Name</th><th>Address</th><th>Payout label</th><th class="r">ATLAS</th><th class="r">USDC</th><th class="r">SOL</th><th class="r">USD</th>${editing() ? "<th></th>" : ""}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>` : ""}
      ${editing() ? `<div class="ed-zone">${ed.wallet ? form : `<p class="edact"><button class="btn ed-btn" data-act="wal-open">Add a wallet</button></p>`}
      ${okMsg(ed.walletMsg)}
      <p class="src">Name: shown instead of the address everywhere on the dashboard. Payout label: every payout to this wallet gets it, unless that payout has its own label; money received from the wallet is not labelled by it (label those inflows on the Payments page). Track: the wallet's balances are shown here after each update; wallets that are not tracked are listed for editors only.</p></div>` : ""}
    </section>`;
  }

  async function loadPip(n) {
    ed.pip = { pip: n, loading: true };
    render();
    try {
      const r = await ED.core.readPip(n);
      ed.pip = r.error ? { pip: n, error: r.error } : { pip: n, values: r.values, draft: { ...r.values }, missing: r.missing };
    } catch (e) { ed.pip = { pip: n, error: e.message }; }
    render();
  }

  async function edAction(act, el) {
    const val = (id) => $(`#${id}`)?.value ?? "";
    switch (act) {
      case "ed-signin": el.disabled = true; await ED.signIn(); return;
      case "ed-signout": ed.updateMsg = null; ed.docs = null; ed.docFor = null; ED.signOut(); return;
      case "doc-open": ed.docFor = ed.docFor === el.dataset.key ? null : el.dataset.key; ed.docMsg[el.dataset.key] = null; render(); return;
      case "doc-close": ed.docFor = null; render(); return;
      case "doc-upload": {
        const key = `${el.dataset.sig}:${el.dataset.owner}`;
        const files = [...($("#doc-files")?.files ?? [])];
        if (!files.length) { ed.docMsg[key] = { err: "Choose one or more PDF files first." }; render(); return; }
        const p = D.payments.find((x) => legKey(x) === key);
        el.disabled = true;
        try {
          // No await before this call: the Drive permission popup must follow the click directly.
          const r = await ED.uploadDocs({ signature: el.dataset.sig, recipient: el.dataset.owner, files, prefix: p ? `${day(p.t)} ${p.amount} ${p.symbol}` : day(Date.now() / 1000) });
          ed.docMsg[key] = r.error ? { err: r.error } : { ok: `Uploaded ${r.files.length} file${r.files.length === 1 ? "" : "s"}.` };
          if (!r.error) ed.docs = await ED.core.listDocs();
        } catch (e) { ed.docMsg[key] = { err: e.message }; }
        render(); return;
      }
      case "ed-update": {
        el.disabled = true;
        // Local test copy (npm run serve): the local server runs the build itself, then the page reloads.
        if (["localhost", "127.0.0.1"].includes(location.hostname)) {
          ed.updateMsg = { ok: "Rebuilding locally from the sheet, about 30 seconds..." };
          ed.updating = true;
          render();
          try {
            const res = await fetch("/__rebuild", { method: "POST" });
            const r = await res.json().catch(() => ({ error: `local server answered ${res.status}; restart it with npm run serve` }));
            if (r.ok) { location.reload(); return; }
            ed.updateMsg = { err: `Local rebuild failed: ${r.error}` };
          } catch (e) { ed.updateMsg = { err: `Local rebuild failed: ${e.message}` }; }
          ed.updating = false;
          render();
          return;
        }
        try {
          const r = await ED.core.requestUpdate(ED.state.email);
          ed.updateMsg = { ok: `Update requested at ${r.at.slice(11, 16)} UTC. The site refreshes in about five minutes.` };
        } catch (e) { ed.updateMsg = { err: e.message }; }
        render();
        return;
      }
      case "ed-preview": ed.previewInfo = !ed.previewInfo; render(); if (ed.previewInfo) window.scrollTo({ top: 0, behavior: "smooth" }); return;
      case "lbl-open": ed.labelFor = el.dataset.key; ed.msgs[el.dataset.key] = null; render(); return;
      case "lbl-cancel": ed.labelFor = null; ed.clearFor = null; render(); return;
      // Removing a label asks once more in place (no browser dialog), then deletes its row(s) in the sheet.
      case "lbl-clear": ed.clearFor = `${el.dataset.sig}:${el.dataset.owner}`; render(); return;
      case "lbl-clear-no": ed.clearFor = null; render(); return;
      case "lbl-clear-yes": {
        const key = `${el.dataset.sig}:${el.dataset.owner}`;
        el.disabled = true;
        try {
          const r = await ED.core.removeLabel({ signature: el.dataset.sig, recipient: el.dataset.owner });
          ed.msgs[key] = r.removed ? { ok: "Label removed. The payout is matched automatically again." } : { err: "No label row for this payout was found in the sheet." };
          ed.labelFor = null; ed.clearFor = null;
        } catch (e) { ed.msgs[key] = { err: e.message }; }
        render(); liveRefresh(); return;
      }
      case "lbl-save": {
        const key = `${el.dataset.sig}:${el.dataset.owner}`;
        const pip = val("lbl-cat").trim() || val("lbl-pip"), confirmed = Boolean($("#lbl-ok")?.checked);
        el.disabled = true;
        try {
          const r = await ED.core.addLabel({ signature: el.dataset.sig, recipient: el.dataset.owner, pip, confirmed });
          ed.msgs[key] = r.error ? { err: r.error } : { ok: `Labelled ${pip}${confirmed ? "" : " (unconfirmed)"}.` };
          if (!r.error) liveRefresh();
          if (!r.error) ed.labelFor = null;
        } catch (e) { ed.msgs[key] = { err: e.message }; }
        render(); return;
      }
      case "pip-edit": return loadPip(Number(el.dataset.pip));
      case "pip-reload": return loadPip(ed.pip.pip);
      case "pip-cancel": ed.pip = null; render(); return;
      case "pip-save": case "pip-overwrite": {
        const st = ed.pip;
        for (const k of Object.keys(st.draft)) { const input = $(`#pf-${k}`); if (input) st.draft[k] = input.value; }
        const changes = {};
        for (const [k, v] of Object.entries(st.draft)) if (!st.missing?.includes(k) && SMap.clean(v) !== SMap.clean(st.values[k])) changes[k] = { from: st.values[k], to: v };
        st.saved = false;
        if (!Object.keys(changes).length) { st.error = "Nothing has changed."; render(); return; }
        el.disabled = true;
        try {
          const r = await ED.core.savePip(st.pip, changes, { force: act === "pip-overwrite" });
          if (r.error) { st.error = r.error; st.conflicts = null; }
          else if (r.conflicts) { st.conflicts = r.conflicts; st.error = null; }
          else {
            st.saved = true; st.error = null; st.conflicts = null;
            liveRefresh();
            for (const [k, c] of Object.entries(changes)) st.values[k] = c.to;
          }
        } catch (e) { st.error = e.message; }
        render(); return;
      }
      case "mem-seed": {
        el.disabled = true;
        try {
          const r = await ED.core.seedMembers(D.councilTerms?.terms ?? []);
          ed.memberMsg = r.error ? { err: r.error } : { ok: `Created the "Council members" tab with ${r.rows} entries. From the next update the site reads the Council from the sheet.` };
          if (!r.error || /already exists/.test(r.error)) ed.seeded = true;
        } catch (e) { ed.memberMsg = { err: e.message }; }
        render(); return;
      }
      case "wal-open": {
        const w = (D.wallets ?? []).find((x) => x.wallet === el.dataset.wallet);
        ed.wallet = true; ed.walletDraft = w ? { ...w } : {}; ed.walletMsg = null;
        render(); return;
      }
      case "wal-cancel": ed.wallet = false; ed.walletDraft = null; render(); return;
      case "wal-save": {
        ed.walletDraft = { ...Object.fromEntries(["wallet", "name", "label", "note"].map((k) => [k, val(`wf-${k}`).trim()])), track: Boolean($("#wf-track")?.checked) };
        el.disabled = true;
        try {
          const r = await ED.core.saveWallet(ed.walletDraft);
          ed.walletMsg = r.error ? { err: r.error } : { ok: `${r.updated ? "Updated" : "Added"} ${ed.walletDraft.name}.${r.updated ? "" : " A new wallet's name shows right away; a tracked balance after the next update."}` };
          if (!r.error) liveRefresh();
          if (!r.error) { ed.wallet = false; ed.walletDraft = null; }
        } catch (e) { ed.walletMsg = { err: e.message }; }
        render(); return;
      }
      // Meeting minutes: the form keeps what was typed in ed.minutes (see the input listener), so a
      // live refresh while someone is writing does not lose it.
      // Opening other minutes or cancelling would drop unsaved text: the form asks first, in place.
      case "min-open": {
        const day = el.dataset.day ?? null;
        if (ed.minutes && ed.minutes.fixed && day === ed.minutes.day) { $("#mn-text")?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
        if (minutesDirty()) { ed.minutes.pending = { day }; render(); $("#mn-warn")?.scrollIntoView({ block: "center", behavior: "smooth" }); return; }
        openMinutes(day); return;
      }
      case "min-cancel":
        if (minutesDirty()) { ed.minutes.pending = { cancel: true }; render(); return; }
        ed.minutes = null; render(); return;
      case "min-keep": ed.minutes.pending = null; render(); return;
      case "min-discard": {
        const p = ed.minutes?.pending;
        ed.minutes = null;
        if (p && !p.cancel) { openMinutes(p.day); return; }
        render(); return;
      }
      // Toolbar: wraps the selection (or a placeholder) in Discord markdown, or prefixes the selected
      // lines. Edits the text box in place, without a redraw, so the cursor stays where it is.
      case "min-fmt": {
        const ta = $("#mn-text");
        if (!ta || !ed.minutes) return;
        const f = el.dataset.fmt, a = ta.selectionStart, b = ta.selectionEnd, v = ta.value, sel = v.slice(a, b);
        const WRAP = { b: "**", i: "*", u: "__", s: "~~", code: "`", spoiler: "||" };
        if (WRAP[f] || f === "link") {
          const inner = sel || (f === "link" ? "link text" : "text");
          const [l, r] = f === "link" ? ["[", "](https://)"] : [WRAP[f], WRAP[f]];
          ta.setRangeText(l + inner + r, a, b, "end");
          ta.setSelectionRange(a + l.length, a + l.length + inner.length);
        } else {
          const from = v.lastIndexOf("\n", a - 1) + 1;
          const PRE = { h: "## ", ul: "- ", q: "> " };
          const block = v.slice(from, b).split("\n").map((line, i) => (f === "ol" ? `${i + 1}. ` : PRE[f]) + line).join("\n");
          ta.setRangeText(block, from, b, "select");
        }
        ta.focus();
        ed.minutes.text = ta.value;
        minutesCount();
        return;
      }
      case "min-copy": {
        const ta = $("#mn-text"), note = $("#mn-count");
        if (!ta) return;
        try { await navigator.clipboard.writeText(ta.value); if (note) note.textContent = `Copied ${countText(ta.value)}. Paste it into Discord.`; }
        catch { ta.focus(); ta.select(); if (note) note.textContent = "Copying is blocked here; the text is selected, press Ctrl+C."; }
        return;
      }
      case "min-preview": ed.minutes.preview = !ed.minutes.preview; render(); return;
      case "min-take": ed.minutes.text = ed.minutes.from = ed.minutes.conflict; ed.minutes.conflict = null; render(); return;
      case "min-save": case "min-overwrite": {
        const st = ed.minutes;
        el.disabled = true;
        try {
          const r = await ED.core.saveMinutes({ day: st.day.trim(), title: st.title.trim(), text: st.text, from: st.from }, { force: act === "min-overwrite" });
          if (r.conflict) { st.conflict = r.conflict.sheet; st.error = null; }
          else if (r.error) st.error = r.error;
          else {
            ed.minutesMsg = { ok: `${r.updated ? "Updated" : "Saved"} the minutes of ${st.day.trim()}.` };
            ui.openMinutes = st.day.trim();
            ed.minutes = null;
            window.DashLive?.addTab?.("meetingMinutes", r.tab, r.gid);
            liveRefresh();
          }
        } catch (e) { st.error = e.message; }
        render(); return;
      }
      case "mem-open": ed.member = true; ed.memberMsg = null; render(); return;
      case "mem-cancel": ed.member = false; render(); return;
      case "mem-save": {
        ed.memberDraft = Object.fromEntries(["name", "role", "term", "start", "end", "pip", "x", "discord", "image"].map((k) => [k, val(`mf-${k}`)]));
        const d = ed.memberDraft;
        const m = { ...d, electedIn: Number(d.pip.replace(/\D/g, "")) || null };
        el.disabled = true;
        try {
          const r = await ED.core.addMember(m);
          ed.memberMsg = r.error ? { err: r.error } : { ok: `Added ${m.name}.` };
          if (!r.error) liveRefresh();
          if (!r.error) { ed.member = false; ed.memberDraft = null; }
        } catch (e) { ed.memberMsg = { err: e.message }; }
        render(); return;
      }
    }
  }

  // ---------- views ----------
  const views = {};

  views.overview = () => {
    const t = D.accounts.treasury.now, f = D.accounts.fund.now;
    const voted = D.pips.filter((p) => p.outcome === "passed" || p.outcome === "failed");
    const passed = voted.filter((p) => p.outcome === "passed").length;
    const open = D.pips.filter((p) => p.outcome === "open").length;
    const crit = D.health.filter((h) => h.severity === "critical").length, warn = D.health.filter((h) => h.severity === "warning").length;
    const L = D.limit;
    const latest = [...D.pips].reverse().slice(0, 6);
    const recent = D.payments.filter((p) => p.direction === "out" && p.confidence !== "internal").slice(0, 6);

    return `
    <section class="sec">
      <div class="kpis">
        ${goKpi("#balance", usdKpi("DAO Treasury", t))}
        ${goKpi("#limit", usdKpi("Ecosystem Fund", f, L?.lastRefill ? `last refilled ${day(L.lastRefill.t)}` : ""))}
        ${goKpi("#limit", usdKpi("PIP limit this quarter", { ATLAS: L?.current?.limit ?? 0 }, L?.current ? `${esc(L.current.quarter)} · live 5%: ${compact(L.live.limit)}` : ""))}
        ${goKpi("#votes", kpi("PIPs voted", String(voted.length), "", `${passed} passed${open ? ` · ${open} open` : ""}`))}
        ${V().meetings.length ? (() => { const m = V().meetings[0]; return goKpi("#council/meetings", kpi("Latest Council meeting", esc(m.day), "", m.url ? `${m.minutes ? "minutes · " : ""}${extLink(m.url, "watch ↗")}` : "minutes, no recording")); })() : ""}
        ${maintOpen() ? goKpi("#health", kpi("Data health", String(crit + warn), "flags", `${crit} critical · ${warn} warnings`, maintCls())) : ""}
      </div>
    </section>
    <div class="grid-2">
      <section class="sec">
        ${sub("Latest proposals", `<a href="#votes" class="src">All proposals →</a>`)}
        <div class="tbl"><table>
          <thead><tr><th>PIP</th><th>Title</th><th>Result</th><th class="r">Yes</th></tr></thead>
          <tbody>${latest.map((p) => `<tr><td class="pipc">${pipLink(p.pip)}</td><td><div class="t2"><a href="#votes/${p.pip}">${esc(p.title)}</a></div></td><td>${outcomeChip(p.outcome)}</td><td class="n">${p.ranked ? "ranked" : yesShare(p) == null ? "—" : num(yesShare(p) * 100, 1) + "%"}</td></tr>`).join("")}</tbody>
        </table></div>
      </section>
      <section class="sec">
        ${sub("Recent payouts", `<a href="#payments" class="src">All payments →</a>`)}
        <div class="tbl"><table>
          <thead><tr><th>Date</th><th>From</th><th class="r">Amount</th><th>Matched to</th></tr></thead>
          <tbody>${recent.map((p) => `<tr><td class="mono">${dayCell(p.t)}</td><td>${esc(accLabel(p.account))}</td><td class="n">${num(p.amount, p.symbol === "USDC" ? 2 : 0)} ${p.symbol}</td><td class="mcell"><span class="mline">${matchCell(p)}</span>${editButtons(p)}</td></tr>${editPanels(p, 4)}`).join("") || `<tr><td colspan="4" class="muted">No payouts yet.</td></tr>`}</tbody>
        </table></div>
      </section>
    </div>`;
  };

  views.payments = () => {
    const funded = D.pips.filter((p) => p.funding);
    const sum = (sym) => funded.reduce((s, p) => s + netOf(p, sym), 0);
    const paidN = funded.filter((p) => p.funding.state === "paid").length;
    const needLabel = D.payments.filter((p) => p.direction === "out" && (p.confidence === "unlabelled" || p.confidence === "inferred"));

    // Every outflow by paying account and purpose. Transfers between DAO accounts, refunds and returns are not spending.
    const groups = new Map();
    for (const p of D.payments) {
      if (p.direction !== "out" || p.confidence === "internal" || p.isReturn) continue;
      const [key, name] = p.confidence === "category" ? [`cat:${p.category}`, p.category]
        : p.pip != null && PAID.has(p.confidence) ? ["pips", "PIP payments"] : ["attention", "Not yet labelled or confirmed"];
      const g = groups.get(`${p.account}|${key}`) ?? { key, acc: p.account, name: `${D.accounts[p.account]?.label ?? p.account} · ${name}`, n: 0, ATLAS: 0, USDC: 0, last: 0 };
      g.n++; g[p.symbol] = (g[p.symbol] ?? 0) + p.amount; g.last = Math.max(g.last, p.t);
      groups.set(`${p.account}|${key}`, g);
    }
    const byPurpose = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name));
    const costUsdc = byPurpose.filter((g) => g.key.startsWith("cat:")).reduce((s, g) => s + g.USDC, 0);
    const costAtlas = byPurpose.filter((g) => g.key.startsWith("cat:")).reduce((s, g) => s + g.ATLAS, 0);
    const catNames = [...new Set(byPurpose.filter((g) => g.key.startsWith("cat:")).map((g) => g.key.slice(4)))];

    const rows = funded.map((p) => {
      const open = ui.openPip === p.pip;
      const detail = open ? `<tr class="detail"><td colspan="7">${paymentDetail(p)}</td></tr>` : "";
      return fundedRows(p, { click: true, open }) + detail;
    }).join("");

    return `
    <section class="sec">
      ${head("Payments", `<span class="src">Sheet + Solana mainnet</span>`)}
      <p class="lede">Everything the DAO pays out: PIP funding, and running costs such as the Foundation that keeps the DAO's legal status. Amounts are taken from the chain, not typed in. Payouts count once they match the sheet, an authorized amount, or a Council label.</p>
      <div class="kpis">
        ${usdKpi("Paid to PIPs", { ATLAS: sum("ATLAS"), USDC: sum("USDC") })}
        ${usdKpi("Running costs", { ATLAS: costAtlas, USDC: costUsdc }, catNames.length ? esc(catNames.join(", ")) : "none labelled yet")}
        ${kpi("Fully paid", `${paidN}/${funded.length}`, "PIPs")}
        ${maintOpen() ? kpi("Payouts to label", String(needLabel.length), "", `<button class="link" data-act="attention">show them</button>`, maintCls()) : ""}
      </div>
    </section>
    <section class="sec">
      ${sub("By purpose", `<span class="src">Transfers between DAO accounts and returns are left out</span>`)}
      <div class="tbl"><table>
        <thead><tr><th>Purpose</th><th class="r">Payouts</th><th class="r">ATLAS</th><th class="r">USDC</th><th>Latest</th></tr></thead>
        <tbody>${byPurpose.map((g) => `<tr><td><button class="link" data-act="pay-filter" data-key="${esc(g.key)}" data-acc="${esc(g.acc)}">${esc(g.name)}</button></td><td class="n">${num(g.n)}</td><td class="n">${g.ATLAS ? num(g.ATLAS, 0) : "—"}</td><td class="n">${g.USDC ? num(g.USDC, 2) : "—"}</td><td class="mono">${day(g.last)}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No payouts yet.</td></tr>`}</tbody>
      </table></div>
      <p class="src">Label a payout with a cost category such as <em>Foundation</em> to list it here; further payouts to the same wallet are then suggested for that category. Click a purpose for its transactions.</p>
    </section>
    <section class="sec">
      ${sub("Funded PIPs", `<span class="src">Click a row for its payouts</span>`)}
      <div class="tbl"><table>
        ${FUNDED_HEAD}
        <tbody>${rows}</tbody>
      </table></div>
    </section>`;
  };

  // Every on-chain movement of the DAO accounts, filterable.
  views.transactions = () => {
    const catNames = [...new Set(D.payments.filter((p) => p.direction === "out" && p.confidence === "category" && !p.isReturn).map((p) => p.category))].sort();
    // Dust (an ATLAS or USDC transfer under 1) is not listed.
    const list = D.payments.filter((p) =>
      !((p.symbol === "ATLAS" || p.symbol === "USDC") && p.amount < 1) &&
      (ui.payAccount === "all" || p.account === ui.payAccount) &&
      (ui.payConf === "all" || (ui.payConf === "attention" ? (p.confidence === "unlabelled" || p.confidence === "inferred")
        : ui.payConf === "pips" ? p.pip != null && PAID.has(p.confidence)
        : ui.payConf.startsWith("cat:") ? p.category === ui.payConf.slice(4) : p.confidence === ui.payConf)) &&
      (ui.payDir === "all" || (ui.payDir === "out" ? p.direction === "out" || p.isReturn : p.direction === "in")) &&
      matchesQuery(p));

    return `
    <section class="sec" id="ledger">
      ${head("Transactions", `<span class="src">Solana mainnet</span>`)}
      <p class="lede">Every token movement of the DAO accounts, read from the chain: payouts, returns, inflows and transfers between DAO accounts, with what each was matched to and why.</p>
      <div class="controls">
        <input type="search" class="grow" id="f-q" aria-label="Filter" placeholder="Address, name, PIP, tx..." value="${esc(ui.payQuery)}">
        <select id="f-acc" aria-label="Account"><option value="all">All accounts</option>${Object.entries(D.accounts).map(([k, a]) => `<option value="${k}" ${ui.payAccount === k ? "selected" : ""}>${esc(a.label)}</option>`).join("")}</select>
        <select id="f-conf" aria-label="Confidence">${[["all", "Any match"], ["attention", "Needs a label"], ["pips", "PIP payments"], ...catNames.map((c) => [`cat:${c}`, c]), ...Object.entries(CONF).map(([k, v]) => [k, v.label])].map(([k, l]) => `<option value="${k}" ${ui.payConf === k ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>
        <select id="f-dir" aria-label="Direction">${[["out", "Payouts + returns"], ["in", "Inflows"], ["all", "Everything"]].map(([k, l]) => `<option value="${k}" ${ui.payDir === k ? "selected" : ""}>${l}</option>`).join("")}</select>
      </div>
      <div class="tbl"><table>
        ${MOVE_HEAD}
        <tbody>${list.slice(0, 400).map(movementRow).join("") || `<tr><td colspan="7" class="muted">Nothing matches these filters.</td></tr>`}</tbody>
      </table></div>
      <p class="src">${list.length > 400 ? `Showing the latest 400 of ${list.length}. ` : ""}Transfers under 1 ATLAS or 1 USDC are not listed.</p>
    </section>`;
  };

  // One on-chain movement with its editor controls (Label / Relabel, Documents) and their panels.
  // Used wherever movements are listed, so a payout or inflow can be edited wherever it shows up.
  const MOVE_HEAD = `<thead><tr><th>Date</th><th>Account</th><th class="r">Amount</th><th>Counterparty</th><th>Matched to</th><th>Why</th><th>Tx</th></tr></thead>`;
  // Editor controls for a movement: Label / Relabel and Documents buttons, then their open panels
  // as full-width rows (cols = the table's column count).
  const editButtons = (p) => `${editing() && canLabel(p) && ed.labelFor !== legKey(p) ? ` <button class="btn sm ed-btn" data-act="lbl-open" data-key="${esc(legKey(p))}">${ed.msgs[legKey(p)]?.ok ? "Relabel" : p.labelled ? "Relabel" : "Label"}</button>` : ""}${okMsg(ed.msgs[legKey(p)])}${editing() && p.direction === "out" && ed.docFor !== legKey(p) ? ` <button class="btn sm ed-btn" data-act="doc-open" data-key="${esc(legKey(p))}">${docsOf(p).length ? `Documents (${docsOf(p).length})` : "Documents"}</button>` : ""}`;
  const editPanels = (p, cols) => `${editing() && ed.labelFor === legKey(p) ? `<tr class="detail ed-only"><td colspan="${cols}">${labelForm(p)}</td></tr>` : ""}${editing() && ed.docFor === legKey(p) ? `<tr class="detail ed-only"><td colspan="${cols}">${docPanel(p)}</td></tr>` : ""}`;
  function movementRow(p) {
    return `<tr>
        <td class="mono">${dayCell(p.t)}</td>
        <td>${esc(accLabel(p.account))}</td>
        <td class="n">${p.direction === "in" ? "+" : "−"}${num(p.amount, p.symbol === "USDC" ? 2 : 0)} ${p.symbol}</td>
        <td>${p.owner ? solFlow(p, ownerLabel(p.owner) ?? undefined) : "—"}</td>
        <td class="mcell"><span class="mline">${matchCell(p)}${p.isReturn ? ` <span class="chip acc">return</span>` : ""}</span>${editButtons(p)}</td>
        <td class="sub">${esc(p.reason ?? "")}</td>
        <td>${solTx(p.sig)}</td></tr>${editPanels(p, 7)}`;
  }

  // One Funded PIPs entry: the title across the full width with the status on the right, the figures
  // below it. On the Payments page both rows open the PIP's payouts (click); elsewhere they are plain.
  function fundedRows(p, { click = false, open = false } = {}) {
    const f = p.funding;
    const paidCell = Object.entries(f.paid).filter(([, v]) => v > 0).map(([s, v]) => `${num(v, s === "USDC" ? 2 : 0)} ${s}${f.returned?.[s] ? `<div class="sub">${num(f.returned[s], 0)} returned</div>` : ""}`).join("<br>") || `<span class="blank">none found</span>`;
    const inferred = Object.entries(f.inferred).filter(([, v]) => v > 0).map(([s, v]) => `+${num(v, 0)} ${s} inferred`).join("<br>");
    const sheet = [f.sheet.paidAtlas, f.sheet.paidUsdc].map((c, i) => c.state === "ok" ? `${num(c.value, i ? 2 : 0)} ${i ? "USDC" : "ATLAS"}` : c.state === "unknown" ? `<span class="chip warn">? ${i ? "USDC" : "ATLAS"}</span>` : "").filter(Boolean).join("<br>") || `<span class="blank">blank</span>`;
    const ms = f.milestones.total != null ? `${f.milestones.done ?? "?"}/${f.milestones.total}` : "—";
    const pct = f.milestones.total ? Math.min(100, ((f.milestones.done ?? 0) / f.milestones.total) * 100) : 0;
    const tr = (lead) => (click ? `<tr class="click${lead ? " lead" : ""}" data-pip="${p.pip}"${lead ? ` aria-expanded="${open}"` : ""}>` : `<tr${lead ? ` class="lead"` : ""}>`);
    return `${tr(true)}
      <td class="pipc">${pipLink(p.pip)}</td>
      <td colspan="5"><a href="#votes/${p.pip}">${esc(p.name)}</a><div class="sub">${esc(p.category ?? "")}${p.sacTerm && p.sacTerm !== "N/A" ? " · " + esc(p.sacTerm) : ""}</div></td>
      <td class="r">${stateChip(f.state)}</td>
      </tr>${tr(false)}
      <td></td>
      <td class="nw">${f.authorizedBy ? Object.entries(f.authorizedBy).map(([s, v]) => `${num(v, s === "USDC" ? 2 : 0)} ${s}`).join("<br>") : `${num(f.authorized, 0)} ${esc(f.currency ?? "")}`}</td>
      <td class="n">${paidCell}${inferred ? `<div class="sub">${inferred}</div>` : ""}</td>
      <td class="n">${f.remainingBy ? Object.entries(f.remainingBy).map(([s, v]) => `${num(v, s === "USDC" ? 2 : 0)} ${s}`).join("<br>") : f.remaining != null ? num(f.remaining, 0) + " " + esc(f.currency) : `<span class="sub">${esc(f.remainingNote ?? "—")}</span>`}</td>
      <td class="n">${ms}<div class="bar${pct >= 100 ? " done" : ""}" style="margin-top:5px"><span style="width:${pct}%"></span></div></td>
      <td class="n">${sheet}</td>
      <td></td>
      </tr>`;
  }

  const FUNDED_HEAD = `<thead><tr><th>PIP</th><th>Authorized</th><th class="r">Paid on-chain</th><th class="r">Remaining</th><th class="r">Milestones</th><th class="r">Sheet says paid</th><th class="r">Status</th></tr></thead>`;
  // Every on-chain movement matched to a PIP (payouts and returns); shared by the Funded PIPs row and the proposal page.
  function pipLegsTable(pip) {
    const legs = D.payments.filter((x) => x.pip === pip);
    return legs.length ? `<table>${MOVE_HEAD}<tbody>${legs.map(movementRow).join("")}</tbody></table>` : "";
  }

  function paymentDetail(p) {
    const roi = p.roi ? `<p style="margin-bottom:10px"><strong>DAO ROI:</strong> ${esc(p.roi)}</p>` : "";
    const note = p.note ? `<p class="sub" style="margin-bottom:10px">Note: ${esc(p.note)}</p>` : "";
    const tbl = pipLegsTable(p.pip) || `<p class="muted">No on-chain payout has been matched to this PIP yet.</p>`;
    return `${roi}${note}${tbl}${p.url ? `<p class="src" style="margin-top:10px">${extLink(p.url, "Read the proposal →")}</p>` : ""}${pipEditor(p)}`;
  }

  const councilTerms = () => [...new Set(D.pips.map((p) => p.sacTerm).filter((t) => t && t !== "N/A"))].sort();
  // One colour per Council term number, the same in every chart.
  const termColor = (label) => css(`--series-${(((Number((String(label).match(/\d+/) || [])[0]) || 1) - 1) % 4) + 1}`);
  // Council meetings (YouTube). The player loads only when Watch is clicked, so YouTube is not
  // contacted before. Shared by the Council page and the proposal page.
  const V = () => D.videos ?? { meetings: [], other: [] };
  const viewsNote = () => (V().meetings.find((m) => m.viewsAt)?.viewsAt ? `views as of ${isoDay(V().meetings.find((m) => m.viewsAt).viewsAt)}` : "");
  const watchBtn = (v) => `<button class="btn sm${ui.openVideo === v.id ? " on" : ""}" data-act="yt-play" data-id="${esc(v.id)}">${ui.openVideo === v.id ? "Close" : "Watch"}</button>`;
  // rel=0: suggestions at the end come from the Council's own channel only. clipboard-write lets the
  // player's copy-link button work; the player's own YouTube logo links to the video.
  // Watch starts the video; a direct link to a meeting opens the player without starting it.
  const playerRow = (v, cols) => (ui.openVideo === v.id ? `<tr class="detail"><td colspan="${cols}"><iframe class="video-frame" src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?${ui.autoplay === false ? "" : "autoplay=1&amp;"}rel=0" title="${esc(v.title)}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write; web-share"></iframe></td></tr>` : "");
  const MEET_HEAD = `<thead><tr><th>Date</th><th>Meeting</th><th>Term</th><th class="r">Views</th><th></th></tr></thead>`;
  const meetingRows = (list) => list.map((m) => {
    const edBtn = editing() ? `<button class="btn sm ed-btn" data-act="min-open" data-day="${esc(m.day)}">${m.minutes ? "Edit minutes" : "Add minutes"}</button>` : "";
    return `<tr id="${meetingAnchor(m)}">
      <td class="mono"><a class="plain" href="#council/${meetingAnchor(m)}" title="Link to this meeting (opens its minutes and video)">${esc(m.day)}</a></td>
      <td>${m.minutes ? `<div>${extLink(m.url, esc(m.title))}</div><button class="link muted" data-act="minutes" data-day="${esc(m.day)}">${ui.openMinutes === m.day ? "Hide minutes" : "See minutes"}</button>` : `<div class="t2">${extLink(m.url, esc(m.title))}</div>`}${m.pips.length ? `<div class="sub">${m.pips.map(pipLink).join(" ")}</div>` : ""}</td>
      <td>${esc(m.term ?? "—")}</td>
      <td class="n">${m.views == null ? "—" : num(m.views)}</td>
      <td class="r">${edBtn}<button class="btn sm" data-act="mt-share" data-day="${esc(m.day)}" title="Copy a link that opens this meeting with its minutes and video">Share</button>${m.url ? watchBtn(m) : `<span class="sub">no recording</span>`}</td>
    </tr>${ui.openMinutes === m.day && m.minutes ? `<tr class="detail"><td></td><td colspan="4"><strong>Minutes</strong><div class="md">${discordMd(m.minutes)}</div></td></tr>` : ""}${m.url ? playerRow(m, 5) : ""}`;
  }).join("");

  // Discord-style markdown: minutes are posted on Discord and pasted here as they are. Every
  // character is escaped before markup is added, so pasted HTML stays plain text.
  function discordMd(src) {
    const kept = [];
    const keep = (html) => `\u0000${kept.push(html) - 1}\u0000`;
    const link = (url, text) => keep(`<a href="${url}" target="_blank" rel="noopener">${text}</a>`);
    const inline = (raw) => {
      let s = raw.replace(/`([^`\n]+)`/g, (_, c) => keep(`<code>${esc(c)}</code>`))
        .replace(/\\([*_~|`>#\-\\[\]()])/g, (_, c) => keep(esc(c)));
      s = esc(s)
        // Discord's own tokens, as "Copy Text" gives them: mentions, channels, roles, custom emoji, timestamps.
        .replace(/&lt;@!?\d+&gt;/g, "@user").replace(/&lt;@&amp;\d+&gt;/g, "@role").replace(/&lt;#\d+&gt;/g, "#channel")
        .replace(/&lt;a?(:\w+:)\d+&gt;/g, "$1")
        .replace(/&lt;t:(\d+)(?::[tTdDfFR])?&gt;/g, (_, t) => new Date(Number(t) * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC")
        .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => link(u, t))
        .replace(/&lt;(https?:\/\/\S+?)&gt;/g, (_, u) => link(u, u))
        .replace(/https?:\/\/\S+/g, (u) => { const tail = (u.match(/[.,;:!?)]+$/) || [""])[0]; const url = u.slice(0, u.length - tail.length); return link(url, url) + tail; });
      return s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/__(.+?)__/g, "<u>$1</u>")
        .replace(/~~(.+?)~~/g, "<s>$1</s>")
        .replace(/\|\|(.+?)\|\|/g, `<span class="spoiler" tabindex="0">$1</span>`)
        // Discord also closes on a marker after a space ("*italic *"), as its toolbar often leaves one.
        .replace(/(^|[^\w*])\*(?![\s*])(.+?)\*(?![\w*])/g, "$1<em>$2</em>")
        .replace(/(^|[^\w])_(?!\s)(.+?)_(?!\w)/g, "$1<em>$2</em>");
    };
    const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
    const out = [], lists = [];
    let para = [], quote = [];
    const flushPara = () => { if (para.length) out.push(`<p>${para.join("<br>")}</p>`); para = []; };
    const flushQuote = () => { if (quote.length) out.push(`<blockquote>${quote.join("<br>")}</blockquote>`); quote = []; };
    const closeLists = (to = -1) => { while (lists.length && lists.at(-1).indent > to) out.push(`</li></${lists.pop().tag}>`); };
    const flush = () => { flushPara(); flushQuote(); closeLists(); };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m;
      if ((m = line.match(/^\s*```(.*?)```\s*$/)) && m[1]) { flush(); out.push(`<pre><code>${esc(m[1])}</code></pre>`); continue; }
      if (/^\s*```/.test(line)) {
        flush();
        const buf = [];
        for (i++; i < lines.length && !/^\s*```/.test(lines[i]); i++) buf.push(lines[i]);
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if ((m = line.match(/^>>> ?(.*)$/))) { flush(); out.push(`<blockquote>${discordMd([m[1], ...lines.slice(i + 1)].join("\n"))}</blockquote>`); break; }
      if ((m = line.match(/^> ?(.*)$/))) { flushPara(); closeLists(); quote.push(inline(m[1])); continue; }
      flushQuote();
      if ((m = line.match(/^(\s*)([-*]|\d{1,3}[.)])\s+(.*)$/))) {
        flushPara();
        const indent = m[1].replace(/\t/g, "  ").length, tag = /\d/.test(m[2]) ? "ol" : "ul";
        closeLists(indent);
        const top = lists.at(-1);
        if (top && top.indent === indent && top.tag === tag) out.push("</li><li>");
        else {
          if (top && top.indent === indent) out.push(`</li></${lists.pop().tag}>`);
          const n = parseInt(m[2], 10);
          out.push(`<${tag}${tag === "ol" && n !== 1 ? ` start="${n}"` : ""}><li>`);
          lists.push({ indent, tag });
        }
        out.push(inline(m[3]));
        continue;
      }
      closeLists();
      if ((m = line.match(/^(#{1,3})\s+(.*)$/))) { flushPara(); out.push(`<h${m[1].length + 3}>${inline(m[2])}</h${m[1].length + 3}>`); continue; }
      if ((m = line.match(/^-#\s+(.*)$/))) { flushPara(); out.push(`<p class="sub">${inline(m[1])}</p>`); continue; }
      if (!line.trim()) { flushPara(); continue; }
      para.push(inline(line));
    }
    flush();
    let html = out.join("");
    while (html.includes("\u0000")) html = html.replace(/\u0000(\d+)\u0000/g, (_, n) => kept[Number(n)]);
    return html;
  }

  // A Discord post holds 2,000 characters (4,000 with Nitro); longer minutes go out as several posts.
  const countText = (s) => `${num(s.length)} character${s.length === 1 ? "" : "s"}`;
  const countNote = (s) => `${countText(s)}${s.length > 2000 ? " · more than one Discord post holds (2,000), so post it in parts" : ""}`;
  const minutesPreview = (s) => discordMd(s) || `<p class="muted">Nothing to show yet.</p>`;
  function openMinutes(day) {
    const m = V().meetings.find((x) => x.day === day && x.minutes);
    ed.minutes = m ? { day: m.day, title: m.noRecording ? m.title : "", text: m.minutes, from: m.minutes, fixed: true } : { day: day ?? "", title: "", text: "", from: null, fixed: Boolean(day) };
    ed.minutes.orig = { day: ed.minutes.day, title: ed.minutes.title, text: ed.minutes.text };
    ed.minutesMsg = null;
    render();
    $("#mn-text")?.scrollIntoView({ block: "center", behavior: "smooth" });
  }
  // True while the minutes form holds changes that are not saved.
  const minutesDirty = () => { const m = ed.minutes; return Boolean(m && m.orig && (m.text !== m.orig.text || m.title !== m.orig.title || m.day !== m.orig.day)); };
  // Called on every keystroke and toolbar click: the counter and an open preview follow the text,
  // without redrawing the page (the cursor stays put).
  const minutesCount = () => {
    if (!ed.minutes) return;
    const n = $("#mn-count"), p = $("#mn-preview");
    if (n) n.textContent = countNote(ed.minutes.text);
    if (p && ed.minutes.preview) p.innerHTML = minutesPreview(ed.minutes.text);
  };
  // Toolbar groups, in Discord's order where it has the same buttons: heading; text style; quote,
  // code, spoiler (Discord's icons); lists; link.
  const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const FMT = [
    [["h", "Heading", "Heading (selected lines)"]],
    [["b", "<strong>B</strong>", "Bold"], ["i", "<em>I</em>", "Italic"], ["u", "<u>U</u>", "Underline"], ["s", "<s>S</s>", "Strikethrough"]],
    [["q", icon(`<path fill="currentColor" stroke="none" d="M3 18h7v-7H6.5c0-2.2 1.3-3.5 3.5-3.5V5C5.8 5 3 7.8 3 12v6zm11 0h7v-7h-3.5c0-2.2 1.3-3.5 3.5-3.5V5c-4.2 0-7 2.8-7 7v6z"/>`), "Quote (selected lines)"], ["code", icon(`<polyline points="8 6 2 12 8 18"/><polyline points="16 6 22 12 16 18"/>`), "Code"], ["spoiler", icon(`<path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>`), "Spoiler"]],
    [["ul", "• List", "Bullet list (selected lines)"], ["ol", "1. List", "Numbered list (selected lines)"]],
    [["link", "Link", "Link"]],
  ];

  // Signed-in editors: add or edit a meeting's minutes (the sheet's "Meeting minutes" tab).
  function minutesEditor() {
    if (!editing()) return "";
    const st = ed.minutes;
    if (!st) return `<div class="ed-zone"><p class="edact"><button class="btn ed-btn" data-act="min-open">Add minutes</button></p>${okMsg(ed.minutesMsg)}
      <p class="src">Write the minutes here and copy them to Discord, or paste a Discord post (copied from "Edit message" so its formatting comes along); bold, lists, headings, quotes and links look the same in both. A meeting with a recording gets its minutes from the button in its row; minutes for a day without a recording are listed as a meeting of their own. They are saved in the sheet's "Meeting minutes" tab (created on the first save), which anyone with the sheet's link can read. To hide minutes, set Show to FALSE there.</p></div>`;
    return `<div class="ed-zone"><div class="edform">
      <label>Meeting date *<input id="mn-day" placeholder="YYYY-MM-DD" value="${esc(st.day)}"${st.fixed ? " readonly" : ""}></label>
      <label>Title<input id="mn-title" placeholder="only needed without a recording" value="${esc(st.title)}"></label>
      <div class="edact wide">${FMT.map((g) => `<span class="btn-group">${g.map(([f, label, title]) => `<button class="btn sm" data-act="min-fmt" data-fmt="${f}" title="${title}" aria-label="${title}">${label}</button>`).join("")}</span>`).join("")}</div>
      <label class="wide">Minutes *<textarea id="mn-text" rows="16" placeholder="Paste the Discord post here (copy it from Edit message to keep the formatting), or write them here">${esc(st.text)}</textarea><span class="sub" id="mn-count">${esc(countNote(st.text))}</span></label>
      ${st.preview ? `<div class="wide"><strong>Preview</strong><div class="md" id="mn-preview">${minutesPreview(st.text)}</div></div>` : ""}
      ${st.conflict != null ? `<div class="wide"><p class="ed-err">These minutes were changed in the sheet since you opened them. The sheet now holds:</p><div class="md">${discordMd(st.conflict)}</div>
        <p class="edact"><button class="btn primary" data-act="min-overwrite">Save mine anyway</button><button class="btn" data-act="min-take">Use the sheet's</button></p></div>` : ""}
      ${st.error ? `<p class="ed-err wide">${esc(st.error)}</p>` : ""}
      ${st.pending ? `<div class="edact wide" id="mn-warn"><span class="ed-err">These minutes are not saved. ${st.pending.cancel ? "Close the form" : st.pending.day ? `Open the minutes of ${esc(st.pending.day)}` : "Start new minutes"} and lose the changes?</span><button class="btn danger" data-act="min-discard">Discard changes</button><button class="btn" data-act="min-keep">Keep editing</button></div>` : ""}
      <div class="edact wide"><button class="btn primary" data-act="min-save">Save minutes</button><button class="btn" data-act="min-preview">${st.preview ? "Hide preview" : "Preview"}</button><button class="btn" data-act="min-copy">Copy for Discord</button><button class="btn" data-act="min-cancel">Cancel</button></div>
    </div></div>`;
  }
  // Direct link to one meeting: #council/meeting-2026-11-03 opens its minutes and its player (not
  // playing) and scrolls to it. Called before drawing, on load and on every address change.
  const meetingAnchor = (m) => `meeting-${m.day}`;
  function openLinkedMeeting() {
    const day = (location.hash.match(/\/meeting-(\d{4}-\d{2}-\d{2})$/) || [])[1];
    ui.linkedMeeting = day ?? null;
    if (!day) return;
    // Minutes may arrive with the live sheet read, after this first draw: opened by day either way.
    ui.openMinutes = day;
    const m = V().meetings.find((x) => x.day === day);
    if (!m) return;
    if (m.url) { ui.openVideo = m.id; ui.autoplay = false; }
  }
  function meetingsSection() {
    const all = V().meetings;
    // The latest 4, plus a linked older meeting so its link still lands on it.
    const M = all.slice(0, 4).concat(all.slice(4).filter((m) => m.day === ui.linkedMeeting));
    if (!M.length && !editing()) return "";
    return `
    <section class="sec" id="meetings">
      ${sub("Council meetings", `<span class="src">${extLink(V().channelUrl, "YouTube channel ↗")}${viewsNote() ? ` · ${viewsNote()}` : ""}</span>`)}
      ${M.length ? `<div class="tbl"><table>${MEET_HEAD}<tbody>${meetingRows(M.slice(0, 4))}</tbody></table></div>` : ""}
      ${minutesEditor()}
      <p class="src">The latest 4 meetings. Recordings come from the Council's YouTube channel (older ones are on the channel), read on every build. Minutes are posted by the Council. A PIP number in the minutes (e.g. PIP-36) lists the meeting on that proposal's page.</p>
    </section>`;
  }
  // Hidden for now (owner 2026-11-05): the meetings chart until earlier meetings are known, and the
  // Council sheet's activity chart. Set to true to show them again.
  const SHOW_MEETINGS_CHART = false, SHOW_SHEET_ACTIVITY = false;
  function meetingsChart() {
    const A = V().perMonth;
    return A?.months?.length ? `
      <section class="sec panel">
        ${sub("Council meetings per month", `<span class="src">Recordings on YouTube</span>`)}
        ${termBars(A, "Council meetings per month")}
      </section>` : "";
  }
  const termBars = (A, label) => Charts.bar({ categories: A.months.map((m) => m.month), stacked: true, legend: true, label, series: A.terms.map((t) => ({ name: t, color: termColor(t), values: A.months.map((m) => m.counts[t] ?? 0) })) });

  // Council: who sits on it, what it records, and how it was elected.
  views.council = () => {
    const C = D.council, CC = D.councilChain;
    const showSheetActivity = SHOW_SHEET_ACTIVITY && C?.months?.length;
    // Council elections only: the title says so and members are elected (ranked vote), not a yes/no/abstain vote.
    // Latest election first.
    const elections = D.pips.filter((p) => /council election/i.test(p.title) && p.ranked).sort((x, y) => String(y.votingEndsAt ?? "").localeCompare(String(x.votingEndsAt ?? "")));

    return `
    <section class="sec">
      ${head("Council", `<span class="src">Council sheet + Governance API · <a href="${KB_URL}" target="_blank" rel="noopener">How the DAO and Council work: DAO Knowledge Base ↗</a></span>`)}
      ${membersBlocks()}
    </section>
    ${membersEditor()}
    ${meetingsSection()}
    ${SHOW_MEETINGS_CHART ? meetingsChart() : ""}
    <div class="${showSheetActivity ? "grid-2" : ""}">
      ${showSheetActivity ? `
      <section class="sec panel">
        ${sub("Council activity per month", `<span class="src">Council sheet</span>`)}
        ${termBars(C, "Council activity")}
      </section>` : ""}
      ${CC?.months?.length ? `
      <section class="sec panel">
        ${sub("Council activity per month", `<span class="src">Squads multisigs · Solana mainnet · Governance API</span>`)}
        ${Charts.bar({
          categories: CC.months.map((m) => m.month), stacked: true, legend: true, label: "Council decisions on chain per month",
          series: [
            { name: "Payouts", color: css("--series-1"), values: CC.months.map((m) => m.transfer) },
            { name: "Other decisions", color: css("--series-2"), values: CC.months.map((m) => m.other) },
          ].filter((x) => x.values.some(Boolean)),
          // PIPs whose vote ended that month (passed or failed), on the right axis.
          // Both lines share the right axis: PIPs whose vote ended that month (passed or failed), and
          // the multisigs in use that month.
          line: [
            { name: "PIPs voted", color: css("--series-3"), width: 2.5, values: CC.months.map((m) => D.pips.filter((p) => String(p.votingEndsAt ?? "").slice(0, 7) === m.month && (p.outcome === "passed" || p.outcome === "failed")).length) },
            { name: "Multisigs", color: css("--series-4"), values: CC.months.map((m) => m.multisigs ?? null) },
          ],
          // A term's marker sits at its start day within the month.
          markers: CC.terms.map((t) => {
            const i = CC.months.findIndex((m) => m.month === t.start.slice(0, 7));
            const [y, mo, d] = t.start.split("-").map(Number);
            return i < 0 ? null : { at: i + (d - 1) / new Date(Date.UTC(y, mo, 0)).getUTCDate(), label: t.label };
          }).filter(Boolean),
        })}
        <p class="src">Decisions the Council executed on the DAO's ${CC.multisigs} Squads multisigs (Treasury, Ecosystem Fund and the PIP multisigs): payouts and other decisions per month. Member changes are left out: every handover repeats them on each multisig, so they measure the number of multisigs rather than activity. The lines (right axis) count the PIPs whose vote ended that month and the multisigs in use, each counted from its creation. Dashed lines mark where each Council term began. Read from the chain on every build; nobody types these in.</p>
      </section>` : ""}
    </div>
    ${pastCouncilsSection()}
    <section class="sec">
      ${sub("Elections")}
      <div class="tbl"><table>
        <thead><tr><th>PIP</th><th>Election</th><th>Voting ended</th><th class="r">Seats</th><th class="r">Ballots</th><th>Most first preferences (PVP)</th></tr></thead>
        <tbody>${elections.map((p) => `<tr><td class="pipc">${pipLink(p.pip)}</td><td><div class="t2"><a href="#votes/${p.pip}">${esc(p.title)}</a></div></td><td class="mono">${isoDay(p.votingEndsAt)}</td><td class="n">${p.seats ?? "—"}</td><td class="n">${num(p.totalVotes)}</td><td class="sub">${esc([...p.options].sort((a, b) => b.pvp - a.pvp).filter((o) => o.pvp > 0).slice(0, p.seats ?? 5).map((o) => optName(p, o.option)).join(", "))}</td></tr>`).join("")}</tbody>
      </table></div>
      <p class="src">Ranked elections allocate seats by single transferable vote. This table shows first preferences only; it does not recount the election.</p>
    </section>`;
  };

  // Governance: how PIP votes went, per Council term and per PIP.
  views.governance = () => {
    const voted = D.pips.filter((p) => p.outcome === "passed" || p.outcome === "failed");
    const termCats = ["Pre-Council", ...councilTerms()];
    const inTerm = (p, t) => (t === "Pre-Council" ? !p.sacTerm || p.sacTerm === "N/A" : p.sacTerm === t);
    const passedBy = termCats.map((t) => voted.filter((p) => inTerm(p, t) && p.outcome === "passed").length);
    const failedBy = termCats.map((t) => voted.filter((p) => inTerm(p, t) && p.outcome === "failed").length);
    const part = voted.filter((p) => p.daoPvpM && p.totalPvp).map((p) => ({ pip: p.pip, v: (p.totalPvp / (p.daoPvpM * 1e6)) * 100, wallets: p.totalVotes ?? null }));
    const avgPart = part.length ? part.reduce((s, x) => s + x.v, 0) / part.length : null;

    return `
    <section class="sec">
      ${head("Governance", `<span class="src">Governance API · <a href="${KB_URL}" target="_blank" rel="noopener">How the DAO and Council work: DAO Knowledge Base ↗</a></span>`)}
      <div class="kpis">
        ${kpi("PIPs voted", String(voted.length), "", `${voted.filter((p) => p.outcome === "passed").length} passed · ${voted.filter((p) => p.outcome === "failed").length} failed`)}
        ${kpi("Pass rate", voted.length ? num((voted.filter((p) => p.outcome === "passed").length / voted.length) * 100, 0) + "%" : "—", "")}
        ${kpi("Avg. participation", avgPart == null ? "—" : num(avgPart, 1) + "%", "", "of DAO voting power, per PIP")}
      </div>
    </section>
    <div class="grid-2">
      <section class="sec panel">
        ${sub("PIPs by Council term")}
        ${Charts.bar({ categories: termCats, stacked: true, label: "PIPs by term", series: [{ name: "Passed", color: css("--yes"), values: passedBy }, { name: "Failed", color: css("--no"), values: failedBy }] })}
      </section>
      <section class="sec panel">
        ${sub("Participation per PIP", `<span class="src">PVP voted ÷ DAO PVP</span>`)}
        ${Charts.bar({ categories: part.map((x) => String(x.pip)), label: "Participation per PIP", yFmt: (v) => v + "%", line: { name: "Wallets voted", color: css("--series-3"), values: part.map((x) => x.wallets), yFmt: (v) => num(v) }, series: [{ name: "Participation", color: css("--series-1"), values: part.map((x) => Math.round(x.v * 10) / 10) }] })}
      </section>
    </div>
    ${votersSection()}
    ${videosSection()}`;
  };

  // Council videos other than meeting recordings (explainers and the like).
  function videosSection() {
    const list = V().other;
    if (!list.length) return "";
    return `<section class="sec">
      ${sub("Videos", `<span class="src">${extLink(V().channelUrl, "Council's YouTube channel ↗")}</span>`)}
      <div class="tbl"><table>
        <thead><tr><th>Date</th><th>Video</th><th class="r">Views</th><th></th></tr></thead>
        <tbody>${list.map((v) => `<tr><td class="mono">${esc(isoDay(v.published))}</td><td><div class="t2">${extLink(v.url, esc(v.title))}</div>${v.summary ? `<div class="sub">${esc(v.summary)}</div>` : ""}</td><td class="n">${v.views == null ? "—" : num(v.views)}</td><td class="r">${watchBtn(v)}</td></tr>${playerRow(v, 4)}`).join("")}</tbody>
      </table></div>
    </section>`;
  }

  // Largest voters by voting power (PVP) at their most recent vote, with their share of the DAO's PVP.
  function votersSection() {
    const V = D.voters;
    if (!V?.top?.length) return "";
    const pct = (x) => (x == null ? "—" : num(x * 100, 2) + "%");
    const sum = V.top.reduce((s, w) => s + (w.share ?? 0), 0);
    return `<section class="sec">
      ${sub("Largest voters", `<span class="src">${num(V.count)} wallets have voted · voting power at each wallet's latest vote</span>`)}
      <div class="tbl"><table>
        <thead><tr><th>Wallet</th><th class="r">PVP</th><th class="r">Share of DAO PVP</th><th class="r">PIPs voted</th><th>Latest vote</th><th>Locked until</th></tr></thead>
        <tbody>${V.top.map((w) => `<tr>
          <td>${ownerLabel(w.wallet) ? `<strong>${esc(ownerLabel(w.wallet))}</strong><div class="sub">${solAcc(w.wallet)}</div>` : solAcc(w.wallet)}</td>
          <td class="n">${compact(w.pvp)}</td><td class="n">${pct(w.share)}</td><td class="n">${num(w.pips)}</td>
          <td>${pipLink(w.pip)} <span class="sub">${esc(day(w.t))}</span></td>
          <td class="mono">${w.lockedUntil ? esc(day(w.lockedUntil)) : "—"}</td>
        </tr>`).join("")}
          <tr><td><strong>Top ${V.top.length} together</strong></td><td></td><td class="n"><strong>about ${pct(sum)}</strong></td><td></td><td></td><td></td></tr></tbody>
      </table></div>
      <p class="src">PVP depends on how much POLIS is locked and for how long, so it changes over time; each wallet is shown as of its most recent vote, measured against the DAO's total PVP for that proposal. Wallets that never voted are not visible here.</p>
    </section>`;
  }

  views.limit = () => {
    const L = D.limit;
    if (!L?.current) return `<section class="sec">${head("Ecosystem Fund limit")}<p class="muted">No fund history yet.</p></section>`;
    const fund = D.series.fundATLAS?.points ?? [];
    return `
    <section class="sec">
      ${head("Ecosystem Fund limit", `<span class="src">Solana mainnet · derived automatically</span>`)}
      <p class="lede">The PIP spending limit is ${L.percent}% of the Ecosystem Fund. Each quarter the build takes the fund's ATLAS balance at the start of the quarter and holds ${L.percent}% of it as that quarter's limit. Nobody types this number in; it is recomputed from the fund's on-chain history on every build.</p>
      <div class="kpis">
        ${kpi(`Limit ${L.current.quarter}`, num(L.current.limit), "ATLAS", `${L.percent}% of ${num(L.current.balance)} on ${L.current.start}`)}
        ${kpi("If set today", num(L.live.limit), "ATLAS", `${L.percent}% of the current ${num(L.live.balance)}`)}
        ${kpi("Fund balance", compact(L.live.balance), "ATLAS")}
        ${kpi("Last refill", L.lastRefill ? compact(L.lastRefill.amount) : "—", L.lastRefill ? "ATLAS" : "", L.lastRefill ? `${day(L.lastRefill.t)} · ${solTx(L.lastRefill.sig)}` : "")}
      </div>
    </section>
    <section class="sec panel">
      ${sub("Ecosystem Fund balance", `<span class="src">rebuilt from every fund transaction</span>`)}
      ${Charts.line({ label: "Ecosystem Fund ATLAS", yFmt: compact, series: [{ name: "Fund ATLAS", color: css("--series-1"), points: fund }] })}
    </section>
    <section class="sec">
      ${sub("Limit by quarter")}
      <div class="tbl"><table>
        <thead><tr><th>Quarter</th><th>Start</th><th class="r">Fund balance at start</th><th class="r">${L.percent}% limit</th><th>Refills during quarter</th></tr></thead>
        <tbody>${[...L.quarters].reverse().map((q) => `<tr><td class="mono">${esc(q.quarter)}</td><td class="mono">${esc(q.start)}</td><td class="n">${num(q.balance)}</td><td class="n"><strong>${num(q.limit)}</strong></td><td>${q.refills.map((r) => `${day(r.t)}: +${num(r.amount)} ${solTx(r.sig)}`).join("<br>") || `<span class="sub">none</span>`}</td></tr>`).join("")}</tbody>
      </table></div>
    </section>`;
  };

  views.balance = () => {
    // Balance sheet: accounts in use. A retired account (emptied, kept for its history) is left out.
    const A = Object.fromEntries(Object.entries(D.accounts).filter(([, a]) => !a.retired));
    // Payouts per month. Both charts share every month from the first payout in either currency to
    // the latest one; a month without payouts shows as an empty bar, so the two charts line up.
    const outs = D.payments.filter((p) => p.direction === "out" && p.confidence !== "internal");
    const months = [];
    if (outs.length) {
      const ks = outs.map((p) => day(p.t).slice(0, 7)).sort();
      for (let [y, mo] = ks[0].split("-").map(Number); `${y}-${String(mo).padStart(2, "0")}` <= ks[ks.length - 1]; mo === 12 ? (y++, mo = 1) : mo++) months.push(`${y}-${String(mo).padStart(2, "0")}`);
    }
    const monthly = (sym) => {
      const m = new Map();
      for (const p of outs) if (p.symbol === sym) m.set(day(p.t).slice(0, 7), (m.get(day(p.t).slice(0, 7)) ?? 0) + p.amount);
      return { categories: months, values: months.map((k) => Math.round(m.get(k) ?? 0)) };
    };
    const ma = monthly("ATLAS"), mu = monthly("USDC");
    const S = D.series;
    const tA = S.treasuryATLAS;
    // One Treasury line: the initial Treasury (before the multisig) until the current one's history starts.
    const withOld = (sym, pts = []) => [...(S[`oldTreasury${sym}`]?.points ?? []).filter(([d]) => !pts.length || d < pts[0][0]), ...pts];
    const tU = withOld("USDC", S.treasuryUSDC?.points), tAP = withOld("ATLAS", tA?.points);
    // Both Treasury charts share one time axis, from whichever history starts first.
    const axisFrom = [tU[0]?.[0], tAP[0]?.[0]].filter(Boolean).sort()[0];
    return `
    <section class="sec">
      ${head("DAO balance sheet", `<span class="src">Solana mainnet · as of ${esc(isoDay(D.dataAt))}</span>`)}
      <div class="tbl"><table>
        <thead><tr><th>Account</th><th>Address</th><th class="r">ATLAS</th><th class="r">USDC</th><th class="r">SOL</th><th class="r">USD</th></tr></thead>
        <tbody>${Object.values(A).map((a) => `<tr><td><strong>${esc(a.label)}</strong></td><td>${solAcc(a.wallet)}</td><td class="n">${num(a.now.ATLAS)}</td><td class="n">${num(a.now.USDC, 2)}</td><td class="n">${num(a.now.SOL, 2)}</td>${usdCell(a.now)}</tr>`).join("")}
          <tr class="total"><td class="total-label">Total Funds</td><td></td>${["ATLAS", "USDC", "SOL"].map((s) => `<td class="n">${num(Object.values(A).reduce((t, a) => t + (a.now[s] ?? 0), 0), s === "ATLAS" ? 0 : 2)}</td>`).join("")}${(() => { const vs = Object.values(A).map((a) => usdOf(a.now)); return `<td class="n">${vs.some((v) => v == null) ? `<span class="blank">—</span>` : "$" + num(vs.reduce((t, v) => t + v, 0), 0)}</td>`; })()}</tr></tbody>
      </table></div>
      <p class="src">${pricesNote()}</p>
    </section>
    ${walletsSection()}
    <div class="grid-2">
      <section class="sec panel">
        ${sub("Treasury USDC", `<span class="src" title="Rebuilt from every transaction of the Treasury's USDC account">daily balance history</span>`)}
        ${Charts.line({ label: "Treasury USDC", yFmt: compact, xFrom: axisFrom, series: [{ name: "Treasury USDC", color: css("--series-2"), points: tU }] })}
      </section>
      <section class="sec panel">
        ${sub("Treasury ATLAS", `<span class="src" title="${tA?.source === "import+snapshots" ? `Imported daily balances until ${tA.snapshotsFrom}, then the dashboard's own daily snapshots` : "The dashboard's own daily snapshots"}">daily balance history</span>`)}
        ${tA?.points?.length > 1 ? Charts.line({ label: "Treasury ATLAS", yFmt: compact, xFrom: axisFrom, series: [{ name: "Treasury ATLAS", color: css("--series-1"), points: tAP }] }) : `<p class="muted">The Treasury's ATLAS account receives tens of thousands of fee transfers a day, so its history is recorded as one balance snapshot per build rather than rebuilt from transactions. ${tA?.points?.length ? `First snapshot: ${num(tA.points[0][1])} ATLAS on ${tA.points[0][0]}.` : ""}</p>`}
      </section>
    </div>
    ${D.income?.monthly?.length ? `
    <section class="sec">
      ${sub("Recurring income", `<span class="src">${esc([...D.income.sources.map((s) => s.label ?? short(s.owner)), ...(D.income.crafting ? ["Crafting fees"] : [])].join(", "))} · summed per month</span>`)}
      <div class="kpis">${D.income.sources.map((s) => kpi(s.label ?? short(s.owner), compact(s.totals.ATLAS ?? 0), "ATLAS", `${num(s.totals.USDC ?? 0, 0)} USDC · ${num(s.transfers)} transfers since ${esc(D.income.monthly[0].month)}`)).join("")}${D.income.crafting ? kpi("Crafting fees", compact(D.income.crafting.total), "ATLAS", `since ${esc(D.income.crafting.from)} · Treasury balance change minus recorded movements`) : ""}</div>
      <div class="grid-2">
        <section class="sec panel">
          ${sub("USDC income per month")}
          ${Charts.bar({ categories: D.income.monthly.map((m) => m.month), label: "USDC income per month", yFmt: compact, legend: true, series: [{ name: "Marketplace fees", color: css("--series-2"), values: D.income.monthly.map((m) => Math.round(m.USDC)) }] })}
        </section>
        <section class="sec panel">
          ${sub("ATLAS income per month")}
          ${Charts.bar({ categories: D.income.monthly.map((m) => m.month), label: "ATLAS income per month", yFmt: compact, stacked: true, series: [
            { name: "Marketplace fees", color: css("--series-1"), values: D.income.monthly.map((m) => Math.round(m.ATLAS)) },
            ...(D.income.crafting ? [{ name: "Crafting fees", color: css("--series-4"), values: D.income.monthly.map((m) => Math.max(0, Math.round(m.crafting ?? 0))) }] : []),
          ] })}
        </section>
      </div>
    </section>` : ""}
    <div class="grid-2">
      <section class="sec panel">
        ${sub("USDC paid out per month")}
        ${Charts.bar({ categories: mu.categories, label: "USDC outflows per month", yFmt: compact, series: [{ name: "USDC", color: css("--series-2"), values: mu.values }] })}
      </section>
      <section class="sec panel">
        ${sub("ATLAS paid out per month", `<span class="src">excludes Treasury → Fund refills</span>`)}
        ${Charts.bar({ categories: ma.categories, label: "ATLAS outflows per month", yFmt: compact, series: [{ name: "ATLAS", color: css("--series-1"), values: ma.values }] })}
      </section>
    </div>
    ${otherIncomeSection()}`;
  };

  // Every inflow outside the recurring fees, summed per income category the Council labelled it
  // with (e.g. Initial funding), otherwise per sender. Returns and internal transfers are left out.
  function otherIncomeSection() {
    const by = new Map();
    for (const p of D.payments) {
      if (p.direction !== "in" || p.isReturn || !p.owner || !(p.confidence === "income" || p.confidence === "category" || (p.confidence === "inferred" && p.category))) continue;
      const key = p.category ? `cat:${p.category}` : p.owner;
      const g = by.get(key) ?? { key, category: p.category ?? null, owner: p.owner, owners: new Set(), ATLAS: 0, USDC: 0, n: 0, first: p.t, last: p.t };
      g.owners.add(p.owner);
      if (p.symbol === "ATLAS" || p.symbol === "USDC") g[p.symbol] += p.amount;
      g.n++; g.first = Math.min(g.first, p.t); g.last = Math.max(g.last, p.t);
      by.set(key, g);
    }
    // Senders of less than 10 ATLAS and 1 USDC in total are dust (spam or test transfers) and left out.
    const rows = [...by.values()].filter((g) => g.ATLAS >= 10 || g.USDC >= 1).sort((a, b) => a.first - b.first);
    if (!rows.length) return "";
    return `<section class="sec">
      ${sub("Other income", `<span class="src">one-off transfers into the DAO accounts, per sender</span>`)}
      <div class="tbl"><table>
        <thead><tr><th>Source</th><th class="r">ATLAS</th><th class="r">USDC</th><th class="r">Transfers</th><th>First</th><th>Last</th><th></th></tr></thead>
        <tbody>${rows.map((g) => `<tr>
          <td>${g.category
            ? `<strong>${esc(g.category)}</strong><div class="sub">${[...g.owners].map((o) => ownerLabel(o) ? `${esc(ownerLabel(o))} ${solAcc(o)}` : solAcc(o)).join("<br>")}</div>`
            : ownerLabel(g.owner) ? `<strong>${esc(ownerLabel(g.owner))}</strong><div class="sub">${solAcc(g.owner)}</div>` : solAcc(g.owner)}</td>
          <td class="n">${g.ATLAS ? num(g.ATLAS, 0) : "—"}</td><td class="n">${g.USDC ? num(g.USDC, 2) : "—"}</td><td class="n">${num(g.n)}</td>
          <td class="mono">${dayCell(g.first)}</td><td class="mono">${dayCell(g.last)}</td>
          <td><button class="btn sm" data-act="pay-inflows">Transfers</button></td>
        </tr>`).join("")}</tbody>
      </table></div>
      <p class="src">Transfers lists every inflow on the Payments page. Label an inflow there (e.g. Initial funding) to group it here by what it was; name a sender by adding it as a wallet above.</p>
    </section>`;
  }

  views.votes = (param) => {
    if (param) return voteDetail(Number(param));
    const rows = [...D.pips].reverse();
    return `
    <section class="sec">
      ${head("Proposals", `<span class="src">Governance API</span>`)}
      <div class="tbl"><table>
        <thead><tr><th>PIP</th><th>Title</th><th>Voting ended</th><th>Result</th><th class="r">Votes</th><th class="r">PVP voted</th><th>Split (PVP)</th><th class="r">Yes</th></tr></thead>
        <tbody>${rows.map((p) => `<tr class="click" data-go="#votes/${p.pip}"><td class="pipc">${pipLink(p.pip)}</td><td><div class="t2"><a href="#votes/${p.pip}">${esc(p.title)}</a></div></td><td class="mono">${isoDay(p.votingEndsAt)}</td><td>${outcomeChip(p.outcome)}</td><td class="n">${num(p.totalVotes)}</td><td class="n">${compact(p.totalPvp)}</td><td>${splitBar(p)}</td><td class="n">${p.ranked ? "ranked" : yesShare(p) == null ? "—" : num(yesShare(p) * 100, 1) + "%"}</td></tr>`).join("")}</tbody>
      </table></div>
    </section>`;
  };

  function voteDetail(n) {
    const p = D.pips.find((x) => x.pip === n);
    if (!p) return `<p class="muted">PIP-${n} not found. <a href="#votes">Back to all proposals</a></p>`;
    const v = voteCache.get(n);
    if (!v) {
      fetch(`data/votes/${n}.json`).then((r) => (r.ok ? r.json() : null)).then((j) => { voteCache.set(n, j ?? { votes: [], buckets: [], timeline: [], missing: true }); render(); });
    }
    const tot = p.options.reduce((s, o) => s + o.pvp, 0) || 1;
    const optRows = [...p.options].sort((a, b) => b.pvp - a.pvp).map((o) => `<tr><td>${esc(optName(p, o.option))}</td><td class="n">${num(o.count)}</td><td class="n">${num(o.pvp)}</td><td class="n">${num((o.pvp / tot) * 100, 1)}%</td></tr>`).join("");
    const opts = p.options.map((o) => o.option);
    const colorOf = (o, i) => ({ yes: css("--yes"), no: css("--no"), abstain: css("--abstain") }[o] ?? css(`--series-${(i % 4) + 1}`));

    let detail = `<p class="muted">Loading votes…</p>`;
    if (v && v.missing) detail = `<p class="muted">Vote detail is not available for this PIP.</p>`;
    else if (v) {
      const top = [...v.votes].sort((a, b) => b.pvp - a.pvp).slice(0, 15);
      const firstOpts = [...new Set(v.votes.map((x) => x.first))];
      const acc = {}; const tl = v.timeline.map((d) => { for (const [o, x] of Object.entries(d.byOption)) acc[o] = (acc[o] ?? 0) + x.pvp; return { day: d.day, ...acc }; });
      detail = v.ranked ? rankedDetail(p, v, top, tl) : `
      <section class="sec panel">
        ${sub("Voting power over the voting period", `<span class="src">cumulative PVP by ${v.ranked ? "first choice" : "option"}</span>`)}
        ${Charts.line({ label: "Cumulative PVP", yFmt: compact, area: false, legend: true, series: firstOpts.map((o, i) => ({ name: optName(p, o), color: colorOf(o, i), points: tl.map((d) => [d.day, d[o] ?? 0]) })) })}
      </section>
      <div class="grid-2">
        <section class="sec">
          ${sub("By voter size", `<span class="src">${v.ranked ? "first choice" : "option"}</span>`)}
          <div class="tbl"><table><thead><tr><th>Voter size</th>${firstOpts.map((o, i) => `<th class="r" style="color:${colorOf(o, i)}">${esc(optName(p, o))}</th>`).join("")}</tr></thead>
          <tbody>${v.buckets.map((b) => `<tr><td>${esc(b.label)}</td>${firstOpts.map((o, i) => `<td class="n"><span style="color:${colorOf(o, i)}">${num(b.byOption[o]?.count ?? 0)}</span><div class="sub">${compact(b.byOption[o]?.pvp ?? 0)} PVP</div></td>`).join("")}</tr>`).join("")}</tbody></table></div>
        </section>
        <section class="sec">
          ${sub("Largest voters")}
          <div class="tbl"><table><thead><tr><th>Wallet</th><th>Vote</th><th class="r">PVP</th><th>POLIS locked until</th></tr></thead>
          <tbody>${top.map((x) => `<tr><td>${solAcc(x.wallet)}</td><td style="color:${colorOf(x.first, firstOpts.indexOf(x.first))}">${esc(x.choice)}</td><td class="n">${num(x.pvp)}</td><td class="mono sub">${x.lockedUntil ? day(x.lockedUntil) : "—"}</td></tr>`).join("")}</tbody></table></div>
        </section>
      </div>`;
    }

    return `
    <section class="sec">
      <p class="src"><a href="#votes">← All proposals</a></p>
      ${head(`PIP-${p.pip}: ${p.title}`, outcomeChip(p.outcome))}
      <p class="src">Voting ${isoDay(p.votingStartsAt)} → ${isoDay(p.votingEndsAt)}${p.url ? ` · ${extLink(p.url, "Read the proposal")}` : ""}</p>
      <div class="kpis">
        ${kpi("Ballots", num(p.totalVotes))}
        ${kpi("PVP voted", compact(p.totalPvp))}
        ${p.daoPvpM ? kpi("Participation", num((p.totalPvp / (p.daoPvpM * 1e6)) * 100, 1) + "%", "", `of ${num(p.daoPvpM)}M DAO PVP`) : ""}
        ${p.ranked ? "" : kpi("Yes (of yes + no)", yesShare(p) == null ? "—" : num(yesShare(p) * 100, 1) + "%")}
      </div>
      <div class="tbl"><table><thead><tr><th>${p.ranked ? "Candidate (first preference)" : "Option"}</th><th class="r">Ballots</th><th class="r">PVP</th><th class="r">Share</th></tr></thead><tbody>${optRows}</tbody></table></div>
      ${p.ranked ? `<p class="src">Ranked election for ${p.seats} seat${p.seats === 1 ? "" : "s"}, ${num(p.distinctBallots)} distinct ballot orders. Seats are allocated by single transferable vote; the figures above are first preferences only.</p>` : ""}
    </section>
    ${pipPaymentsSection(p)}
    ${pipMeetingsSection(p)}
    ${detail}`;
  }

  // Proposal page: Council meetings whose minutes (or title) name this PIP.
  function pipMeetingsSection(p) {
    const list = V().meetings.filter((m) => m.pips.includes(p.pip));
    if (!list.length) return "";
    return `<section class="sec">
      ${sub("Discussed in Council meetings", `<a class="src" href="#council">All meetings →</a>`)}
      <div class="tbl"><table>${MEET_HEAD}<tbody>${meetingRows(list)}</tbody></table></div>
    </section>`;
  }

  // Proposal page: the PIP's funding and every transaction matched to it (Payments page logic).
  function pipPaymentsSection(p) {
    const f = p.funding, tbl = pipLegsTable(p.pip);
    if (!f && !tbl) return "";
    const summary = f ? `<div class="tbl"><table>${FUNDED_HEAD}<tbody>${fundedRows(p)}</tbody></table></div>` : "";
    return `<section class="sec">
      ${sub("Payments", `<a class="src" href="#payments">All payments →</a>`)}
      ${summary}
      ${tbl ? `<div class="tbl">${tbl}</div>` : `<p class="muted">No on-chain payout has been matched to this PIP yet. A Council label on the payout links it here.</p>`}
    </section>`;
  }

  views.health = () => {
    const sevs = ["critical", "warning", "info"];
    const counts = Object.fromEntries(sevs.map((s) => [s, D.health.filter((h) => h.severity === s).length]));
    const list = D.health.filter((h) => ui.healthSev === "all" || h.severity === ui.healthSev);
    const chip = { critical: "crit", warning: "warn", info: "acc" };
    return `
    <section class="sec">
      ${head("Data health", `<span class="src">checked on every build</span>`)}
      <p class="lede">Every build compares the Council's sheet, the governance API, and the chain. Anything that disagrees or is missing is listed here. Sheet issues are fixed in the sheet; payouts that need a label are labelled in the sheet's payment-labels tab. The list clears itself on the next build once the source is corrected.</p>
      <div class="kpis">
        ${kpi("Critical", String(counts.critical), "", "a figure on this site is probably wrong", maintCls())}
        ${kpi("Warnings", String(counts.warning), "", "the sources disagree or a value is missing", maintCls())}
        ${kpi("Info", String(counts.info), "", "worth a look", maintCls())}
      </div>
      <div class="controls"><select id="f-sev" aria-label="Severity">${[["all", "All flags"], ...sevs.map((s) => [s, s])].map(([k, l]) => `<option value="${k}" ${ui.healthSev === k ? "selected" : ""}>${l}</option>`).join("")}</select></div>
      <div class="panel flush${maintCls()}"><div class="flags">${list.map((h) => `<div class="flag"><span class="chip ${chip[h.severity]}">${h.severity}</span><span class="chip">${esc(h.area)}</span><p>${h.pip ? pipLink(h.pip) + ": " : ""}${esc(h.message.replace(/^PIP-\d+:\s*/, ""))}</p></div>`).join("") || `<p class="muted" style="padding:14px">No flags. Everything agrees.</p>`}</div></div>
    </section>`;
  };

  // ---------- routing ----------
  // A table wider than its box scrolls sideways (.scroll); one that fits keeps its header pinned (styles.css).
  function fitTables() {
    for (const t of document.querySelectorAll(".tbl")) {
      t.classList.remove("scroll");
      const tb = t.querySelector("table");
      if (tb && tb.scrollWidth > t.clientWidth + 1) t.classList.add("scroll");
    }
  }

  // Section navigation beside the page (wide screens only, see .toc in styles.css): the page's
  // headlines, when it has more than two. A click scrolls to that section; the one in view is marked.
  let tocTargets = [];
  // Each section gets an id from its headline (a section that has one keeps it), so a link like
  // #council/elections opens the page at that section. The entries are real links (copyable); a click
  // scrolls there and puts that link in the address bar without redrawing the page.
  const ANCHOR_RE = /^[a-z][a-z0-9-]*$/;
  const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/^(\d)/, "s-$1") || "section";
  // The page part of the address: the route, plus a proposal number (#votes/36), without a section.
  const pageHash = () => { const [route, param] = location.hash.slice(1).split("/"); return `#${route || "overview"}${/^\d+$/.test(param ?? "") ? `/${param}` : ""}`; };
  function buildToc() {
    const nav = $("#toc");
    if (!nav) return;
    if (!nav.dataset.bound) {
      nav.dataset.bound = "1";
      nav.addEventListener("click", (e) => {
        const a = e.target.closest("[data-toc]");
        if (!a) return;
        e.preventDefault();
        history.replaceState(null, "", a.getAttribute("href"));
        const i = Number(a.dataset.toc);
        if (i === 0) window.scrollTo({ top: 0, behavior: "smooth" }); else tocTargets[i]?.scrollIntoView({ behavior: "smooth" });
      });
    }
    const heads = [...$("#view").querySelectorAll(".sec-head h2, .sec-head h3")].filter((h) => !h.closest("tr.detail") && h.textContent.trim());
    tocTargets = heads.map((h) => h.closest(".sec") ?? h.parentElement);
    const used = new Set();
    tocTargets.forEach((el, i) => {
      if (!el.id) {
        const want = slug(heads[i].textContent.trim());
        let id = want, n = 2;
        while (used.has(id) || document.getElementById(id)) id = `${want}-${n++}`;
        el.id = id;
      }
      used.add(el.id);
    });
    nav.hidden = heads.length <= 2;
    const base = pageHash();
    // The page headline links to the page itself; every other entry to its section.
    nav.innerHTML = nav.hidden ? "" : heads.map((h, i) => `<a class="toc-link${h.tagName === "H2" ? " top" : ""}" data-toc="${i}" href="${esc(i === 0 ? base : `${base}/${tocTargets[i].id}`)}">${esc(h.textContent.trim())}</a>`).join("");
    markToc();
  }
  function markToc() {
    const nav = $("#toc");
    if (!nav || nav.hidden || typeof getComputedStyle !== "function") return;
    const line = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--top-h")) || 0) + 40;
    let on = 0;
    tocTargets.forEach((el, i) => { if (el.getBoundingClientRect().top <= line) on = i; });
    // At the very bottom the last section is the one in view, even if its top never reaches the line.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) on = tocTargets.length - 1;
    nav.querySelectorAll(".toc-link").forEach((b, i) => b.classList.toggle("on", i === on));
  }

  // "#council/meetings" opens the Council page at its #meetings section; any other page opens at the top.
  // The page keeps growing after the first draw (live sheet data, images, charts), which would push a
  // linked section or meeting down. For a few seconds it is scrolled back into place on every size
  // change, until the visitor scrolls or clicks themselves.
  let pin = null;
  function scrollToAnchor() {
    const parts = location.hash.slice(1).split("/");
    const anchor = parts.length > 1 ? parts[parts.length - 1] : "";
    const el = ANCHOR_RE.test(anchor) ? document.getElementById(anchor) : null;
    if (!el) { pin = null; window.scrollTo({ top: 0 }); return; }
    // On a reload the browser would put back the old scroll position after this; the link decides.
    if ("scrollRestoration" in history) history.scrollRestoration = "manual";
    el.scrollIntoView();
    pin = { id: anchor, until: Date.now() + 4000 };
  }
  function keepAnchor() {
    if (!pin) return;
    if (Date.now() > pin.until) { pin = null; return; }
    document.getElementById(pin.id)?.scrollIntoView();
  }

  function render() {
    const [route, param] = (location.hash.slice(1) || "overview").split("/");
    const r = views[route] && (route !== "health" || maintOpen()) ? route : "overview";
    document.querySelectorAll(".tabs a").forEach((a) => {
      a.setAttribute("aria-current", a.dataset.route === r ? "page" : "false");
      if (a.dataset.route === "health") { a.hidden = !maintOpen(); a.classList?.toggle("ed-only", Boolean(maintCls())); }
    });
    Charts.reset();
    const view = $("#view");
    view.innerHTML = previewInfo() + (r === "payments" || r === "transactions" || r === "council" || r === "balance" ? editBanner() : "") + views[r](param);
    Charts.mount(view);
    fitTables();
    buildToc();
    keepAnchor();
    $("#tip").hidden = true;
    const bar = $("#editbar");
    if (bar) bar.innerHTML = editBar();
  }

  const EDIT_ACTIONS = new Set(["min-open", "min-cancel", "min-keep", "min-discard", "min-fmt", "min-copy", "min-preview", "min-take", "min-save", "min-overwrite", "ed-signin", "ed-signout", "ed-update", "doc-open", "doc-close", "doc-upload", "wal-open", "wal-cancel", "wal-save", "ed-preview", "lbl-open", "lbl-cancel", "lbl-save", "lbl-clear", "lbl-clear-yes", "lbl-clear-no", "pip-edit", "pip-reload", "pip-cancel", "pip-save", "pip-overwrite", "mem-seed", "mem-open", "mem-cancel", "mem-save"]);
  function editClick(e) {
    const el = e.target.closest("[data-act]");
    if (!el || !EDIT_ACTIONS.has(el.dataset.act)) return false;
    e.preventDefault();
    edAction(el.dataset.act, el);
    return true;
  }

  function bind() {
    const view = $("#view");
    view.addEventListener("click", (e) => {
      if (editClick(e)) return;
      const go = e.target.closest("[data-go]");
      if (go && !e.target.closest("a")) { location.hash = go.dataset.go; return; }
      const row = e.target.closest("tr.click[data-pip]");
      if (row && !e.target.closest("a")) { const n = Number(row.dataset.pip); ui.openPip = ui.openPip === n ? null : n; render(); return; }
      const act = e.target.closest("[data-act]");
      // These open the Transactions page with its filters set.
      const toTransactions = () => { if (location.hash === "#transactions") render(); else location.hash = "#transactions"; window.scrollTo(0, 0); };

      if (act?.dataset.act === "minutes") { ui.openMinutes = ui.openMinutes === act.dataset.day ? null : act.dataset.day; render(); return; }
      // Share: copies the meeting's direct link. If the browser refuses, the page goes to that link
      // instead, so it stands in the address bar to copy from there.
      if (act?.dataset.act === "mt-share") {
        const hash = `#council/meeting-${act.dataset.day}`, url = location.href.split("#")[0] + hash;
        const done = (label) => { act.textContent = label; setTimeout(() => { act.textContent = "Share"; }, 2000); };
        Promise.resolve().then(() => navigator.clipboard.writeText(url)).then(() => done("Link copied"), () => { location.hash = hash; done("Link in address bar"); });
        return;
      }
      if (act?.dataset.act === "yt-play") { ui.openVideo = ui.openVideo === act.dataset.id ? null : act.dataset.id; ui.autoplay = true; playerTouched = false; render(); return; }
      if (act?.dataset.act === "pay-inflows") { ui.payDir = "in"; ui.payConf = "all"; ui.payAccount = "all"; toTransactions(); return; }
      if (act?.dataset.act === "attention" || act?.dataset.act === "pay-filter") { ui.payConf = act.dataset.key ?? "attention"; ui.payAccount = act.dataset.acc ?? "all"; ui.payDir = "out"; toTransactions(); }
    });
    // Typing in the movements filter redraws the page; focus and cursor are put back where they were.
    // Closing or reloading the tab with unsaved minutes: the browser's own leave-page warning
    // (the only warning a page can give at that point).
    window.addEventListener("beforeunload", (e) => { if (minutesDirty()) { e.preventDefault(); e.returnValue = ""; } });
    view.addEventListener("input", (e) => {
      // The minutes form: kept as it is typed (no redraw), see "min-open".
      const mn = { "mn-day": "day", "mn-title": "title", "mn-text": "text" }[e.target.id];
      if (mn && ed.minutes) { ed.minutes[mn] = e.target.value; if (mn === "text") minutesCount(); return; }
      if (e.target.id !== "f-q") return;
      ui.payQuery = e.target.value;
      const at = e.target.selectionStart;
      render();
      const q = $("#f-q");
      if (q) { q.focus(); q.setSelectionRange(at, at); }
    });
    view.addEventListener("change", (e) => {
      const id = e.target.id;
      if (id === "f-acc") ui.payAccount = e.target.value;
      else if (id === "f-conf") ui.payConf = e.target.value;
      else if (id === "f-dir") ui.payDir = e.target.value;
      else if (id === "f-sev") ui.healthSev = e.target.value;
      else return;
      render();
    });
    window.addEventListener("hashchange", () => { ui.openVideo = null; playerTouched = false; openLinkedMeeting(); render(); scrollToAnchor(); });
    for (const t of ["wheel", "touchstart", "keydown", "mousedown"]) window.addEventListener(t, () => { pin = null; }, { passive: true });
    if (typeof ResizeObserver === "function") new ResizeObserver(keepAnchor).observe(document.body);
    let tocFrame = 0;
    window.addEventListener("scroll", () => { if (!tocFrame) tocFrame = requestAnimationFrame(() => { tocFrame = 0; markToc(); }); }, { passive: true });
    window.addEventListener("resize", fitTables);
    // Pinned table headers sit right under the page header, whose height changes with wrapping.
    const top = document.querySelector(".top");
    // Measured once right away too: a linked section is scrolled to before the observer first reports,
    // and its offset below the header depends on this height.
    const setTopH = () => { if (top) document.documentElement.style.setProperty("--top-h", `${top.getBoundingClientRect().height}px`); };
    setTopH();
    if (top && "ResizeObserver" in window) new ResizeObserver(() => { setTopH(); keepAnchor(); }).observe(top);
    $("#editbar")?.addEventListener("click", editClick);
    // Copy buttons: handled before any row click, so copying never opens or follows the row.
    window.addEventListener("click", (e) => {
      const b = e.target.closest?.("button.copy");
      if (!b) return;
      e.preventDefault(); e.stopPropagation();
      navigator.clipboard?.writeText(b.dataset.copy).then(() => {
        b.classList.add("done"); b.title = "Copied";
        setTimeout(() => { b.classList.remove("done"); b.title = "Copy address"; }, 1200);
      });
    }, true);
    window.addEventListener("editor:change", () => { if (editing() && !ed.docs) loadDocs(); render(); });
  }

  async function boot() {
    try {
      const r = await fetch("data/dashboard.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      D = await r.json();
    } catch (e) {
      $("#view").innerHTML = `<p class="note">The dashboard data could not be loaded (${esc(e.message)}). If you opened this file directly, run <span class="mono">npm run serve</span> and open the local address instead.</p>`;
      return;
    }
    setStamp();
    $("#foot").innerHTML = `
      <p>This dashboard is a third-party created service, funded through the Star Atlas DAO Ecosystem Fund and maintained by the DAO Council.</p>
      <p>Built from public sources: the Council's <a href="${esc(D.sources.sheet)}" target="_blank" rel="noopener">PIP tracker sheet</a>, the Star Atlas governance API, and Solana mainnet.</p>
      <p>New to the DAO? The <a href="${KB_URL}" target="_blank" rel="noopener">Star Atlas DAO Knowledge Base</a> explains governance, PIPs, the Council, and the treasury.</p>
      <p id="foot-prices">Loading live prices from the Jupiter Price API...</p>`;
    if (D.testNotice) { $("#notice").hidden = false; $("#notice").innerHTML = `<div class="note">${esc(D.testNotice)}</div>`; }
    ED?.init(D.editing);
    bind();
    openLinkedMeeting();
    render();
    scrollToAnchor();
    loadPrices();
    if (typeof setInterval === "function") setInterval(loadPrices, 5 * 60 * 1000);
    // Live sheet (live.mjs): start it with the built data; it answers with the data recomputed from the sheet.
    window.__dashBase = D;
    window.addEventListener("dash:data", (e) => {
      D = e.detail.D; liveAt = e.detail.at;
      setStamp();
      // Never redraw under an open form (it would lose what is being typed) or a video that may be
      // playing (it would restart); the next redraw shows the new data. A player opened by a link and
      // not touched yet only shows its cover, so it is redrawn (e.g. to show the minutes that just came in).
      if (!anyFormOpen() && !(ui.openVideo && (ui.autoplay !== false || playerTouched))) render();
    });
    // Clicking into the player moves the focus into its frame, which takes it from this window.
    window.addEventListener("blur", () => { if (document.activeElement?.tagName === "IFRAME") playerTouched = true; });
    window.dispatchEvent(new CustomEvent("dash:ready"));
  }

  // Header stamp: when the chain data was read, and when the sheet was last read live.
  let liveAt = null;
  function setStamp() {
    const t = (d) => new Date(d).toISOString().slice(0, 16).replace("T", " ");
    $("#stamp").innerHTML = `Data as of ${esc(t(D.dataAt))} UTC${liveAt ? ` · sheet live ${esc(t(liveAt).slice(11))} UTC` : ""}`;
  }
  let playerTouched = false;
  const anyFormOpen = () => Boolean(ed.wallet || ed.labelFor || ed.docFor || ed.pip || ed.member || ed.clearFor || ed.minutes);
  // After a save: read the sheet again right away, so the change shows within seconds.
  const liveRefresh = () => window.DashLive?.refresh?.();

  boot();
})();
