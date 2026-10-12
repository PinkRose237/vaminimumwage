// Builds the static site into _site/ from data/*.json and src/ templates.
// Usage: node scripts/build.mjs   (BUILD_DATE=YYYY-MM-DD to override "today")
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { project, rateOn, firstOpenYear, cpiChange, END_YEAR } from "../src/engine.js";
import { ROOT, readJson, todayET, longDate, shortDate, monthName } from "./lib/util.mjs";

const OUT = path.join(ROOT, "_site");
const BUILD = path.join(ROOT, "_build");
const pkg = readJson("package.json");
const SITE_URL = pkg.homepage.endsWith("/") ? pkg.homepage : pkg.homepage + "/";
const SITE_HOST = SITE_URL.replace(/^https?:\/\//, "").replace(/\/$/, "");
const REPO_URL = pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, "");

const law = readJson("data/law.json");
const cpi = readJson("data/cpi.json");
const assumptions = readJson("data/assumptions.json");
const data = { law, cpi, assumptions };
const today = process.env.BUILD_DATE || todayET();
const thisYear = Number(today.slice(0, 4));

const base = project(data, { name: "base" }, 2026);
const low = project(data, { name: "low" }, 2026);
const high = project(data, { name: "high" }, 2026);
const row = (rows, y) => rows.find(r => r.year === y);
const firstOpen = firstOpenYear(law);
const firstCpiYear = firstOpen - (law.indexing.lagYears || 2);
const est = row(base, firstOpen);
const { current, next } = rateOn(law, base, today);
const isFixed = b => ["statute", "federal", "announced"].includes(b);
const fmt = v => "$" + v.toFixed(2);
const fmtK = v => "$" + Math.round(v).toLocaleString("en-US");
const pct = v => (Math.round(v * 10) / 10).toFixed(1) + "%";
const version = crypto.createHash("sha256").update(JSON.stringify([data, today])).digest("hex").slice(0, 10);
const latestCpi = Object.keys(cpi.nsa).sort().pop();
const cpiThrough = `${monthName(Number(latestCpi.slice(5)))} ${latestCpi.slice(0, 4)}`;
const surveyLabel = assumptions.survey.replace(/(\d{4})Q(\d)/, "Q$2 $1");

// Step after "next" (e.g. the 2028 statutory step) for the "next" card.
const after = (() => {
  if (!next) return null;
  const ny = Number(next.effective.slice(0, 4));
  const r = row(base, ny + 1);
  return r ? { label: (isFixed(r.basis) ? "Jan 1, " : "Est. Jan 1, ") + r.year, wage: r.wage, fixed: isFixed(r.basis) } : null;
})();

// Explanatory sentence for the first open year, keyed to how much CPI data exists.
const c = cpiChange(cpi, assumptions, { name: "base" }, firstCpiYear);
const range = `${fmt(row(low, firstOpen).wage)}–${fmt(row(high, firstOpen).wage)}`;
let nowcast;
if (c.status === "actual") {
  nowcast = `December ${firstCpiYear} CPI is out. CPI-U rose ${pct(c.value * 100)} during ${firstCpiYear}, which puts the ${firstOpen} rate at ${fmt(est.wage)} until DOLI announces it.`;
} else if (c.status === "partial") {
  nowcast = `CPI-U for ${firstCpiYear} is published through ${monthName(c.months)}. Extending the trend to December at the forecasters’ ${pct(assumptions.byYear[firstCpiYear] ?? assumptions.longRun)} pace gives ${pct(c.value * 100)} for the year, or about ${fmt(est.wage)}. The Low to High range is ${range}.`;
} else {
  nowcast = `No ${firstCpiYear} CPI data exists yet. The base estimate uses the Philadelphia Fed survey’s ${firstCpiYear} forecast of ${pct(c.value * 100)} (Q4 to Q4), which gives about ${fmt(est.wage)}. The Low to High range is ${range}. The first ${firstCpiYear} CPI figure comes out in mid-February ${firstCpiYear}.`;
}
const byYearText = Object.entries(assumptions.byYear).map(([y, v]) => `${y} ${v}%`).join(", ");
const baseText = `Philadelphia Fed Survey of Professional Forecasters (${surveyLabel}) median headline CPI, Q4 to Q4: ${byYearText}. After that, ${assumptions.longRun}% a year, the survey’s 10-year expectation.`;

const description = `Virginia's minimum wage is ${fmt(current.wage)}/hr` +
  (next ? `, rising to ${fmt(next.wage)} on ${longDate(next.effective)}` : "") +
  `. Inflation indexing starts in ${law.indexing.firstYear} (est. ${fmt(est.wage)} in ${firstOpen}). Forecast to ${END_YEAR}.`;
const shareText = `Virginia's minimum wage: ${fmt(current.wage)} now` + (next ? `, ${fmt(next.wage)} on ${shortDate(next.effective)}` : "") + `, about ${fmt(est.wage)} in ${firstOpen}.`;

