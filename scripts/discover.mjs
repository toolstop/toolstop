#!/usr/bin/env node
// Emits GitHub Actions outputs: every package, the subset whose files changed
// in this push, and the subset that embeds regenerable data. Adding a server
// requires no workflow edit: the matrix is derived from the filesystem.

import { readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const all = readdirSync("packages", { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("mcp-"))
  .map((d) => d.name)
  .filter((name) => existsSync(`packages/${name}/wrangler.toml`))
  .sort();

const only = process.env.ONLY_PACKAGE?.trim();

let changed;
if (only) {
  changed = all.includes(only) ? [only] : [];
} else {
  let diff = "";
  try {
    diff = execSync("git diff --name-only HEAD~1 HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    // Shallow clone or first commit: fall back to deploying everything.
    diff = "";
  }
  const touched = new Set(
    diff.split("\n").map((f) => f.match(/^packages\/(mcp-[^/]+)\//)?.[1]).filter(Boolean),
  );
  // A change under packages/_shared/ affects every server.
  const sharedTouched = /^packages\/_shared\//m.test(diff);
  changed = sharedTouched || diff === "" ? all : all.filter((p) => touched.has(p));
}

// A server embeds regenerable data when it ships a generator. The name is the
// contract: scripts/gen-<name>.mjs regenerates packages/mcp-<name>/data.mjs, so
// the refresh workflow needs no list of its own either.
const generators = all.filter((name) => existsSync(`scripts/gen-${name.replace(/^mcp-/, "")}.mjs`));

console.log(`packages=${JSON.stringify(all)}`);
console.log(`changed=${JSON.stringify(changed)}`);
console.log(`generators=${JSON.stringify(generators)}`);
