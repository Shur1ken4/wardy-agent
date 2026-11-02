// Runs on `npm install`. Points git at the repo's hooks so the secret check runs before every commit.
// Does nothing outside a git checkout (for example a downloaded zip).
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".git")) {
  try {
    execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
  } catch {
    // git is not installed. CI still runs the secret check.
  }
}
