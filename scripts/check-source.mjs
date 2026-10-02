import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// A narrow check of tracked/staged paths; never print matched secret values.
const paths = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0").filter(Boolean);
const privatePath = /(^|\/)(node_modules|dist|\.git|\.wrangler|\.sites-runtime|data|backups|exports|uploads)(\/|$)|\.(?:db(?:-.*)?|sqlite(?:3|-.*)?|pem|key|p12|pfx|tsbuildinfo)$/i;
const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["AWS key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ["Google key", /\bAIza[0-9A-Za-z_-]{35}\b/],
  ["Resend key", /\bre_[A-Za-z0-9]{24,}\b/],
  ["SendGrid key", /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{24,}\b/],
  ["deployed Gmail relay", /https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec/],
];
const issues = [];
if (!paths.length) throw new Error("No tracked source files. Run git add before checking.");
for (const path of paths) {
  const base = path.split("/").at(-1);
  if (privatePath.test(path) ||
      ((base.startsWith(".env") || base.startsWith(".dev.vars")) && !base.endsWith(".example")) ||
      (/\.sql$/i.test(path) && !path.startsWith("drizzle/") && path !== "docs/SCHEMA.sql")) {
    issues.push(`${path}: private runtime/data file`);
    continue;
  }
  const bytes = readFileSync(path);
  if (bytes.includes(0)) continue;
  const content = bytes.toString("utf8");
  for (const [label, pattern] of patterns) {
    if (pattern.test(content)) issues.push(`${path}: possible ${label}`);
  }
  if (path === ".openai/hosting.json" && "project_id" in JSON.parse(content)) {
    issues.push(`${path}: original deployment link must not be exported`);
  }
}
if (issues.length) {
  console.error(issues.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Checked ${paths.length} source files; no selected credential patterns or private runtime files found.`);
}
