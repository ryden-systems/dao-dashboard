// Small SVG chart helpers (line + bar). No dependencies.
// Usage: put Charts.line(spec) / Charts.bar(spec) markup into the page, then call Charts.mount().
// Charts are drawn at the container's real pixel width and redrawn on resize.
window.Charts = (() => {
  const specs = new Map();
  let nextId = 1;

  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  function niceStep(range, count) {
    const raw = range / Math.max(1, count);
    const mag = 10 ** Math.floor(Math.log10(raw || 1));
    const f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function ticks(min, max, count = 4) {
    if (min === max) { max = min + 1; }
    const step = niceStep(max - min, count);
    const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
    const out = [];
    for (let v = lo; v <= hi + step / 2; v += step) out.push(Math.round(v / step) * step);
    return out;
  }

  function line(spec) { const id = nextId++; specs.set(id, { kind: "line", ...spec }); return `<div class="chart" data-cid="${id}"></div>`; }
  function bar(spec) { const id = nextId++; specs.set(id, { kind: "bar", ...spec }); return `<div class="chart" data-cid="${id}"></div>`; }

  function legend(series) {
    return `<div class="legend">${series.map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join("")}</div>`;
  }

  function drawLine(el, s) {
    const W = Math.max(280, el.clientWidth), H = s.height ?? 220;
    const m = { t: 10, r: 14, b: 26, l: s.yWidth ?? 64 };
    const all = s.series.flatMap((x) => x.points.filter((p) => p[1] != null));
    if (!all.length) { el.innerHTML = `<p class="muted">No data yet.</p>`; return; }
    const tx = (d) => Date.parse(d + "T00:00:00Z");
    const xs = all.map((p) => tx(p[0])), ys = all.map((p) => p[1]);
    const x0 = Math.min(...xs), x1 = Math.max(...xs);
    const yt = ticks(s.zeroBase === false ? Math.min(...ys) : Math.min(0, ...ys), Math.max(...ys), 4);
    const y0 = yt[0], y1 = yt[yt.length - 1];
    const X = (t) => m.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - m.l - m.r);
    const Y = (v) => H - m.b - ((v - y0) / Math.max(1e-9, y1 - y0)) * (H - m.t - m.b);
    const fy = s.yFmt ?? ((v) => v.toLocaleString("en-US"));

    let g = `<g class="grid">${yt.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("")}</g>`;
    g += `<g class="axis">${yt.map((v) => `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${esc(fy(v))}</text>`).join("")}`;
    // x labels: ~5 evenly spaced dates
    const n = Math.min(5, Math.max(2, Math.floor((W - m.l - m.r) / 120)));
    for (let i = 0; i <= n; i++) {
      const t = x0 + ((x1 - x0) * i) / n;
      const d = new Date(t).toISOString().slice(0, 7);
      g += `<text x="${X(t)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n ? "end" : "middle"}">${d}</text>`;
    }
    g += `</g><line class="base" x1="${m.l}" x2="${W - m.r}" y1="${Y(y0)}" y2="${Y(y0)}"/>`;

    s.series.forEach((ser, i) => {
      const pts = ser.points.filter((p) => p[1] != null).map((p) => [X(tx(p[0])), Y(p[1])]);
      if (!pts.length) return;
      const d = pts.map((p, j) => `${j ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      if (i === 0 && s.area !== false) {
        g += `<path d="${d}L${pts[pts.length - 1][0].toFixed(1)},${Y(y0)}L${pts[0][0].toFixed(1)},${Y(y0)}Z" style="fill:${ser.color};opacity:.10"/>`;
      }
      g += `<path d="${d}" style="fill:none;stroke:${ser.color};stroke-width:2;stroke-linejoin:round"/>`;
      const last = pts[pts.length - 1];
      g += `<circle cx="${last[0]}" cy="${last[1]}" r="3.5" style="fill:${ser.color}"/>`;
    });
    g += `<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" style="stroke:var(--line-strong);display:none"/>`;
    g += `<rect class="hit" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" style="fill:transparent"/>`;

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(s.label ?? "chart")}">${g}</svg>${s.series.length > 1 || s.legend ? legend(s.series) : ""}`;

    // Hover: nearest date across series.
    const svg = el.querySelector("svg"), cross = svg.querySelector(".cross"), tip = document.getElementById("tip");
    const dates = [...new Set(all.map((p) => p[0]))].sort();
    svg.querySelector(".hit").addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      let best = dates[0], bd = Infinity;
      for (const d of dates) { const dx = Math.abs(X(tx(d)) - px); if (dx < bd) { bd = dx; best = d; } }
      cross.setAttribute("x1", X(tx(best))); cross.setAttribute("x2", X(tx(best))); cross.style.display = "";
      const rows = s.series.map((ser) => {
        const p = ser.points.find((q) => q[0] === best);
        return p && p[1] != null ? `<div><span style="color:${ser.color}">■</span> ${esc(ser.name)}: ${esc(fy(p[1]))}</div>` : "";
      }).join("");
      tip.innerHTML = `<div>${best}</div>${rows}`;
      tip.hidden = false;
      tip.style.left = Math.min(window.innerWidth - 290, ev.clientX + 14) + "px";
      tip.style.top = ev.clientY + 14 + "px";
    });
    svg.querySelector(".hit").addEventListener("mouseleave", () => { cross.style.display = "none"; tip.hidden = true; });
  }

  function drawBar(el, s) {
    const W = Math.max(280, el.clientWidth), H = s.height ?? 220;
    const m = { t: 10, r: 10, b: 30, l: s.yWidth ?? 56 };
    const cats = s.categories;
    if (!cats.length) { el.innerHTML = `<p class="muted">No data yet.</p>`; return; }
    const totals = cats.map((_, i) => s.stacked ? s.series.reduce((a, ser) => a + (ser.values[i] || 0), 0) : Math.max(...s.series.map((ser) => ser.values[i] || 0)));
    const yt = ticks(0, Math.max(1, ...totals), 4);
    const y1 = yt[yt.length - 1];
    const Y = (v) => H - m.b - (v / y1) * (H - m.t - m.b);
    const fy = s.yFmt ?? ((v) => v.toLocaleString("en-US"));
    const band = (W - m.l - m.r) / cats.length;
    const groupW = Math.min(46, band * 0.72);
    const per = s.stacked ? groupW : groupW / s.series.length;

    let g = `<g class="grid">${yt.map((v) => `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}"/>`).join("")}</g>`;
    g += `<g class="axis">${yt.map((v) => `<text x="${m.l - 8}" y="${Y(v) + 4}" text-anchor="end">${esc(fy(v))}</text>`).join("")}`;
    const every = Math.ceil(cats.length / Math.max(1, Math.floor((W - m.l - m.r) / 54)));
    cats.forEach((c, i) => { if (i % every === 0) g += `<text x="${m.l + band * i + band / 2}" y="${H - 10}" text-anchor="middle">${esc(c)}</text>`; });
    g += `</g><line class="base" x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}"/>`;

    cats.forEach((c, i) => {
      let acc = 0;
      const gx = m.l + band * i + (band - groupW) / 2;
      s.series.forEach((ser, k) => {
        const v = ser.values[i] || 0;
        if (!v) return;
        const x = s.stacked ? gx : gx + per * k;
        const yTop = s.stacked ? Y(acc + v) : Y(v);
        const yBot = s.stacked ? Y(acc) : Y(0);
        g += `<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${Math.max(1, per - (s.stacked ? 0 : 2)).toFixed(1)}" height="${Math.max(0.5, yBot - yTop).toFixed(1)}" rx="2" style="fill:${ser.color}"/>`;
        acc += v;
      });
      g += `<rect class="hitb" data-i="${i}" x="${m.l + band * i}" y="${m.t}" width="${band}" height="${H - m.t - m.b}" style="fill:transparent"/>`;
    });

    el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(s.label ?? "chart")}">${g}</svg>${s.series.length > 1 || s.legend ? legend(s.series) : ""}`;
    const tip = document.getElementById("tip");
    el.querySelectorAll(".hitb").forEach((r) => {
      r.addEventListener("mousemove", (ev) => {
        const i = Number(r.dataset.i);
        const rows = s.series.map((ser) => (ser.values[i] ? `<div><span style="color:${ser.color}">■</span> ${esc(ser.name)}: ${esc(fy(ser.values[i]))}</div>` : "")).join("");
        tip.innerHTML = `<div>${esc(cats[i])}</div>${rows || "<div>—</div>"}`;
        tip.hidden = false;
        tip.style.left = Math.min(window.innerWidth - 290, ev.clientX + 14) + "px";
        tip.style.top = ev.clientY + 14 + "px";
      });
      r.addEventListener("mouseleave", () => { tip.hidden = true; });
    });
  }

  function mount(root = document) {
    root.querySelectorAll(".chart[data-cid]").forEach((el) => {
      const s = specs.get(Number(el.dataset.cid));
      if (!s) return;
      (s.kind === "line" ? drawLine : drawBar)(el, s);
    });
  }

  let rt;
  window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => mount(), 150); });

  return { line, bar, mount, reset: () => specs.clear() };
})();
