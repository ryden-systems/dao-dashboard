// PIP plans: named payment milestones ("PIP milestones" tab) and checklists ("Checklists" tab).
// Pure: used by the build and by the page's live calculation.
//
// A checklist is every item with the same PIP, checklist name and milestone. A checklist with a
// milestone is that milestone's condition (e.g. its KPIs): paying the milestone while items are
// still open is flagged. A milestone has two steps: completed (the Council signed it off: "Completed
// on" / "Completed by") and paid (a payout is linked: "Paid by (tx)", which labels that payout as the
// PIP's). Either one without the other is listed on the Data health page as a reminder.

export function pipPlans({ milestones = [], checklists = [], legs = [] }) {
  const flags = [];
  const legBySig = new Map(legs.filter((l) => l.direction === "out").map((l) => [l.sig, l]));

  const lists = new Map();
  for (const c of checklists) {
    const key = `${c.pip}|${c.list.toLowerCase()}|${c.milestone ?? ""}`;
    const l = lists.get(key) ?? { pip: c.pip, name: c.list, milestone: c.milestone ?? null, items: [], done: 0, total: 0 };
    l.items.push({ id: c.id, item: c.item, doneOn: c.doneOn, doneBy: c.doneBy, evidence: c.evidence });
    l.total++; if (c.doneOn) l.done++;
    lists.set(key, l);
  }

  const byPip = new Map();
  const entry = (pip) => byPip.get(pip) ?? byPip.set(pip, { milestones: [], checklists: [] }).get(pip);
  for (const l of lists.values()) entry(l.pip).checklists.push(l);

  const seen = new Map();
  for (const m of milestones) {
    const tied = [...lists.values()].filter((l) => l.pip === m.pip && l.milestone != null && l.milestone === m.n);
    const open = tied.reduce((s, l) => s + l.total - l.done, 0);
    const leg = m.paidBy ? legBySig.get(m.paidBy) : null;
    const completed = Boolean(m.completedOn || m.completedBy);
    entry(m.pip).milestones.push({ ...m, completed, paidAt: leg?.t ?? null, checks: tied.map((l) => ({ name: l.name, done: l.done, total: l.total })), open });
    const k = `${m.pip}|${m.n}`;
    if (m.n != null && seen.has(k)) flags.push({ severity: "warning", area: "sheet", message: `PIP milestones: PIP-${m.pip} has milestone ${m.n} twice ("${seen.get(k)}" and "${m.name}").`, pip: m.pip });
    seen.set(k, m.name);
    const what = `PIP-${m.pip}: milestone ${m.n ?? "?"} (${m.name})`;
    if ((completed || m.paidBy) && open) flags.push({ severity: "warning", area: "payments", message: `${what} ${m.paidBy ? "is paid" : "is marked completed"}, but ${tied.filter((l) => l.done < l.total).map((l) => `its checklist "${l.name}" has ${l.total - l.done} open item${l.total - l.done === 1 ? "" : "s"}`).join(" and ")}.`, pip: m.pip });
    if (completed && !m.paidBy) flags.push({ severity: "info", area: "payments", message: `${what} is completed${m.completedBy === "Tracker" ? " (per the Tracker)" : ""}, but no payout is linked: pay it, or link the payout that paid it (Mark paid).`, pip: m.pip });
    if (m.paidBy && !completed) flags.push({ severity: "info", area: "payments", message: `${what} is paid, but not marked completed.`, pip: m.pip });
    if (m.paidBy && !leg) flags.push({ severity: "info", area: "payments", message: `PIP-${m.pip}: milestone ${m.n ?? "?"} (${m.name}) is linked to a transaction that is not a payout from a DAO account (${m.paidBy.slice(0, 8)}…).`, pip: m.pip });
  }
  for (const l of lists.values()) {
    if (l.milestone != null && !milestones.some((m) => m.pip === l.pip && m.n === l.milestone)) {
      flags.push({ severity: "warning", area: "sheet", message: `Checklists: PIP-${l.pip}'s checklist "${l.name}" is for milestone ${l.milestone}, which is not in the PIP milestones tab.`, pip: l.pip });
    }
  }
  for (const v of byPip.values()) {
    v.milestones.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9));
    v.checklists.sort((a, b) => (a.milestone ?? 1e9) - (b.milestone ?? 1e9) || a.name.localeCompare(b.name));
  }

  return { byPip, flags };
}

// A payout linked to a milestone is the PIP's (a Council label on the payout still wins).
export function milestoneLabels(milestones = []) {
  return milestones.filter((m) => m.paidBy).map((m) => ({ signature: m.paidBy, recipient: "", label: `PIP-${m.pip}`, confirmed: true, fiscalYear: null }));
}
