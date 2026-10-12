(function () {
  const S = window.SITE;
  const data = { law: S.law, cpi: S.cpi, assumptions: S.assumptions };
  const END = Engine.END_YEAR;
  const $ = id => document.getElementById(id);
  const fmt = v => "$" + v.toFixed(2);
  const fmtK = v => "$" + Math.round(v).toLocaleString("en-US");
  const long = d => new Date(d + "T12:00:00").toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const pad = n => String(n).padStart(2, "0");
  const now = new Date();
  const todayIso = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const thisYear = now.getFullYear();
  const firstOpen = Engine.firstOpenYear(S.law);
  const firstCpiYear = firstOpen - (S.law.indexing.lagYears || 2);
  const baseRows = Engine.project(data, { name: "base" }, 2026);
  const baseFirst = baseRows.find(r => r.year === firstCpiYear + 2);
  const baseNear = Math.round(baseFirst.cpiPct * 10) / 10;
  const LABEL = { statute: "Law", federal: "Law", announced: "DOLI", calculated: "Calculated", forecast: "Forecast" };
  const isFixed = b => b === "statute" || b === "federal" || b === "announced";

  const state = { scen: "base", near: baseNear, lr: S.assumptions.longRun };
  try {
    const saved = JSON.parse(localStorage.getItem("vaWage.v2") || "null");
    if (saved && saved.built === S.built && typeof saved.near === "number") Object.assign(state, saved.state);
  } catch (e) {}

  function scenarioOf(st) {
    if (st.scen) return { name: st.scen };
    return { custom: { firstYear: firstCpiYear, near: st.near, longRun: st.lr } };
  }

  // Today and next step (date-aware, so the page stays right between rebuilds)
  function renderToday() {
    const { current, next } = Engine.rateOn(S.law, baseRows, todayIso);
    if (current) {
      $("nowWage").textContent = fmt(current.wage);
      $("nowSub").textContent = "per hour since " + long(current.effective);
    }
    if (next) {
      const days = Math.ceil((new Date(next.effective + "T00:00:00") - now) / 864e5);
      $("nextWage").textContent = fmt(next.wage);
      const est = isFixed(next.basis) ? "" : " · estimate";
      $("nextSub").textContent = long(next.effective) + " · in " + days.toLocaleString("en-US") + " day" + (days === 1 ? "" : "s") + " (+" + ((next.wage / current.wage - 1) * 100).toFixed(1) + "%)" + est;
    }
    // Steps strip
    const steps = S.law.schedule.filter(s => s.effective >= "2021-01-01");
    const curEff = current && current.effective;
    const html = steps.map(h => {
      const isCur = h.effective === curEff, fut = h.effective > todayIso;
      const d = h.effective.endsWith("-01-01") ? "Jan 1, " + h.effective.slice(0, 4) : long(h.effective).replace(/^(\w{3})\w*/, "$1");
      const pill = isCur ? '<span class="pill now">Now</span>' : fut ? '<span class="pill law">Enacted</span>' : "";
      return `<div class="step ${isCur ? "current" : ""} ${fut ? "future" : ""}"><span class="d">${d}</span><span class="w num">${fmt(h.wage)}</span><span class="n">${h.note || ""}</span>${pill}</div>`;
    });
    html.push(`<div class="step fc"><span class="d">Jan 1, ${firstOpen}</span><span class="w num" id="stripFirst">${fmt(baseFirst.wage)}</span><span class="n" id="stripFirstNote">CPI ${firstCpiYear}</span><span class="pill fc">Forecast</span></div>`);
    $("steps").innerHTML = html.join("");
    const cur = $("steps").querySelector(".current");
    if (cur && $("steps").scrollWidth > $("steps").clientWidth) $("steps").scrollLeft = cur.offsetLeft - 16;
  }

  // Chart
  const M = { l: 44, r: 58, t: 16, b: 34 };
  let W = 960, H = 400, yMax = 60;
  const X0 = 2009, X1 = END;
  const xs = y => M.l + (y - X0) / (X1 - X0) * (W - M.l - M.r);
  const ys = v => H - M.b - v / yMax * (H - M.t - M.b);
  const svg = $("chart");
  const NS = "http://www.w3.org/2000/svg";
  const el = (tag, attrs, text) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (text != null) e.textContent = text; svg.appendChild(e); return e; };
  const dec = d => { const [Y, Mo, D] = d.split("-").map(Number); return Y + (Mo - 1) / 12 + (D - 1) / 365; };
  const history = S.law.schedule;

  function lawPath(rows) {
    let p = "";
    history.forEach((h, i) => { const x = xs(dec(h.effective)), y = ys(h.wage); p += i === 0 ? `M${x},${y}` : `H${x}V${y}`; });
    rows.filter(r => isFixed(r.basis) && `${r.year}-01-01` > history[history.length - 1].effective)
      .forEach(r => { p += `H${xs(r.year)}V${ys(r.wage)}`; });
    return p + `H${xs(firstOpen)}`;
  }
  function stepPath(rows, from) {
    const f = rows.filter(r => r.year >= from - 1);
    let p = `M${xs(from)},${ys(f[0].wage)}`;
    f.slice(1).forEach(r => { p += `V${ys(r.wage)}H${xs(r.year + 1)}`; });
    return p;
  }

  function drawChart(rows, low, high) {
    svg.innerHTML = "";
    W = Math.max(300, Math.round($("chartBox").clientWidth || 960));
    H = Math.round(Math.min(400, Math.max(250, W * 0.5)));
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    const top = Math.max(high[high.length - 1].wage, rows[rows.length - 1].wage);
    yMax = Math.max(20, Math.ceil((top * 1.08) / 10) * 10);
    const step = yMax > 60 ? 20 : 10;
    for (let v = 0; v <= yMax; v += step / 2) {
      const major = v % step === 0;
      el("line", { x1: M.l, x2: W - M.r, y1: ys(v), y2: ys(v), stroke: "var(--grid)", "stroke-width": major ? 1 : 0.5 });
      if (major) el("text", { x: M.l - 8, y: ys(v) + 4, "text-anchor": "end" }, "$" + v);
    }
    (W < 560 ? [2010, 2030, 2050, 2070] : [2010, 2020, 2030, 2040, 2050, 2060, 2070]).forEach(y => {
      el("line", { x1: xs(y), x2: xs(y), y1: H - M.b, y2: H - M.b + 5, stroke: "var(--muted)" });
      el("text", { x: xs(y), y: H - M.b + 20, "text-anchor": "middle" }, y);
    });
    el("line", { x1: M.l, x2: W - M.r, y1: H - M.b, y2: H - M.b, stroke: "var(--muted)" });
    el("rect", { x: xs(firstOpen), y: M.t, width: W - M.r - xs(firstOpen), height: H - M.t - M.b, fill: "var(--amber-soft)", opacity: 0.5 });
    el("line", { x1: xs(firstOpen), x2: xs(firstOpen), y1: M.t, y2: H - M.b, stroke: "var(--amber)", "stroke-dasharray": "3 4" });
    el("text", { x: xs(firstOpen) + 6, y: M.t + 14, fill: "var(--amber)" }, "CPI-indexed →");
    if (W >= 480) el("text", { x: xs(firstOpen) - 6, y: M.t + 14, "text-anchor": "end" }, "← set by law");
    // Band between low and high step paths
    const lo = low.filter(r => r.year >= firstOpen), hi = high.filter(r => r.year >= firstOpen);
    let band = `M${xs(firstOpen)},${ys(hi[0].wage)}`;
    hi.forEach((r, i) => { band += `H${xs(r.year + 1)}`; if (hi[i + 1]) band += `V${ys(hi[i + 1].wage)}`; });
    band += `V${ys(lo[lo.length - 1].wage)}`;
    for (let i = lo.length - 1; i >= 0; i--) { band += `H${xs(lo[i].year)}`; if (i > 0) band += `V${ys(lo[i - 1].wage)}`; }
    el("path", { d: band + "Z", fill: "var(--band)", stroke: "none" });
    el("path", { d: lawPath(rows), fill: "none", stroke: "var(--navy)", "stroke-width": 2.5, "stroke-linejoin": "round" });
    el("path", { d: stepPath(rows, firstOpen), fill: "none", stroke: "var(--amber)", "stroke-width": 2.5, "stroke-linejoin": "round" });
    const last = rows[rows.length - 1];
    el("circle", { cx: xs(END + 1), cy: ys(last.wage), r: 4, fill: "var(--amber)" });
    el("text", { x: xs(END + 1) + 6, y: ys(last.wage) + 4, fill: "var(--amber)" }, fmt(last.wage));
    const lastLaw = rows.filter(r => isFixed(r.basis)).pop();
    el("circle", { cx: xs(lastLaw.year), cy: ys(lastLaw.wage), r: 4, fill: "var(--navy)" });
    // Hover / touch
    const cross = el("line", { x1: 0, x2: 0, y1: M.t, y2: H - M.b, stroke: "var(--muted)", visibility: "hidden" });
    const dot = el("circle", { r: 5, fill: "var(--surface)", "stroke-width": 2.5, visibility: "hidden" });
    const hit = el("rect", { x: M.l, y: M.t, width: W - M.l - M.r, height: H - M.t - M.b, fill: "transparent" });
    const tip = $("tip");
    const histAt = y => { let w = history[0].wage; history.forEach(h => { if (dec(h.effective) <= y + 0.5) w = h.wage; }); return w; };
    function move(ev) {
      const rect = svg.getBoundingClientRect();
      const px = (ev.clientX - rect.left) / rect.width * W;
      let y = Math.round(X0 + (px - M.l) / (W - M.l - M.r) * (X1 - X0) - 0.5);
      y = Math.max(2010, Math.min(END, y));
      const row = rows.find(r => r.year === y);
      const wage = row ? row.wage : histAt(y);
      const fc = row && !isFixed(row.basis);
      const cx = xs(y + 0.5);
      cross.setAttribute("x1", cx); cross.setAttribute("x2", cx); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", cx); dot.setAttribute("cy", ys(wage)); dot.setAttribute("stroke", fc ? "var(--amber)" : "var(--navy)"); dot.setAttribute("visibility", "visible");
      tip.innerHTML = `<strong>${y}</strong> · ${fmt(wage)}/hr<br>${fc ? (row.basis === "calculated" ? "Calculated" : "Forecast") + ", CPI " + row.cpiYear + " +" + row.cpiPct.toFixed(1) + "%" : "Set by law"}`;
      const left = cx / W * rect.width;
      tip.style.left = Math.max(70, Math.min(rect.width - 70, left)) + "px";
      tip.style.top = (ys(wage) / H * rect.height) + "px";
      tip.hidden = false;
    }
    function leave() { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hidden = true; }
    hit.addEventListener("pointermove", move);
    hit.addEventListener("pointerdown", move);
    hit.addEventListener("pointerleave", leave);
  }

  function render() {
    const scen = scenarioOf(state);
    const rows = Engine.project(data, scen, 2026);
    const low = Engine.project(data, { name: "low" }, 2026), high = Engine.project(data, { name: "high" }, 2026);
    drawChart(rows, low, high);
    const rFirst = rows.find(r => r.year === firstOpen), r70 = rows[rows.length - 1];
    $("estFirst").textContent = fmt(rFirst.wage);
    $("stripFirst").textContent = fmt(rFirst.wage);
    $("stripFirstNote").textContent = "CPI +" + rFirst.cpiPct.toFixed(1) + "% (" + firstCpiYear + ")";
    $("est2070").textContent = fmt(r70.wage);
    const nm = state.scen ? S.assumptions.scenarios[state.scen].label + " scenario" : "Custom scenario";
    $("est2070sub").textContent = nm + " · " + fmtK(r70.annual) + " a year full-time";
    const first = t => { const r = rows.find(r => r.wage >= t); return r ? r.year : "after " + END; };
    const at = y => fmt(rows.find(r => r.year === y).wage);
    $("milestones").innerHTML = [["2040 rate", at(2040)], ["2050 rate", at(2050)], ["First year at $20+", first(20)], ["First year at $25+", first(25)], ["First year at $30+", first(30)]]
      .map(([k, v]) => `<div class="ms"><span class="k">${k}</span><span class="v num">${v}</span></div>`).join("");
    $("tbody").innerHTML = rows.map(r => {
      const fc = !isFixed(r.basis);
      const cls = [fc ? "fc" : "law", r.year % 10 === 9 ? "decade" : "", r.year === thisYear ? "thisyear" : ""].join(" ");
      const cpi = r.cpiYear ? `${r.cpiYear} · ${r.cpiPct.toFixed(1)}%${r.cpiStatus === "partial" ? "*" : ""}` : "—";
      const chg = r.change == null ? "—" : "+" + (r.change * 100).toFixed(1) + "%";
      return `<tr class="${cls}"><td>${r.year}</td><td><span class="pill ${r.basis}">${LABEL[r.basis] || r.basis}</span></td><td>${fmt(r.wage)}</td><td>${chg}</td><td class="opt">${cpi}</td><td>${fmtK(r.annual)}</td><td class="opt">${r.year >= thisYear ? fmt(r.real) : "—"}</td></tr>`;
    }).join("");
    document.querySelectorAll("#scen button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.s === state.scen)));
    if (state.scen) {
      state.near = Math.round(rFirst.cpiPct * 10) / 10;
      const lr = S.assumptions.scenarios[state.scen].longRun;
      state.lr = lr != null ? lr : S.assumptions.longRun;
    }
    $("near").value = state.near; $("nearOut").textContent = state.near.toFixed(1) + "%";
    $("lr").value = state.lr; $("lrOut").textContent = state.lr.toFixed(1) + "%";
    try { localStorage.setItem("vaWage.v2", JSON.stringify({ built: S.built, near: state.near, state })); } catch (e) {}
  }

  document.querySelectorAll("#scen button").forEach(b => b.addEventListener("click", () => { state.scen = b.dataset.s; render(); }));
  $("near").addEventListener("input", e => { state.scen = null; state.near = +e.target.value; render(); });
  $("lr").addEventListener("input", e => { state.scen = null; state.lr = +e.target.value; render(); });

  // Share
  function toast(msg) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 2200); }
  $("shareBtn").addEventListener("click", async () => {
    const payload = { title: "Virginia Wage Floor", text: S.shareText, url: S.siteUrl };
    if (navigator.share) { try { await navigator.share(payload); return; } catch (e) { if (e && e.name === "AbortError") return; } }
    try { await navigator.clipboard.writeText(S.shareText + " " + S.siteUrl); toast("Link copied"); }
    catch (e) { toast(S.siteUrl); }
  });

  renderToday();
  render();
  let rz, lastW = window.innerWidth;
  window.addEventListener("resize", () => { if (window.innerWidth === lastW) return; lastW = window.innerWidth; clearTimeout(rz); rz = setTimeout(render, 120); });
})();
