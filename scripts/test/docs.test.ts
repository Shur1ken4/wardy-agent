// A judge reads the README first and follows it literally, so these keep it true: every command exists, every link
// resolves, and no result in it was typed by hand.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withResults } from "../readme-results.js";

const readme = readFileSync("README.md", "utf8");
const DOCS = ["README.md", "AGENTS.md", ...readdirSync("docs").filter((name) => name.endsWith(".md") && name !== "HACKATHON.md").map((name) => join("docs", name))];
const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;
const anchor = JSON.parse(readFileSync("config/network-anchor.testnet.json", "utf8")) as { txUrl: string };
const latest = readFileSync("apps/attack-lab/results/latest.md", "utf8");

describe("the README", () => {
  it("has the sections the brief asks for, in order", () => {
    const headings = [...readme.matchAll(/^## (.+)$/gm)].map((match) => match[1]);
    expect(headings).toEqual([
      "The problem",
      "What Wardy Agent does",
      "Try it in 2 minutes (no keys, no funds)",
      "Do X, see Y",
      "Live mode setup",
      "How it works",
      "NEAR tech used",
      "Attack Lab results",
      "What's proven vs what's trusted",
      "Threat model summary",
      "Related work and credits",
      "Disclosure",
      "Roadmap",
      "License",
    ]);
  });

  it("has at least 8 'do X, see Y' rows", () => {
    const section = readme.slice(readme.indexOf("## Do X, see Y"), readme.indexOf("## Live mode setup"));
    expect(section.match(/^\| (?!Do this|---)/gm)?.length).toBeGreaterThanOrEqual(8);
  });

  it("its results table is exactly what the committed run says", () => {
    expect(readme).toBe(withResults(readme));
  });

  it("its expected demo output is what the lab really prints", () => {
    const summary = /^Lost without Wardy Agent: (.+?)\. Lost with Wardy Agent: (.+?)\. Honest payments passed: (.+?)\. False blocks: (\d+)\.$/m.exec(latest);
    expect(summary).not.toBeNull();
    const [, without, withIt, honest, blocks] = summary as RegExpExecArray;
    expect(readme).toContain(`Lost without Wardy Agent: ${without} · Lost with Wardy Agent: ${withIt} · Honest payments passed: ${honest} · False blocks: ${blocks}`);
  });

  it("names the real anchor's contract, and the demo prints the real transaction", () => {
    expect(readme).toContain("wardy-agent-registry.testnet");
    expect(anchor.txUrl).toMatch(/^https:\/\/testnet\.near\.rocks\/tx\//);
  });

  it("publishes the misses, and doesn't claim what hasn't run", () => {
    expect(readme).toMatch(/attacks still took money/);
    expect(readme).toContain("offline verdicts never have the tick");
    expect(readme).toContain("These are small test amounts to our own account");
    expect(readme).toContain("It catches every attack");
  });

  it("meets the hackathon's rules: libraries, AI-written code, and where it was built", () => {
    expect(readme).toContain("Built at NEAR HACKATHON");
    expect(readme).toContain("Built with Claude Code");
    for (const library of ["@noble/ed25519", "fastify", "react", "motion", "near-api-js", "@modelcontextprotocol/sdk"]) expect(readme).toContain(library);
    expect(existsSync("LICENSE")).toBe(true);
  });

  it("every package the project uses directly is listed", () => {
    const manifests = ["package.json", ...["packages", "apps"].flatMap((dir) => readdirSync(dir).map((name) => join(dir, name, "package.json")))];
    const used = new Set<string>();
    for (const path of manifests) {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      for (const name of Object.keys({ ...manifest.dependencies, ...manifest.devDependencies })) used.add(name);
    }
    for (const name of used) {
      if (name.startsWith("@wardy-agent/") || name.startsWith("@types/")) continue;
      expect(readme.includes(name.startsWith("@fontsource-variable/") ? "@fontsource-variable" : name), name).toBe(true);
    }
  });
});

describe.each(DOCS)("%s", (path) => {
  const text = readFileSync(path, "utf8");

  it("every npm command in it exists", () => {
    for (const [, name] of text.matchAll(/npm run (?:--silent )?([a-z][\w:-]*)/g)) {
      expect(scripts[name as string], `npm run ${name}`).toBeDefined();
    }
  });

  it("every link to a file in this repo resolves", () => {
    for (const [, target] of text.matchAll(/\]\((?!https?:|#|mailto:)([^)#\s]+)(?:#[^)]*)?\)/g)) {
      expect(existsSync(resolve(dirname(path), target as string)), target).toBe(true);
    }
  });

  it("every in-page link has a heading to land on", () => {
    const anchors = new Set([...text.matchAll(/^#+ (.+)$/gm)].map(([, heading]) => (heading as string).toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s/g, "-")));
    for (const [, target] of text.matchAll(/\]\(#([^)]+)\)/g)) expect(anchors.has(target as string), target).toBe(true);
  });
});
