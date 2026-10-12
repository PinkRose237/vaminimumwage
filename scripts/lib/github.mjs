// Applies an update report inside GitHub Actions: commits data to main,
// opens one pull request per proposal, and files or comments on issues.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ROOT } from "./util.mjs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts }).trim();
const git = (...a) => sh("git", a);
const gh = (...a) => sh("gh", a);

function ensureLabels(labels) {
  const colors = { automation: "1d3a7a", law: "b4610e" };
  for (const l of labels) {
    try { gh("label", "create", l, "--color", colors[l] || "888888", "--force"); } catch { /* exists or no permission */ }
  }
}

export async function publish(report, changed) {
  git("config", "user.name", "github-actions[bot]");
  git("config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
  const base = git("rev-parse", "--abbrev-ref", "HEAD");

  // 1. Direct data updates on the current branch.
  git("add", "--", ...changed.filter(f => fs.existsSync(path.join(ROOT, f))));
  if (git("status", "--porcelain", "--", "data")) {
    const title = report.commits.length ? `Data update ${report.date}: ${report.commits[0]}` : `Update monitor state ${report.date}`;
    const body = report.commits.slice(1).map(c => `- ${c}`).join("\n");
    git("commit", "-m", title.slice(0, 120), ...(body ? ["-m", body] : []));
    git("push", "origin", `HEAD:${base}`);
    console.log(`Committed: ${title}`);
  }

  // 2. Pull requests for changes that need a person to check them.
  if (report.proposals.length) ensureLabels(["automation", "law"]);
  for (const p of report.proposals) {
    const branch = `bot/${p.key}`;
    const open = JSON.parse(gh("pr", "list", "--head", branch, "--state", "open", "--json", "number"));
    git("checkout", "-B", branch, base);
    for (const [f, content] of Object.entries(p.files)) {
      fs.mkdirSync(path.dirname(path.join(ROOT, f)), { recursive: true });
      fs.writeFileSync(path.join(ROOT, f), content);
      git("add", "--", f);
    }
    if (!git("status", "--porcelain")) { git("checkout", base); continue; }
    git("commit", "-m", p.title);
    git("push", "--force", "origin", branch);
    const bodyFile = path.join(ROOT, "_update", `${p.key}.md`);
    fs.writeFileSync(bodyFile, `${p.body}\n\n---\nOpened by the scheduled update workflow. Merging redeploys the site and regenerates the media kit.`);
    if (open.length) {
      gh("pr", "comment", String(open[0].number), "--body-file", bodyFile);
      console.log(`Updated PR #${open[0].number}`);
    } else {
      const url = gh("pr", "create", "--base", base, "--head", branch, "--title", p.title, "--body-file", bodyFile, "--label", "automation");
      console.log(`Opened ${url}`);
    }
    git("checkout", base);
  }

  // 3. Issues: comment on an open issue with the same title, else create one.
  if (report.issues.length) ensureLabels([...new Set(report.issues.flatMap(i => i.labels || []))]);
  for (const i of report.issues) {
    const found = JSON.parse(gh("issue", "list", "--state", "open", "--search", `"${i.title.replace(/"/g, "")}" in:title`, "--json", "number,title"))
      .find(x => x.title === i.title);
    const bodyFile = path.join(ROOT, "_update", "issue.md");
    fs.writeFileSync(bodyFile, i.body);
    if (found) {
      gh("issue", "comment", String(found.number), "--body-file", bodyFile);
      console.log(`Commented on issue #${found.number}`);
    } else {
      const args = ["issue", "create", "--title", i.title, "--body-file", bodyFile];
      for (const l of i.labels || []) args.push("--label", l);
      console.log(`Opened ${gh(...args)}`);
    }
  }
}
