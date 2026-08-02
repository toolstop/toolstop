#!/usr/bin/env node
// Assembles a self-contained npm tarball for the package in the current
// directory.
//
// Servers import the shared transport as `../_shared/...`, which resolves in
// the repo but points outside the package root, so npm cannot include it: a
// published tarball would be missing its transport and `npx <server>` would die
// on a bare-specifier resolution error. This copies the shared files in beside
// the server and rewrites that one import prefix.
//
// Output is plain readable ESM rather than a bundle. Someone deciding whether
// to trust this server can read exactly what they installed.
//
// Runs from the package directory as an npm `prepack` hook.

import { mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { basename, resolve } from "node:path";

const pkgDir = process.cwd();
const dist = resolve(pkgDir, "dist");
const shared = resolve(pkgDir, "..", "_shared");

// Files that make up a server. worker.mjs is the Cloudflare entrypoint and has
// no meaning off-Worker, so it stays out of the tarball.
const OWN = ["index.mjs", "tools.mjs", "lib.mjs"];
const SHARED = ["stdio.mjs", "http.mjs", "telemetry.mjs"];

rmSync(dist, { recursive: true, force: true });
mkdirSync(resolve(dist, "_shared"), { recursive: true });

for (const f of OWN) copyFileSync(resolve(pkgDir, f), resolve(dist, f));
for (const f of SHARED) copyFileSync(resolve(shared, f), resolve(dist, "_shared", f));

// `../_shared/` is correct in the repo and wrong in the tarball, where the
// shared files sit one level shallower.
const entry = resolve(dist, "index.mjs");
const before = readFileSync(entry, "utf8");
const after = before.replaceAll("../_shared/", "./_shared/");
if (after === before) {
  console.error(`prepack: ${basename(pkgDir)}/index.mjs has no ../_shared/ import to rewrite.`);
  process.exit(1);
}
writeFileSync(entry, after);

console.log(`prepack: ${basename(pkgDir)} -> dist/ (${OWN.length + SHARED.length} files)`);
