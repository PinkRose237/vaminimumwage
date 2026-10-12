// Renders social media cards from _build/card.html into _site/media/*.png and zips them.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { ROOT } from "./lib/util.mjs";

const MEDIA = path.join(ROOT, "_site/media");
const CARD = pathToFileURL(path.join(ROOT, "_build/card.html")).href;
const cards = JSON.parse(fs.readFileSync(path.join(ROOT, "_build/cards.json"), "utf8"));
const FORMATS = { post: [1080, 1350], square: [1080, 1080], story: [1080, 1920] };

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
await page.goto(CARD, { waitUntil: "networkidle" });

async function shot(type, format, [w, h], file) {
  await page.setViewportSize({ width: w, height: h });
  await page.evaluate(([t, f]) => window.renderCard(t, f), [type, format]);
  await page.evaluate(() => document.fonts.ready);
  // Guard against text spilling out of the card.
  const overflow = await page.evaluate(() => {
    const c = document.getElementById("card").getBoundingClientRect();
    return [...document.querySelectorAll("#card .inner *")].some(e => {
      const r = e.getBoundingClientRect();
      return r.width && (r.right > c.right + 1 || r.bottom > c.bottom + 1);
    });
  });
  if (overflow) console.warn(`warning: content overflows ${type}-${format}`);
  await page.locator("#card").screenshot({ path: path.join(MEDIA, file) });
}

const files = [];
for (const type of cards) {
  for (const [format, dims] of Object.entries(FORMATS)) {
    const file = `${type}-${format}.png`;
    await shot(type, format, dims, file);
    files.push(file);
  }
}
await shot("og", "og", [1200, 630], "og.png");
await shot("icon", "icon", [180, 180], "apple-touch-icon.png");
await browser.close();

try {
  const zip = path.join(MEDIA, "vaminimumwage-media.zip");
  fs.rmSync(zip, { force: true });
  execFileSync("zip", ["-q", "-X", zip, ...files], { cwd: MEDIA });
} catch (e) {
  console.warn("zip not available; skipping media bundle:", e.message);
}
console.log(`Rendered ${files.length + 2} images`);