const stepsHtml = law.schedule.filter(s => s.effective >= "2021-01-01").map(s =>
  `<div class="step"><span class="d">${shortDate(s.effective)}</span><span class="w num">${fmt(s.wage)}</span><span class="n">${s.note || ""}</span></div>`).join("") +
  `<div class="step fc"><span class="d">Jan 1, ${firstOpen}</span><span class="w num" id="stripFirst">${fmt(est.wage)}</span><span class="n" id="stripFirstNote">CPI ${firstCpiYear}</span><span class="pill fc">Forecast</span></div>`;

// Engine as a browser global (strip ES module syntax).
const engineSrc = fs.readFileSync(path.join(ROOT, "src/engine.js"), "utf8").replace(/^export /gm, "");
const engineGlobal = `const Engine = (() => {\n${engineSrc}\nreturn { project, cpiChange, roundCents, firstOpenYear, rateOn, END_YEAR, HOURS_PER_YEAR };\n})();`;

const siteData = {
  built: today, version, siteUrl: SITE_URL, shareText,
  law: { schedule: law.schedule, indexing: law.indexing, federalMinimum: law.federalMinimum },
  cpi: { nsa: cpi.nsa, sa: cpi.sa, latest: latestCpi },
  assumptions
};

const tokens = {
  SITE_URL, SITE_HOST, REPO_URL, VERSION: version,
  DESCRIPTION: description, OG_TITLE: `Virginia minimum wage: ${fmt(current.wage)} now, ${fmt(est.wage)} est. in ${firstOpen}`,
  OG_ALT: `Virginia minimum wage ${fmt(current.wage)} per hour today`,
  NOW_WAGE: fmt(current.wage), NOW_SUB: `per hour since ${longDate(current.effective)}`,
  NEXT_WAGE: next ? fmt(next.wage) : "CPI", NEXT_SUB: next ? longDate(next.effective) : "Set by DOLI each October 1",
  NEXT_DATE: next ? longDate(next.effective) : "",
  FIRST_OPEN: String(firstOpen), FIRST_OPEN_PREV: String(firstOpen - 1), FIRST_CPI_YEAR: String(firstCpiYear),
  FIRST_CPI_PCT: pct(est.cpiPct), EST_FIRST: fmt(est.wage),
  EST_2070: fmt(row(base, END_YEAR).wage), EST_2070_ANNUAL: fmtK(row(base, END_YEAR).annual),
  UPDATED_LONG: longDate(today), CPI_THROUGH: cpiThrough, SURVEY: `SPF ${surveyLabel}`, SURVEY_URL: assumptions.sourceUrl,
  NOWCAST_TEXT: nowcast, BASE_TEXT: baseText, STEPS_HTML: stepsHtml,
  CSS: fs.readFileSync(path.join(ROOT, "src/site.css"), "utf8"),
  ENGINE: engineGlobal, PAGE_JS: fs.readFileSync(path.join(ROOT, "src/page.js"), "utf8"),
  DATA_JSON: JSON.stringify(siteData).replace(/</g, "\\u003c")
};

// Media kit cards and captions (always base scenario).
const hashtags = "#Virginia #MinimumWage #RVA #NoVA #757";
const cardDefs = [
  { id: "current", title: "Today’s rate", caption: `Virginia’s minimum wage is ${fmt(current.wage)} an hour, in effect since ${longDate(current.effective)}.` + (next ? ` Next step: ${fmt(next.wage)} on ${longDate(next.effective)}.` : "") },
  ...(next ? [{ id: "next", title: "Next increase", caption: `Virginia’s minimum wage goes up to ${fmt(next.wage)} an hour on ${longDate(next.effective)}, ${isFixed(next.basis) ? "as set by state law" : "based on the inflation formula (estimate)"}.` + (after ? ` After that: ${fmt(after.wage)} on ${after.label.replace(/^Est\. /, "")}${after.fixed ? "" : " (estimate)"}.` : "") }] : []),
  { id: "estimate", title: `${firstOpen} estimate`, caption: `From ${law.indexing.firstYear}, Virginia’s minimum wage rises with inflation every year. Our base estimate for ${firstOpen}: ${fmt(est.wage)} an hour (range ${range}). DOLI announces the official rate by October 1, ${firstOpen - 1}.` },
  { id: "schedule", title: "Year by year", caption: `Virginia’s minimum wage by year, ${base[0].year}–${END_YEAR}. Rates through ${law.schedule[law.schedule.length - 1].effective.slice(0, 4)} are set by law; later years are base estimates using the CPI-U formula in Va. Code § 40.1-28.10.` }
].map(d => ({ ...d, caption: `${d.caption}\n\nTracker and forecast: ${SITE_URL}\n${hashtags}` }));

const cardsHtml = cardDefs.map(d => `
  <div class="kit" data-card="${d.id}">
    <a class="thumb" href="media/${d.id}-post.png?v=${version}"><img src="media/${d.id}-post.png?v=${version}" alt="${d.title}: ${escapeHtml(d.caption.split("\n")[0])}" width="1080" height="1350" loading="lazy"></a>
    <h3>${d.title}</h3>
    <span class="meta">1080 × 1350 px PNG</span>
    <div class="acts">
      <a class="btn" href="media/${d.id}-post.png?v=${version}" download="va-minimum-wage-${d.id}-post.png">Download</a>
      <button class="btn ghost" type="button" data-share>Share</button>
    </div>
    <details class="kit-more"><summary>Suggested caption</summary>
      <div style="display:grid;gap:8px;margin-top:8px"><div class="cap">${escapeHtml(d.caption)}</div><button class="btn ghost" type="button" data-copy>Copy caption</button></div>
    </details>
  </div>`).join("");

