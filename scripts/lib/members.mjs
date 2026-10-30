// Council terms (current, incoming, and past) shown on the site.
//
// Source 1 (preferred): the Council's "Council members" sheet tab, one row per member and term.
// Source 2 (until that tab exists):
//   a) data/council_history.json, a sourced record of terms whose results the API does not publish;
//   b) elections newer than that record, added automatically when the governance API publishes an
//      official result, or when the election was uncontested (no more candidates than seats).
// Contested elections without a published result are listed as "result not published" rather
// than guessed: seats are decided by single transferable vote, which this site does not recount.
const TERM_RE = /\(([A-Z][a-z]+ \d{1,2}, \d{4})\s*[-–]\s*([A-Z][a-z]+ \d{1,2}, \d{4})\)/;
const iso = (s) => { const t = Date.parse(s + " UTC"); return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null; };
const safeImg = (u) => (u && /^https:\/\//i.test(u) ? u : null);
const isCouncilElection = (p) => /council election/i.test(p.title) && !/first round/i.test(p.title);

export function councilTerms({ sheetMembers = [], proposals = [], history = { terms: [] } }) {
  const warnings = [];

  if (sheetMembers.length) {
    const groups = new Map();
    for (const m of sheetMembers) {
      const no = (String(m.term ?? "").match(/^\s*(?:term\s*)?(\d+)\s*$/i) || [])[1];
      const key = no ? `Term ${Number(no)}` : m.term || `${m.start ?? ""}/${m.end ?? ""}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const terms = [...groups.entries()].map(([key, list]) => ({
      term: Number((String(key).match(/\d+/) || [])[0]) || null,
      label: /^Term \d+$/.test(key) ? key : list[0].term || "Council",
      electedIn: list.find((m) => m.electedIn)?.electedIn ?? null,
      start: list.find((m) => m.start)?.start ?? null, end: list.find((m) => m.end)?.end ?? null,
      source: "Council members tab of the Council's sheet", sourceUrl: null,
      members: list.map(({ name, role, image, x, discord, wallet }) => ({ name, role, image, x, discord, wallet })),
    }));
    return { source: "sheet", note: "Maintained by the Council in the sheet's Council members tab.", terms: sortTerms(terms), warnings };
  }

  const byPip = new Map(proposals.map((p) => [p.pip, p]));
  const terms = [];

  // a) recorded terms
  for (const t of history.terms ?? []) {
    const e = byPip.get(t.electedIn);
    const cand = new Map((e?.candidates ?? []).map((c) => [c.value, c]));
    const members = t.members.map((m) => {
      const c = cand.get(m.candidate);
      if (!c) warnings.push(`Council Term ${t.term}: "${m.candidate}" is not a candidate in PIP-${t.electedIn}. Check data/council_history.json.`);
      return { name: m.name ?? c?.display ?? m.candidate, role: m.role ?? "Council member", image: safeImg(m.image ?? c?.image), x: m.x ?? null, discord: m.discord ?? null, wallet: m.wallet ?? null };
    });
    // The record must agree with an official result wherever the API publishes one.
    if (e?.officialWinners) {
      const rec = new Set(t.members.map((m) => m.candidate)), off = new Set(e.officialWinners);
      const same = rec.size === off.size && [...rec].every((x) => off.has(x));
      if (!same) warnings.push(`Council Term ${t.term}: the recorded members differ from the official PIP-${t.electedIn} result (${e.officialWinners.join(", ")}).`);
    }
    terms.push({ term: t.term, label: `Term ${t.term}`, electedIn: t.electedIn, start: t.start, end: t.end, source: t.source, sourceUrl: t.sourceUrl ?? null, members });
  }

  // b) newer elections, derived only when the result is certain
  const lastRecorded = Math.max(0, ...(history.terms ?? []).map((t) => t.electedIn));
  for (const e of proposals.filter((p) => isCouncilElection(p) && p.pip > lastRecorded).sort((a, b) => a.pip - b.pip)) {
    const m = String(e.brief ?? "").match(TERM_RE);
    const termNo = Number((e.title.match(/#\s*(\d+)/) || [])[1]) || null;
    const cand = new Map((e.candidates ?? []).map((c) => [c.value, c]));
    let winners = null, source = null;
    if (e.officialWinners) { winners = e.officialWinners; source = `Official result in the governance API (PIP-${e.pip})`; }
    else if (e.candidates?.length && e.candidates.length <= (e.winners ?? 0)) { winners = e.candidates.map((c) => c.value); source = `PIP-${e.pip}: no more candidates than seats, so all ${winners.length} were elected`; }
    terms.push({
      term: termNo, label: termNo ? `Term ${termNo}` : e.title, electedIn: e.pip,
      start: m ? iso(m[1]) : null, end: m ? iso(m[2]) : null,
      source: source ?? `PIP-${e.pip}: result not published yet`, sourceUrl: null, pending: !winners,
      members: (winners ?? []).map((w) => { const c = cand.get(w); return { name: c?.display ?? w, role: "Council member", image: safeImg(c?.image), x: null, discord: null, wallet: null }; }),
    });
  }

  return {
    source: "record",
    note: "Add a Council members tab to the sheet to manage this list; until then it comes from the sourced record and published election results.",
    terms: sortTerms(terms),
    warnings,
  };
}

const sortTerms = (terms) => terms.sort((a, b) => String(b.start ?? "").localeCompare(String(a.start ?? "")) || (b.term ?? 0) - (a.term ?? 0));
