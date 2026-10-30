// Star Atlas governance API (public). Proposal list + per-proposal votes.
// Votes of closed proposals never change, so they are cached in data/votes/.
import { fetchJSON, readJSON, writeJSON, log, warn } from "./util.mjs";

const BUCKETS = [
  { key: "small", label: "< 10,000 PVP", max: 1e4 },
  { key: "mid", label: "10,000 – 1M PVP", max: 1e6 },
  { key: "large", label: "≥ 1M PVP", max: Infinity },
];

function outcome(status) {
  if (/Passes/i.test(status)) return "passed";
  if (/Fail/i.test(status)) return "failed";
  if (/Voting_Open|Open_Voting/i.test(status)) return "open";
  return "other";
}

// Ranked (STV) elections: the API keys vote totals by the full ballot order ("a,b,c"),
// so one election can have hundreds of keys. Collapse them to first preferences per candidate.
// Seats are allocated by STV; first preferences are shown as such, not as the result.
function collapseRanked(entries) {
  const byFirst = new Map();
  for (const e of entries) {
    const first = e.option.split(",")[0];
    const o = byFirst.get(first) ?? { option: first, count: 0, pvp: 0 };
    o.count += e.count; o.pvp += e.pvp;
    byFirst.set(first, o);
  }
  return [...byFirst.values()].sort((a, b) => b.pvp - a.pvp);
}

export async function fetchProposals(api) {
  const list = await fetchJSON(`${api}/proposals`);
  const out = [];
  for (const p of list) {
    const raw = Object.entries(p.voteData ?? {}).map(([option, v]) => ({
      option,
      count: Number(v.count) || 0,
      pvp: Number(v.pvp) || 0,
    }));
    const ranked = (p.voteOptionsMaxChoices ?? 1) > 1 || raw.some((o) => o.option.includes(","));
    const options = ranked ? collapseRanked(raw) : raw;
    let candidates = null, officialWinners = null;
    if (ranked) {
      // Candidate display names and, where published, the official result come from the detail endpoint.
      try {
        const d = await fetchJSON(`${api}/proposals/${p.id}`);
        candidates = (d.voteOptions ?? []).map((c) => ({ value: c.value, display: c.displayValue ?? c.value, image: c.image ?? null }));
        for (const c of candidates) if (!options.some((o) => o.option === c.value)) options.push({ option: c.value, count: 0, pvp: 0 });
        // electionResults is a JSON string like {"winners":[...],"tieCount":0}; null when not published.
        try {
          const er = typeof d.electionResults === "string" ? JSON.parse(d.electionResults) : d.electionResults;
          if (Array.isArray(er?.winners) && er.winners.length) officialWinners = er.winners;
        } catch { /* unparseable result: treat as unpublished */ }
      } catch (e) {
        warn(`candidates for PIP-${p.pipNumber} unavailable: ${e.message}`);
      }
    }
    out.push({
      pip: p.pipNumber,
      id: p.id,
      title: p.title,
      categories: p.categories ?? [],
      status: p.status,
      outcome: outcome(p.status),
      createdAt: p.createdAt,
      votingStartsAt: p.votingStartsAt,
      votingEndsAt: p.votingEndsAt,
      maxChoices: p.voteOptionsMaxChoices ?? 1,
      winners: p.voteWinners ?? 1,
      ranked,
      distinctBallots: ranked ? raw.length : null,
      candidates,
      officialWinners,
      // Elections state their term in the brief, e.g. "(October 11, 2026 - July 11, 2027)".
      brief: ranked ? p.brief ?? "" : undefined,
      options,
      totalVotes: options.reduce((s, o) => s + o.count, 0),
      totalPvp: options.reduce((s, o) => s + o.pvp, 0),
    });
  }
  return out.sort((a, b) => a.pip - b.pip);
}

// Per-proposal vote detail: per-voter rows plus size buckets and a daily timeline.
export async function fetchVotes(api, proposal, now = Date.now()) {
  const cacheRel = `data/votes/${proposal.pip}.json`;
  const closed = proposal.votingEndsAt && Date.parse(proposal.votingEndsAt) < now - 6 * 3600e3;
  const cached = readJSON(cacheRel, null);
  if (cached && closed && cached.complete) return cached;

  let raw;
  try {
    raw = await fetchJSON(`${api}/proposals/votes/${proposal.id}.json`);
  } catch (e) {
    warn(`votes for PIP-${proposal.pip} unavailable: ${e.message}`);
    return cached ?? null;
  }

  const ranked = proposal.maxChoices > 1 || raw.some((v) => String(v.voteResult).includes(","));
  const votes = raw
    .map((v) => {
      const choice = String(v.voteResult ?? "").toLowerCase();
      return {
        t: Math.floor(Date.parse(v.createdAt) / 1000),
        wallet: v.walletPublicKey,
        choice,
        first: ranked ? choice.split(",")[0] : choice,
        pvp: Number(v.votingPower) || 0,
        lockedUntil: Number((String(v.message).match(/locked until (\d+)/) || [])[1]) || null,
        polis: Number((String(v.message).match(/with ([\d.]+) POLIS locked/) || [])[1]) || null,
      };
    })
    .filter((v) => Number.isFinite(v.t))
    .sort((a, b) => a.t - b.t);

  // Size buckets by first choice.
  const buckets = BUCKETS.map((b) => ({ key: b.key, label: b.label, byOption: {} }));
  for (const v of votes) {
    const b = buckets[v.pvp < 1e4 ? 0 : v.pvp < 1e6 ? 1 : 2];
    const o = (b.byOption[v.first] ??= { count: 0, pvp: 0 });
    o.count++; o.pvp += v.pvp;
  }

  // Daily timeline: votes and PVP per option, plus running totals.
  const days = new Map();
  for (const v of votes) {
    const day = new Date(v.t * 1000).toISOString().slice(0, 10);
    const d = days.get(day) ?? { day, byOption: {} };
    const o = (d.byOption[v.first] ??= { count: 0, pvp: 0 });
    o.count++; o.pvp += v.pvp;
    days.set(day, d);
  }
  let accCount = 0, accPvp = 0;
  const timeline = [...days.values()].map((d) => {
    for (const o of Object.values(d.byOption)) { accCount += o.count; accPvp += o.pvp; }
    return { ...d, accCount, accPvp };
  });

  const detail = { pip: proposal.pip, ranked, votes, buckets, timeline, complete: Boolean(closed), fetchedAt: new Date(now).toISOString() };
  writeJSON(cacheRel, detail, false);
  return detail;
}

export async function loadGovernance(api) {
  const proposals = await fetchProposals(api);
  log(`governance: ${proposals.length} proposals`);
  const votes = {};
  for (const p of proposals) {
    const v = await fetchVotes(api, p);
    if (v) votes[p.pip] = v;
  }
  log(`governance: vote detail for ${Object.keys(votes).length} proposals`);
  return { proposals, votes };
}
