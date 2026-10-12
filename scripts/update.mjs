// Checks every upstream source and updates data/ (or proposes changes for review).
//
//   CPI-U (BLS)            -> data/cpi.json                         applied automatically
//   SPF outlook (Phil Fed) -> data/assumptions.json                 applied automatically when parsed cleanly
//   DOLI announcements     -> data/law.json "announced" rate        applied when it matches the formula, else PR
//   Code of Virginia       -> data/law.json schedule                always a pull request
//   General Assembly bills -> tracking issue per session            issue only
//
// Usage: node scripts/update.mjs [--only=cpi,spf,doli,statute,bills] [--dry]
// In GitHub Actions (GH_TOKEN set) it commits, opens PRs and files issues via scripts/lib/github.mjs.
import fs from "node:fs";
import path from "node:path";
import { ROOT, readJson, writeJson, todayET, fetchText, fetchJson, htmlToText, monthName, longDate } from "./lib/util.mjs";
import { askJson, aiEnabled, AI_MODEL } from "./lib/ai.mjs";
import { project, firstOpenYear, roundCents } from "../src/engine.js";
import { publish } from "./lib/github.mjs";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const only = args.only ? new Set(String(args.only).split(",")) : null;
const DRY = Boolean(args.dry) || !process.env.GH_TOKEN;
const today = process.env.BUILD_DATE || todayET();
const [Y, M, D] = today.split("-").map(Number);

const law = readJson("data/law.json");
const cpi = readJson("data/cpi.json");
const assumptions = readJson("data/assumptions.json");
const watch = fs.existsSync(path.join(ROOT, "data/watch.json")) ? readJson("data/watch.json") : {};
watch.failures ||= {};

const report = {
  date: today,
  commits: [],     // summary lines for changes applied directly to main
  proposals: [],   // { key, title, body, files: { path: content } } -> pull requests
  issues: [],      // { title, body, labels } -> new issue or comment on the open one with that title
  log: []
};
const log = msg => { console.log(msg); report.log.push(msg); };
const fmt = v => "$" + v.toFixed(2);
const changed = new Set();

async function step(name, fn) {
  if (only && !only.has(name)) return;
  try {
    await fn();
    watch.failures[name] = 0;
  } catch (e) {
    watch.failures[name] = (watch.failures[name] || 0) + 1;
    log(`[${name}] failed (${watch.failures[name]} in a row): ${e.message}`);
    if (watch.failures[name] === 3) {
      report.issues.push({
        title: `Update source failing: ${name}`,
        body: `The scheduled update could not read the **${name}** source three runs in a row.\n\nLast error:\n\n\`\`\`\n${e.stack || e.message}\n\`\`\`\n\nThe site keeps building with the last good data. Check whether the source URL or format changed.`,
        labels: ["automation"]
      });
    }
  }
}

