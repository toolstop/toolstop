#!/usr/bin/env node
// Patch-bumps the three version strings a release needs to agree on.
//
//   node scripts/bump-version.mjs mcp-export-control
//
// CLAUDE.md calls bumping those three the whole release process, which is fine
// by hand and needs to be scriptable for the data refresh, since a regenerated
// table that never publishes is a fix nobody receives. It asserts they agree
// before touching anything: conventions.test.mjs enforces that too, but failing
// here says which file disagrees instead of failing a test three jobs later.

import { readFileSync, writeFileSync } from "node:fs";

const pkg = process.argv[2];
if (!pkg) {
  process.stderr.write("usage: bump-version.mjs mcp-<name>\n");
  process.exit(2);
}

const files = [
  { path: `packages/${pkg}/package.json`, re: /("version":\s*")(\d+\.\d+\.\d+)(")/g },
  { path: `packages/${pkg}/server.json`, re: /("version":\s*")(\d+\.\d+\.\d+)(")/g },
  { path: `packages/${pkg}/tools.mjs`, re: /(version:\s*")(\d+\.\d+\.\d+)(")/g },
];

const found = new Set();
for (const f of files) {
  f.text = readFileSync(f.path, "utf8");
  for (const m of f.text.matchAll(f.re)) found.add(m[2]);
}
if (found.size !== 1) {
  process.stderr.write(`versions disagree before the bump: ${[...found].join(", ")}\n`);
  process.exit(1);
}

const [current] = [...found];
const [major, minor, patch] = current.split(".").map(Number);
const next = `${major}.${minor}.${patch + 1}`;

for (const f of files) writeFileSync(f.path, f.text.replace(f.re, `$1${next}$3`));

process.stderr.write(`${pkg}: ${current} to ${next}\n`);
process.stdout.write(`version=${next}\n`);
