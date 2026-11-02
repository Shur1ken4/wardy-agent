// Fails if a tracked or staged file looks like it contains a secret. No dependencies, so the
// pre-commit hook works even before `npm install`.
//   node scripts/check-secrets.mjs            scan every tracked file
//   node scripts/check-secrets.mjs --staged   scan what is about to be committed
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

// Values are long enough that placeholders such as `naa_...` in docs never match.
export const SECRET_PATTERNS = [
  ["NEAR private key", /ed25519:[1-9A-HJ-NP-Za-km-z]{80,}/],
  ["Agent Connect API key", /\bnaa_[A-Za-z0-9_-]{16,}/],
  ["Agent Connect grant token", /\bngt_[A-Za-z0-9_-]{16,}/],
  ["OutLayer wallet key", /\bwk_[A-Za-z0-9_-]{16,}/],
  ["Agent Market token", /\baat_[A-Za-z0-9_-]{16,}/],
  ["API secret key", /\bsk-[A-Za-z0-9_-]{20,}/],
  ["Telegram bot token", /\b\d{8,10}:[A-Za-z0-9_-]{35}\b/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["Wardy Agent secret", /\bWARDY_(?:SIGNING_KEY|AGENT_TOKEN|OWNER_TOKEN)=[A-Za-z0-9]{16,}/],
];

const ENV_FILE = /(^|\/)\.env(\.(?!example$)[^/]+)?$/;

export function findSecrets(text) {
  return SECRET_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
}

export function isForbiddenPath(path) {
  return ENV_FILE.test(path);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(staged) {
  const output = staged
    ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
    : git(["ls-files", "-z"]);
  return output.split("\0").filter(Boolean);
}

function readFile(path, staged) {
  return execFileSync("git", ["show", `${staged ? "" : "HEAD"}:${path}`], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function main() {
  const staged = process.argv.includes("--staged");
  const problems = [];
  const files = listFiles(staged);
  for (const path of files) {
    if (isForbiddenPath(path)) {
      problems.push(`${path}: env files must never be committed`);
      continue;
    }
    let text;
    try {
      text = readFile(path, staged);
    } catch {
      continue; // Not committed yet, or a file git can't show as text.
    }
    for (const label of findSecrets(text)) problems.push(`${path}: looks like a ${label}`);
  }
  if (problems.length > 0) {
    console.error("Secret check FAILED:");
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`Secret check passed (${files.length} files).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
