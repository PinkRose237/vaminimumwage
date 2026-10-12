import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const readJson = p => JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
export const writeJson = (p, v) => fs.writeFileSync(path.join(ROOT, p), JSON.stringify(v, null, 1) + "\n");

// Today's date in Virginia (Eastern time), YYYY-MM-DD.
export function todayET(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
export const monthName = m => MONTHS[m - 1];
export function longDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}
export function shortDate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}`;
}

const UA = "vaminimumwage-bot/1.0 (+https://github.com/PinkRose237/vaminimumwage)";
export async function fetchText(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...(opts.headers || {}) }, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  return res.text();
}
export async function fetchJson(url, opts) { return JSON.parse(await fetchText(url, opts)); }

export function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#8217;|&rsquo;/g, "’").replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, "\"").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(n)).replace(/&[a-z]+;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}

export const sha256 = s => import("node:crypto").then(c => c.createHash("sha256").update(s).digest("hex"));
