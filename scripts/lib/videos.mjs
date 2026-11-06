// The Council's videos as the dashboard shows them: meetings (with their Council term, minutes and the
// PIPs they name) and other videos. Pure: used by the build and by the page's live calculation.

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];


// The meeting's own date from its title ("... - October 27, 2026"), else the upload day.
function meetingDay(v) {
  const m = String(v.title ?? "").match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const mo = m ? MONTHS.indexOf(m[1].toLowerCase()) : -1;
  if (mo >= 0) return `${m[3]}-${String(mo + 1).padStart(2, "0")}-${String(m[2]).padStart(2, "0")}`;
  return String(v.published ?? "").slice(0, 10);
}

// PIPs named explicitly ("PIP-36", "PIP 36", "PIP #36"); wording alone is never matched.
export function pipsNamed(text) {
  return [...new Set([...String(text ?? "").matchAll(/\bPIP[\s-]*#?\s*(\d{1,3})\b/gi)].map((m) => Number(m[1])))].sort((a, b) => a - b);
}

export function councilVideos({ store = { videos: {} }, terms = [], channelUrl = null, minutes = [] }) {
  const starts = terms.filter((t) => t.start).map((t) => ({ label: t.label, start: t.start })).sort((a, b) => a.start.localeCompare(b.start));
  const meetings = [], other = [];
  for (const v of Object.values(store.videos ?? {})) {
    const day = meetingDay(v);
    const item = {
      id: v.id, title: v.title, day, published: v.published, views: v.views ?? null, viewsAt: v.viewsAt ?? null,
      url: `https://www.youtube.com/watch?v=${encodeURIComponent(v.id)}`,
    };
    // A meeting: the title says so or names a Council term ("Term #4", "CT-4"), or the description
    // calls it a meeting recording or a session. What was discussed comes from the minutes (below).
    if (/meeting|\bCT-?\d|\bterm\s*#?\d/i.test(v.title ?? "") || /recording of the (weekly )?meeting|council is in session/i.test(v.description ?? "")) {
      meetings.push({ ...item, term: starts.filter((t) => t.start <= day).pop()?.label ?? null, pips: pipsNamed(v.title), minutes: null });
    } else {
      other.push({ ...item, summary: String(v.description ?? "").split(/\n\s*\n/)[0].trim() });
    }
  }
  // Minutes from the sheet's "Meeting minutes" tab: attached to the recording of the same day, or
  // listed as a meeting of their own when there is no recording. PIPs they name count as discussed.
  for (const mn of minutes) {
    const v = meetings.find((m) => m.day === mn.day && !m.minutes);
    if (v) {
      v.minutes = mn.text;
      v.pips = [...new Set([...v.pips, ...pipsNamed(mn.text)])].sort((a, b) => a - b);
      continue;
    }
    meetings.push({
      id: `minutes-${mn.day}`, title: mn.title || "Council meeting", day: mn.day, published: null, views: null, viewsAt: null, url: null,
      term: starts.filter((t) => t.start <= mn.day).pop()?.label ?? null, pips: pipsNamed(`${mn.title}\n${mn.text}`), minutes: mn.text, noRecording: true,
    });
  }
  meetings.sort((a, b) => b.day.localeCompare(a.day));
  other.sort((a, b) => String(b.published).localeCompare(String(a.published)));

  // Meetings per month, by term (the same shape as the other Council activity charts).
  const byMonth = new Map();
  for (const m of meetings) {
    if (!m.term) continue;
    const c = byMonth.get(m.day.slice(0, 7)) ?? {};
    c[m.term] = (c[m.term] ?? 0) + 1;
    byMonth.set(m.day.slice(0, 7), c);
  }
  const keys = [...byMonth.keys()].sort();
  const months = [];
  if (keys.length) {
    for (let [y, mo] = keys[0].split("-").map(Number); `${y}-${String(mo).padStart(2, "0")}` <= keys.at(-1); mo === 12 ? (y++, mo = 1) : mo++) {
      const k = `${y}-${String(mo).padStart(2, "0")}`;
      months.push({ month: k, counts: byMonth.get(k) ?? {} });
    }
  }
  return {
    channelUrl, updatedAt: store.updatedAt ?? null, meetings, other,
    perMonth: { terms: starts.map((t) => t.label).filter((l) => months.some((m) => m.counts[l])), months },
  };
}
