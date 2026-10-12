// Virginia minimum wage projection engine.
// Shared by the Node build (scripts/build.mjs) and the browser (inlined into the page).
//
// Statute (Va. Code § 40.1-28.10(F)): by October 1 each year the Commissioner sets the
// next January's rate = current rate × (1 + increase in U.S. city average CPI-U "during
// the most recent calendar year"), never less than zero. DOLI has applied this as the
// December-to-December change, so the wage effective Jan 1 of year Y uses CPI year Y−2.

export const END_YEAR = 2070;
export const HOURS_PER_YEAR = 2080;

// Round to cents, half up, without float noise (15 × 1.023 = 15.344999… → 15.35).
export const roundCents = v => Math.round(Math.round(v * 1e6) / 1e4) / 100;

const key = (y, m) => `${y}-${String(m).padStart(2, "0")}`;

// Latest month (1–12) with data for year y in a monthly series, or 0.
function lastMonth(series, y) {
  for (let m = 12; m >= 1; m--) if (series[key(y, m)] != null) return m;
  return 0;
}

// Rate assumption (decimal) for CPI calendar year y under a scenario.
function assumedRate(assumptions, scenario, y) {
  if (scenario.custom) {
    return (y <= scenario.custom.firstYear ? scenario.custom.near : scenario.custom.longRun) / 100;
  }
  const s = assumptions.scenarios[scenario.name] || { offset: 0 };
  const byYear = assumptions.byYear[String(y)];
  if (byYear != null) return Math.max(0, byYear + (s.offset || 0)) / 100;
  return (s.longRun != null ? s.longRun : assumptions.longRun) / 100;
}

// December-to-December CPI-U change for calendar year y.
// status: "actual" (both Decembers published), "partial" (some months of y observed,
// remainder projected at the assumed rate), or "assumed".
export function cpiChange(cpi, assumptions, scenario, y) {
  const nsa = cpi.nsa || {}, sa = cpi.sa || {};
  const decNow = nsa[key(y, 12)], decPrev = nsa[key(y - 1, 12)];
  if (decNow != null && decPrev != null) {
    return { value: decNow / decPrev - 1, status: "actual", months: 12 };
  }
  const r = assumedRate(assumptions, scenario, y);
  if (scenario.custom && y === scenario.custom.firstYear) return { value: r, status: "assumed", months: 0 };
  const m = lastMonth(sa, y);
  const saBase = sa[key(y - 1, 12)];
  if (m > 0 && saBase != null) {
    const v = (sa[key(y, m)] / saBase) * Math.pow(1 + r, (12 - m) / 12) - 1;
    return { value: v, status: "partial", months: m };
  }
  return { value: r, status: "assumed", months: 0 };
}

// Statutory/announced rate in effect on Jan 1 of year y (if fixed), else null.
function fixedRate(law, y) {
  const iso = `${y}-01-01`;
  let hit = null;
  for (const s of law.schedule) if (s.effective <= iso) hit = s;
  const exact = law.schedule.find(s => s.effective.slice(0, 4) === String(y));
  if (y < law.indexing.firstYear || exact) return exact || hit;
  return null;
}

// Project every year from startYear to END_YEAR.
// basis: "statute" | "announced" | "calculated" (CPI known, DOLI not yet announced) | "forecast"
export function project({ law, cpi, assumptions }, scenario = { name: "base" }, startYear = 2026) {
  const rows = [];
  const fed = law.federalMinimum || 7.25;
  let prev = null;
  for (let y = startYear; y <= END_YEAR; y++) {
    const fixed = fixedRate(law, y);
    let row;
    if (fixed) {
      row = { year: y, wage: fixed.wage, basis: fixed.basis, note: fixed.note || "", cpiYear: null };
    } else {
      const cpiYear = y - (law.indexing.lagYears || 2);
      const c = cpiChange(cpi, assumptions, scenario, cpiYear);
      const pct = Math.max(0, c.value);
      const wage = Math.max(fed, roundCents(prev * (1 + pct)));
      row = {
        year: y, wage, cpiYear, cpiPct: c.value * 100, cpiStatus: c.status, cpiMonths: c.months,
        basis: c.status === "actual" ? "calculated" : "forecast",
        note: c.status === "actual" ? `CPI ${cpiYear} final; awaiting DOLI` : ""
      };
    }
    row.change = prev ? row.wage / prev - 1 : null;
    row.annual = row.wage * HOURS_PER_YEAR;
    rows.push(row);
    prev = row.wage;
  }
  // Value in first-year dollars: deflate by Dec-to-Dec CPI from startYear onward.
  let price = 1;
  for (const r of rows) {
    if (r.year > startYear) price *= 1 + cpiChange(cpi, assumptions, scenario, r.year - 1).value;
    r.real = r.wage / price;
  }
  return rows;
}

// First year whose rate is not fixed by statute or announcement.
export function firstOpenYear(law) {
  for (let y = law.indexing.firstYear; y <= END_YEAR; y++) if (!fixedRate(law, y)) return y;
  return END_YEAR;
}

// Rate in effect on an ISO date, plus the next scheduled change (fixed or projected).
export function rateOn(law, rows, iso) {
  let cur = null, next = null;
  for (const s of law.schedule) { if (s.effective <= iso) cur = s; else if (!next) next = s; }
  const curRow = rows.find(r => `${r.year}-01-01` <= iso && r.year === Number(iso.slice(0, 4)));
  if (curRow && (!cur || `${curRow.year}-01-01` > cur.effective)) cur = { effective: `${curRow.year}-01-01`, wage: curRow.wage, basis: curRow.basis };
  if (!next) {
    const nr = rows.find(r => `${r.year}-01-01` > iso);
    if (nr) next = { effective: `${nr.year}-01-01`, wage: nr.wage, basis: nr.basis };
  }
  return { current: cur, next };
}
