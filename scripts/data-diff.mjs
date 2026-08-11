#!/usr/bin/env node
// Compares a package's regenerated data.mjs against the committed one and says
// what moved, in markdown, for the refresh PR body.
//
//   node scripts/data-diff.mjs mcp-export-control
//
// Writes `changed=true|false` in GitHub Actions output format on stdout, the
// way discover.mjs does, and the summary on stderr.
//
// It ignores SOURCE_EDITION deliberately. Upstream reissues a title whenever any
// part of it is amended, so the edition string moves far more often than these
// tables do, and a PR that changes one date every week is noise that trains you
// to merge without reading. When the tables do move, the new edition rides along
// with them and the label is accurate again.

import { execFileSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const pkg = process.argv[2];
if (!pkg) {
  process.stderr.write("usage: data-diff.mjs mcp-<name>\n");
  process.exit(2);
}
const path = `packages/${pkg}/data.mjs`;

// The committed version has to be loaded from a file rather than a data: URL,
// because relative imports inside it would not resolve.
const dir = mkdtempSync(join(tmpdir(), "data-diff-"));
const before = join(dir, "before.mjs");
writeFileSync(before, execFileSync("git", ["show", `HEAD:${path}`], { encoding: "utf8", maxBuffer: 64 << 20 }));

const [old, now] = await Promise.all([
  import(`file://${before}`),
  import(`file://${process.cwd()}/${path}`),
]);

const isTable = (v) => v && typeof v === "object" && !Array.isArray(v);
const lines = [];
let changed = false;

for (const name of new Set([...Object.keys(old), ...Object.keys(now)])) {
  if (name === "SOURCE_EDITION" || name === "default") continue;
  const a = old[name];
  const b = now[name];

  if (!isTable(a) || !isTable(b)) {
    if (JSON.stringify(a) !== JSON.stringify(b)) {
      changed = true;
      lines.push(`- \`${name}\`: ${JSON.stringify(a)} to ${JSON.stringify(b)}`);
    }
    continue;
  }

  const added = Object.keys(b).filter((k) => !(k in a));
  const removed = Object.keys(a).filter((k) => !(k in b));
  const edited = Object.keys(b).filter((k) => k in a && JSON.stringify(a[k]) !== JSON.stringify(b[k]));
  if (!added.length && !removed.length && !edited.length) continue;

  changed = true;
  lines.push(`\n**${name}**: ${added.length} added, ${removed.length} removed, ${edited.length} amended`);
  if (added.length) lines.push(`- added: ${added.slice(0, 30).join(", ")}${added.length > 30 ? ", ..." : ""}`);
  if (removed.length) lines.push(`- removed: ${removed.slice(0, 30).join(", ")}${removed.length > 30 ? ", ..." : ""}`);
  if (edited.length) lines.push(`- amended: ${edited.slice(0, 30).join(", ")}${edited.length > 30 ? ", ..." : ""}`);
}

if (old.SOURCE_EDITION !== now.SOURCE_EDITION) {
  lines.unshift(`Edition ${old.SOURCE_EDITION} to **${now.SOURCE_EDITION}**.`);
}

process.stderr.write(lines.length ? `${lines.join("\n")}\n` : "no change\n");
process.stdout.write(`changed=${changed}\n`);
process.stdout.write(`summary<<EOF\n${lines.join("\n") || "No change."}\nEOF\n`);
