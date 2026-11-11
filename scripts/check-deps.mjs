// Supply-chain check, no dependencies: every direct dependency is pinned to one exact version, and that version has
// been on npm for at least two weeks, long enough for a hijacked release to be noticed and pulled.
//   node scripts/check-deps.mjs            needs the internet, to ask npm when each version was published
//   node scripts/check-deps.mjs --offline  only checks the pins
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MIN_AGE_DAYS = 14;

/** Versions allowed in young, each with the reason. Remove an entry once its version is old enough. */
export const EXCEPTIONS = {
  // The live mainnet path was run with real funds against this exact release (docs/DECISIONS.md, 2026-11-05). An older
  // release isn't what was tested, and that path can only be tested again with real money.
  "@near-intents-agent-api/sdk": "0.7.3",
};

export function manifestFiles(root = ".") {
  const files = [`${root}/package.json`];
  for (const group of ["packages", "apps"]) {
    if (!existsSync(`${root}/${group}`)) continue;
    for (const name of readdirSync(`${root}/${group}`)) if (existsSync(`${root}/${group}/${name}/package.json`)) files.push(`${root}/${group}/${name}/package.json`);
  }
  return files;
}

/** Every direct dependency, with its declared version, from every workspace manifest. */
export function directDependencies(root = ".") {
  const found = new Map();
  for (const file of manifestFiles(root)) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const kind of ["dependencies", "devDependencies"]) {
      for (const [name, version] of Object.entries(pkg[kind] ?? {})) {
        if (name.startsWith("@wardy-agent/")) continue; // Workspace packages aren't published.
        found.set(name, { version, file });
      }
    }
  }
  return found;
}

export function isExactVersion(version) {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version);
}

function publishedAt(name, version) {
  const times = JSON.parse(execFileSync("npm", ["view", `${name}@${version}`, "time", "--json"], { encoding: "utf8" }));
  return new Date(times[version]);
}

function main() {
  const offline = process.argv.includes("--offline");
  const problems = [];
  const deps = directDependencies();
  for (const [name, { version, file }] of deps) {
    if (!isExactVersion(version)) problems.push(`${file}: ${name} is "${version}", not one exact version`);
  }
  if (!offline) {
    const cutoff = Date.now() - MIN_AGE_DAYS * 24 * 60 * 60_000;
    for (const [name, { version }] of deps) {
      if (!isExactVersion(version)) continue;
      let when;
      try {
        when = publishedAt(name, version);
      } catch {
        problems.push(`${name}@${version}: npm didn't say when it was published`);
        continue;
      }
      if (EXCEPTIONS[name] === version) {
        console.warn(`${name}@${version} is under ${MIN_AGE_DAYS} days old, allowed for the reason in scripts/check-deps.mjs`);
        continue;
      }
      if (when.getTime() > cutoff) problems.push(`${name}@${version} was published on ${when.toISOString().slice(0, 10)}, under ${MIN_AGE_DAYS} days ago`);
    }
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log(`Dependency check passed (${deps.size} direct dependencies${offline ? ", pins only" : ", pinned and at least two weeks old"}).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