// ---------------------------------------------------------------- CPI-U from BLS
async function updateCpi() {
  const key = process.env.BLS_API_KEY;
  const url = `https://api.bls.gov/publicAPI/${key ? "v2" : "v1"}/timeseries/data/`;
  const body = { seriesid: ["CUUR0000SA0", "CUSR0000SA0"], startyear: String(Y - 2), endyear: String(Y), ...(key ? { registrationkey: key } : {}) };
  const res = await fetchJson(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (res.status !== "REQUEST_SUCCEEDED") throw new Error(`BLS: ${res.status} ${(res.message || []).join(" ")}`);
  const before = JSON.stringify([cpi.nsa, cpi.sa]);
  const prevLatest = cpi.latest;
  for (const s of res.Results.series) {
    const target = s.seriesID === "CUUR0000SA0" ? cpi.nsa : cpi.sa;
    for (const x of s.data) {
      if (!/^M(0[1-9]|1[0-2])$/.test(x.period)) continue;
      const v = parseFloat(x.value);
      if (!Number.isFinite(v) || v < 50 || v > 2000) continue;
      target[`${x.year}-${x.period.slice(1)}`] = v;
    }
  }
  const sortObj = o => Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
  cpi.nsa = sortObj(cpi.nsa); cpi.sa = sortObj(cpi.sa);
  if (JSON.stringify([cpi.nsa, cpi.sa]) === before) { log("[cpi] no new data"); return; }
  cpi.latest = Object.keys(cpi.nsa).pop();
  cpi.updated = today;
  writeJson("data/cpi.json", cpi);
  changed.add("data/cpi.json");
  const [ly, lm] = cpi.latest.split("-").map(Number);
  let line = cpi.latest !== prevLatest ? `CPI-U through ${monthName(lm)} ${ly}` : "CPI-U revisions";
  if (lm === 12 && cpi.latest !== prevLatest && cpi.nsa[`${ly - 1}-12`]) {
    const chg = (cpi.nsa[cpi.latest] / cpi.nsa[`${ly - 1}-12`] - 1) * 100;
    const rows = project({ law, cpi, assumptions }, { name: "base" }, 2026);
    const r = rows.find(x => x.year === ly + 2);
    line += ` (${ly} Dec–Dec ${chg.toFixed(1)}%${r && r.basis === "calculated" ? `; ${ly + 2} rate now calculable at ${fmt(r.wage)}` : ""})`;
  }
  report.commits.push(line);
  log(`[cpi] ${line}`);
}

// ---------------------------------------------------------------- SPF inflation outlook
function latestSpfQuarter() {
  // Released mid-February, May, August and November.
  const rel = [[2, 1], [5, 2], [8, 3], [11, 4]];
  for (let i = rel.length - 1; i >= 0; i--) {
    const [m, q] = rel[i];
    if (M > m || (M === m && D >= 10)) return { year: Y, q };
  }
  return { year: Y - 1, q: 4 };
}

export function parseSpf(text) {
  const t = text.replace(/\s+/g, " ");
  const start = t.indexOf("Projections for Inflation");
  if (start < 0) return null;
  const seg = t.slice(start, start + 4000);
  const tok = "([\\d.]+|N\\.A\\.)";
  const annual = seg.slice(seg.indexOf("Q4/Q4 Annual Averages"));
  const byYear = {};
  const rowRe = new RegExp(`(?:^|\\s)(20\\d\\d) ${tok} ${tok} ${tok} ${tok} ${tok} ${tok} ${tok} ${tok}`, "g");
  const endAnnual = annual.indexOf("Long-Term");
  for (const m of annual.slice(0, endAnnual > 0 ? endAnnual : 600).matchAll(rowRe)) {
    const v = parseFloat(m[3]); // headline CPI, current survey
    if (Number.isFinite(v)) byYear[m[1]] = v;
  }
  let longRun = null;
  for (const m of seg.matchAll(new RegExp(`(20\\d\\d)-(20\\d\\d) ${tok} ${tok}`, "g"))) {
    if (Number(m[2]) - Number(m[1]) === 9 && Number.isFinite(parseFloat(m[4]))) { longRun = parseFloat(m[4]); break; }
  }
  const years = Object.keys(byYear);
  const sane = v => v > -2 && v < 15;
  if (years.length < 2 || longRun == null || !Object.values(byYear).every(sane) || !sane(longRun)) return null;
  return { byYear, longRun };
}

async function updateSpf() {
  const { year, q } = latestSpfQuarter();
  const id = `${year}Q${q}`;
  if (assumptions.survey === id) { log(`[spf] already on ${id}`); return; }
  const url = `https://www.philadelphiafed.org/surveys-and-data/real-time-data-research/spf-q${q}-${year}`;
  let html;
  try { html = await fetchText(url); } catch (e) {
    if (/^404/.test(e.message)) { log(`[spf] ${id} not published yet`); return; }
    throw e;
  }
  const text = htmlToText(html);
  let parsed = parseSpf(text), how = "parsed";
  if (!parsed) {
    const ai = await askJson(
      `From this Survey of Professional Forecasters release, give the CURRENT survey's median headline CPI inflation forecasts.\n` +
      `Return {"byYear": {"<year>": <Q4/Q4 headline CPI percent>, ...}, "longRun": <10-year annual-average headline CPI percent>}.`,
      text.slice(0, 60000), { label: "spf" });
    if (ai && ai.byYear && typeof ai.longRun === "number") {
      const ok = Object.entries(ai.byYear).every(([k, v]) => /^20\d\d$/.test(k) && typeof v === "number" && v > -2 && v < 15 && text.includes(v.toFixed(1)));
      if (ok && text.includes(ai.longRun.toFixed(2))) { parsed = { byYear: ai.byYear, longRun: ai.longRun }; how = `extracted by ${AI_MODEL}`; }
    }
  }
  if (!parsed) {
    report.issues.push({ title: `Could not read SPF ${id} inflation outlook`, labels: ["automation"],
      body: `The ${id} Survey of Professional Forecasters is published at ${url}, but its inflation table could not be parsed.\n\nUpdate \`data/assumptions.json\` by hand: \`byYear\` takes the median headline CPI (Q4/Q4) for each year shown, and \`longRun\` takes the 10-year annual-average headline CPI.` });
    return;
  }
  const old = { byYear: assumptions.byYear, longRun: assumptions.longRun };
  const next = { ...assumptions, survey: id, sourceUrl: url, updated: today, byYear: parsed.byYear, longRun: parsed.longRun,
    source: `Federal Reserve Bank of Philadelphia, Survey of Professional Forecasters, ${year} Q${q}: median headline CPI, Q4/Q4`,
    longRunNote: "SPF 10-year annual-average headline CPI expectation" };
  const line = `Inflation outlook → SPF ${id}: ${Object.entries(parsed.byYear).map(([k, v]) => `${k} ${v}%`).join(", ")}; 10-yr ${parsed.longRun}% (was ${JSON.stringify(old.byYear)} / ${old.longRun}%; ${how})`;
  if (how === "parsed") {
    Object.assign(assumptions, next);
    writeJson("data/assumptions.json", assumptions);
    changed.add("data/assumptions.json");
    report.commits.push(line);
  } else {
    report.proposals.push({ key: `spf-${id}`, title: `Update inflation outlook to SPF ${id}`, files: { "data/assumptions.json": JSON.stringify(next, null, 1) + "\n" },
      body: `${line}\n\nThe table could not be parsed directly, so the AI model read it. Check the numbers against ${url} before merging.` });
  }
  log(`[spf] ${line}`);
}

// ---------------------------------------------------------------- DOLI announcements
async function checkDoli() {
  const posts = await fetchJson("https://doli.virginia.gov/wp-json/wp/v2/posts?search=minimum%20wage&per_page=10&_fields=id,date,link,title,content");
  watch.doli ||= { seen: [] };
  const firstRun = watch.doli.seen.length === 0;
  const fresh = posts.filter(p => !watch.doli.seen.includes(p.id));
  watch.doli.seen = [...new Set([...watch.doli.seen, ...posts.map(p => p.id)])].slice(-200);
  if (firstRun) { log(`[doli] seeded ${posts.length} posts`); return; }
  if (!fresh.length) { log("[doli] no new posts"); return; }
  for (const p of fresh) {
    const title = htmlToText(p.title.rendered);
    const text = `${title}\n${htmlToText(p.content.rendered)}`;
    log(`[doli] new post: ${title}`);
    // Look for "$NN.NN ... January 1, YYYY" style announcements.
    const years = [...text.matchAll(/January 1,\s*(20\d\d)/g)].map(m => Number(m[1])).filter(y => y > Y - 1);
    const rates = [...new Set([...text.matchAll(/\$\s?(\d{1,2}\.\d{2})/g)].map(m => parseFloat(m[1])))].filter(v => v >= 7.25 && v < 100);
    let found = null, how = "pattern";
    const targetYears = [...new Set(years)];
    if (targetYears.length === 1) {
      const fixed = law.schedule.map(s => s.wage);
      const candidates = rates.filter(v => !fixed.includes(v) || law.schedule.some(s => s.effective === `${targetYears[0]}-01-01` && s.wage === v));
      if (candidates.length === 1) found = { year: targetYears[0], wage: candidates[0] };
    }
    if (!found) {
      const ai = await askJson(
        `Does this Virginia Department of Labor and Industry post announce the state minimum wage rate for an upcoming January 1? ` +
        `Return {"announcesRate": true|false, "effectiveYear": <year or null>, "hourlyRate": <number or null>, "cpiPercent": <number or null>}.`,
        text.slice(0, 40000), { label: "doli" });
      if (ai && ai.announcesRate && Number.isInteger(ai.effectiveYear) && typeof ai.hourlyRate === "number" && text.includes(ai.hourlyRate.toFixed(2))) {
        found = { year: ai.effectiveYear, wage: ai.hourlyRate }; how = `extracted by ${AI_MODEL}`;
      }
    }
    if (!found) {
      report.issues.push({ title: `Review new DOLI minimum wage post: ${title}`, labels: ["automation", "law"],
        body: `DOLI published a post that mentions the minimum wage:\n\n${p.link}\n\nNo upcoming rate could be read from it automatically. If it announces a rate, add it to \`data/law.json\` as \`{"effective": "YYYY-01-01", "wage": N, "basis": "announced"}\`.` });
      continue;
    }
    const existing = law.schedule.find(s => s.effective === `${found.year}-01-01`);
    if (existing && existing.wage === found.wage) { log(`[doli] ${found.year} ${fmt(found.wage)} already recorded`); continue; }
    const rows = project({ law, cpi, assumptions }, { name: "base" }, 2026);
    const ours = rows.find(r => r.year === found.year);
    const entry = { effective: `${found.year}-01-01`, wage: found.wage, basis: "announced", note: `DOLI announced ${longDate(p.date.slice(0, 10))}`, source: p.link };
    const newLaw = { ...law, schedule: [...law.schedule.filter(s => s.effective !== entry.effective), entry].sort((a, b) => a.effective.localeCompare(b.effective)) };
    const matches = ours && ours.basis === "calculated" && Math.abs(ours.wage - found.wage) <= 0.011;
    const line = `DOLI announced ${fmt(found.wage)} effective January 1, ${found.year}` + (ours ? ` (formula gave ${fmt(ours.wage)}, ${ours.basis})` : "");
    if (matches && how === "pattern" && !existing) {
      Object.assign(law, newLaw);
      writeJson("data/law.json", law);
      changed.add("data/law.json");
      report.commits.push(line);
    } else {
      report.proposals.push({ key: `doli-${found.year}`, title: `Record DOLI rate for ${found.year}: ${fmt(found.wage)}`,
        files: { "data/law.json": JSON.stringify(newLaw, null, 1) + "\n" },
        body: `${line}.\n\nSource: ${p.link}\nRead by: ${how}.\n\n${existing ? `This replaces the recorded ${fmt(existing.wage)}. ` : ""}${matches ? "" : "The announced figure does not match a finished CPI calculation, so please confirm it before merging."}` });
    }
    log(`[doli] ${line}`);
  }
}

// ---------------------------------------------------------------- Code of Virginia § 40.1-28.10
async function checkStatute() {
  const res = await fetchJson(law.statuteApi);
  const body = res && res.ChapterList && res.ChapterList[0] && res.ChapterList[0].Body;
  if (!body) throw new Error("statute API returned no section body");
  const text = htmlToText(body.replace(/<\/p>/gi, "</p>\n"));
  const file = "data/sources/statute-40.1-28.10.txt";
  const full = path.join(ROOT, file);
  const old = fs.existsSync(full) ? fs.readFileSync(full, "utf8") : null;
  if (old === text + "\n") { log("[statute] unchanged"); return; }
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text + "\n");
  changed.add(file);
  if (old == null) { log("[statute] saved baseline text"); report.commits.push("Saved statute baseline text"); return; }
  report.commits.push("Code of Virginia § 40.1-28.10 text changed");
  log("[statute] TEXT CHANGED");

  // Ask the model to restate the schedule; only keep values that literally appear in the statute.
  const ai = await askJson(
    `This is the current text of Virginia Code § 40.1-28.10 (minimum wage). List every fixed hourly rate with the date it takes effect, ` +
    `and describe the inflation adjustment. Return {"fixedRates": [{"effective": "YYYY-MM-DD", "wage": <number>}], ` +
    `"indexing": {"firstYear": <first year an adjusted rate takes effect>, "announceBy": "<month day>", "lagYears": <calendar years between CPI year and effective year>, "measure": "<short description>"}, ` +
    `"summary": "<two sentences on what changed for workers>"}.`,
    `CURRENT TEXT:\n${text}\n\nPREVIOUS TEXT:\n${old}`, { label: "statute" });
  let files = {}, aiNote = "No AI summary was available, so `data/law.json` needs a manual update.";
  if (ai && Array.isArray(ai.fixedRates)) {
    const valid = ai.fixedRates.filter(r => /^\d{4}-\d{2}-\d{2}$/.test(r.effective) && typeof r.wage === "number" && text.includes("$" + r.wage.toFixed(2)) && text.includes(longDate(r.effective)));
    if (valid.length) {
      const earliest = valid.map(r => r.effective).sort()[0];
      const schedule = [
        ...law.schedule.filter(s => s.effective < earliest),
        ...valid.map(r => ({ effective: r.effective, wage: r.wage, basis: "statute", note: "Statute amended" }))
      ].sort((a, b) => a.effective.localeCompare(b.effective));
      const indexing = { ...law.indexing };
      if (ai.indexing && Number.isInteger(ai.indexing.firstYear) && text.includes(String(ai.indexing.firstYear - 1))) indexing.firstYear = ai.indexing.firstYear;
      files["data/law.json"] = JSON.stringify({ ...law, schedule, indexing }, null, 1) + "\n";
      aiNote = `**${AI_MODEL} summary:** ${ai.summary || "(none)"}\n\nProposed schedule from the new text (every rate and date was checked against the statute):\n\n` +
        valid.map(r => `- ${longDate(r.effective)}: ${fmt(r.wage)}`).join("\n") + `\n\nIndexing: first adjusted year ${indexing.firstYear}.`;
    }
  }
  files[file] = text + "\n";
  report.proposals.push({ key: "statute", title: "Code of Virginia § 40.1-28.10 changed: review minimum wage schedule", files,
    body: `The text of [§ 40.1-28.10](${law.statuteUrl}) changed.\n\n${aiNote}\n\nCompare the statute diff in this PR, check \`data/law.json\`, and merge to update the site and media kit.` });
}