const cardsData = {
  updatedShort: shortDate(today), siteHost: SITE_HOST, thisYear,
  current: { wage: current.wage, since: longDate(current.effective), annual: fmtK(current.wage * 2080) },
  next: next ? { wage: next.wage, date: longDate(next.effective), dateShort: shortDate(next.effective), fixed: isFixed(next.basis), delta: `${fmt(next.wage - current.wage)} (${pct((next.wage / current.wage - 1) * 100)})`, annual: fmtK(next.wage * 2080), after } : { wage: current.wage, date: "", dateShort: "", fixed: true, delta: "", annual: "" },
  est: { year: firstOpen, wage: est.wage, cpiYear: firstCpiYear, cpiPct: pct(est.cpiPct), range, next: fmt(row(base, firstOpen + 1).wage), y2050: fmt(row(base, 2050).wage) },
  longRun: assumptions.longRun + "%",
  rows: base.map(r => ({ year: r.year, wage: r.wage, fixed: isFixed(r.basis) })),
  ogSteps: [
    ...base.filter(r => isFixed(r.basis) && r.year > thisYear).map(r => ({ label: `Jan 1, ${r.year}`, wage: r.wage, fixed: true })),
    { label: `${firstOpen} estimate`, wage: est.wage, est: true },
    { label: "2050 estimate", wage: row(base, 2050).wage, est: true }
  ].slice(0, 5)
};

function escapeHtml(s) { return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function fill(tpl, extra = {}) {
  const all = { ...tokens, ...extra };
  return tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    if (!(k in all)) throw new Error(`Unknown template token ${k}`);
    return all[k];
  });
}

// Clear old output but keep rendered images (scripts/images.mjs regenerates them).
if (fs.existsSync(OUT)) for (const f of fs.readdirSync(OUT)) if (f !== "media") fs.rmSync(path.join(OUT, f), { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, "data"), { recursive: true });
fs.mkdirSync(path.join(OUT, "media"), { recursive: true });
fs.mkdirSync(BUILD, { recursive: true });
const tpl = f => fs.readFileSync(path.join(ROOT, "src", f), "utf8");
fs.writeFileSync(path.join(OUT, "index.html"), fill(tpl("index.html")));
fs.writeFileSync(path.join(OUT, "media.html"), fill(tpl("media.html"), { CARDS_HTML: cardsHtml }));
fs.writeFileSync(path.join(BUILD, "card.html"), fill(tpl("card.html"), { CARDS_JSON: JSON.stringify(cardsData).replace(/</g, "\\u003c") }));
fs.writeFileSync(path.join(BUILD, "cards.json"), JSON.stringify(cardDefs.map(d => d.id)));
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
fs.writeFileSync(path.join(OUT, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#1d3a7a"/><text x="32" y="42" font-family="Georgia,serif" font-weight="700" font-size="28" text-anchor="middle" fill="#fff">VA</text><rect x="14" y="48" width="36" height="4" rx="2" fill="#f3ac5f"/></svg>`);

// Public data files
const publicRows = base.map(r => ({
  year: r.year, wage: r.wage, basis: r.basis, cpiYear: r.cpiYear, cpiChangePct: r.cpiPct != null ? Math.round(r.cpiPct * 100) / 100 : null,
  cpiStatus: r.cpiStatus || null, annualFullTime: Math.round(r.annual), low: row(low, r.year).wage, high: row(high, r.year).wage
}));
fs.writeFileSync(path.join(OUT, "data/forecast.json"), JSON.stringify({
  title: "Virginia minimum wage: statutory schedule and CPI-indexed forecast",
  built: today, scenario: "base", statute: law.statuteUrl, cpiThrough: latestCpi,
  assumptions: { byYear: assumptions.byYear, longRun: assumptions.longRun, source: assumptions.source },
  rows: publicRows
}, null, 1));
fs.writeFileSync(path.join(OUT, "data/forecast.csv"),
  "year,hourly_wage,basis,cpi_year,cpi_change_pct,cpi_status,annual_full_time,low_scenario,high_scenario\n" +
  publicRows.map(r => [r.year, r.wage.toFixed(2), r.basis, r.cpiYear ?? "", r.cpiChangePct ?? "", r.cpiStatus ?? "", r.annualFullTime, r.low.toFixed(2), r.high.toFixed(2)].join(",")).join("\n") + "\n");

console.log(`Built ${today} v${version}: now ${fmt(current.wage)}, next ${next ? fmt(next.wage) + " " + next.effective : "-"}, ${firstOpen} est ${fmt(est.wage)} (${c.status}), ${END_YEAR} ${fmt(row(base, END_YEAR).wage)}`);