// ---------------------------------------------------------------- General Assembly bills (LIS)
function parseCsv(text) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && text[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur || row.length) { row.push(cur); rows.push(row); }
  const [head, ...rest] = rows;
  return rest.filter(r => r.length > 1).map(r => Object.fromEntries(head.map((h, i) => [h, r[i] ?? ""])));
}

async function checkBills() {
  watch.bills ||= {};
  const sessions = [`${Y}1`, `${Y}2`, `${Y}3`];
  for (const s of sessions) {
    let csv;
    try { csv = await fetchText(`https://lis.blob.core.windows.net/lisfiles/${s}/BILLS.CSV`); }
    catch (e) { if (/^40[34]/.test(e.message)) continue; throw e; }
    if (!csv.startsWith('"Bill_id"')) continue;
    const bills = parseCsv(csv).filter(b => /minimum wage/i.test(b.Bill_description));
    const seeded = watch.bills[s] != null;
    const known = watch.bills[s] ||= {};
    const updates = [];
    for (const b of bills) {
      const status = b.Approved === "Y" ? "Approved by Governor" : b.Vetoed === "Y" ? "Vetoed" : b.Failed === "Y" ? "Failed" : b.Carried_over === "Y" ? "Carried over"
        : b.Passed === "Y" ? "Passed General Assembly" : b.Passed_house === "Y" || b.Passed_senate === "Y" ? "Passed one chamber" : "Introduced";
      if (known[b.Bill_id] === status) continue;
      updates.push({ id: b.Bill_id, desc: b.Bill_description, patron: b.Patron_name, status, was: known[b.Bill_id] });
      known[b.Bill_id] = status;
    }
    if (!updates.length) { log(`[bills] ${s}: no changes (${bills.length} tracked)`); continue; }
    if (!seeded && !Object.keys(watch.bills).some(k => k !== s)) { log(`[bills] ${s}: seeded ${updates.length} bills`); continue; }
    const sessionName = s.endsWith("1") ? `${s.slice(0, 4)} Regular Session` : `${s.slice(0, 4)} Special Session ${Number(s.slice(4)) - 1}`;
    const lines = updates.map(u => `- [${u.id}](https://lis.virginia.gov/bill-details/${s}/${u.id}) (${u.patron}): ${u.desc} — **${u.status}**${u.was ? ` (was ${u.was})` : ""}`);
    const approved = updates.filter(u => u.status === "Approved by Governor");
    let note = "";
    if (approved.length) {
      note = `\n\n**Signed into law.** Signed bills usually take effect July 1. When the Code of Virginia updates, this Action opens a pull request with the new schedule. If a bill changes the rate schedule, \`data/law.json\` can be updated sooner by hand.`;
      const ai = await askJson(`For each bill below, say whether it changes Virginia's state minimum wage RATE or its inflation indexing (not coverage, enforcement or penalties). Return {"changesRate": [<bill ids>], "notes": "<one sentence>"}.`,
        approved.map(u => `${u.id}: ${u.desc}`).join("\n"), { label: "bills" });
      if (ai && Array.isArray(ai.changesRate)) note += `\n\n${AI_MODEL}: affects the rate → ${ai.changesRate.filter(id => approved.some(u => u.id === id)).join(", ") || "none"}. ${ai.notes || ""}`;
    }
    report.issues.push({ title: `Minimum wage bills: ${sessionName}`, labels: ["law"],
      body: `Updates from the General Assembly (${today}):\n\n${lines.join("\n")}${note}` });
    log(`[bills] ${s}: ${updates.length} updates`);
  }
}

// ---------------------------------------------------------------- run
await step("cpi", updateCpi);
await step("spf", updateSpf);
await step("doli", checkDoli);
await step("statute", checkStatute);
await step("bills", checkBills);

watch.lastRun = today;
writeJson("data/watch.json", watch);
changed.add("data/watch.json");

fs.mkdirSync(path.join(ROOT, "_update"), { recursive: true });
fs.writeFileSync(path.join(ROOT, "_update/report.json"), JSON.stringify({ ...report, changed: [...changed] }, null, 1));
log(`AI ${aiEnabled() ? `enabled (${AI_MODEL})` : "disabled"} · ${report.commits.length} direct updates · ${report.proposals.length} proposals · ${report.issues.length} issues`);

if (DRY) {
  if (report.proposals.length || report.issues.length) console.log(JSON.stringify({ proposals: report.proposals.map(p => p.title), issues: report.issues.map(i => i.title) }, null, 1));
} else {
  await publish(report, [...changed]);
}
