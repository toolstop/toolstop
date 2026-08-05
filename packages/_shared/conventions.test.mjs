// Portfolio-wide tool conventions, asserted against every server on disk.
//
// This walks packages/mcp-*/ the same way discover.mjs does, so a new server is
// covered the moment it exists and nobody has to remember to register it. That
// matters more than it sounds: transport.test.mjs imports check-digits by name,
// so before this file a second server had no shape coverage at all until it
// deployed. The readOnlyHint bug this repo just fixed was exactly the kind that
// hides until server #2.
//
// assertServerShape enforces what breaks a client. This file enforces what makes
// a tool findable and honest, which is softer but is where the real defects are:
// a survey of 856 tools across 103 MCP servers (arXiv 2602.14878) found 97.1%
// had at least one description defect, official servers included.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { assertServerShape } from "./http.mjs";

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const packageNames = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("mcp-"))
  .map((d) => d.name)
  .filter((name) => existsSync(join(PACKAGES_DIR, name, "tools.mjs")))
  .sort();

const servers = await Promise.all(
  packageNames.map(async (name) => ({
    package: name,
    server: (await import(pathToFileURL(join(PACKAGES_DIR, name, "tools.mjs")).href)).default,
  })),
);

// Clients namespace as mcp__<server>__<tool> against a hard 64-character cap in
// the Anthropic API. An OAuth-connector prefix is `mcp__` + a 36-char UUID +
// `__` = 43, which leaves 21. A longer name works locally and fails on a
// directory install, which is the only distribution path this project tests.
const MAX_TOOL_NAME = 21;

// Deliberately an allowlist. Adding a verb should be a decision someone makes
// once, not something that drifts in one tool at a time.
const VERBS = new Set([
  "check", "compute", "convert", "count", "create", "decode", "delete", "describe",
  "encode", "explain", "fetch", "format", "generate", "get", "identify", "list",
  "lookup", "normalize", "parse", "read", "remove", "resolve", "search", "send",
  "set", "update", "validate", "verify", "write",
]);

// Proxies for the two description defects that actually mislead an agent: not
// saying what comes back, and not saying where the tool stops.
//
// These are heuristics and will occasionally be wrong in both directions. They
// live in a test rather than a lint gate precisely so the fix for a false
// positive is to read the sentence and widen the pattern, not to add an ignore
// comment. "not that the identifier is registered" is why `not that` is here:
// the limit can be phrased with the negation trailing the verb.
const SAYS_WHAT_IT_RETURNS = /\breturns?\b|\breports?\b|\breporting\b/i;
const STATES_A_LIMIT =
  /\b(does not|do not|cannot|can not|is not|are not|not that|rather than|never|only)\b|\bnot\b[^.]*\b(mean|prove|guarantee|create|verify|exist)\b/i;

test("at least one server is present to check", () => {
  assert.ok(servers.length > 0, "found no packages/mcp-*/tools.mjs to validate");
});

for (const { package: pkg, server } of servers) {
  test(`${pkg}: server shape is valid`, () => {
    assert.doesNotThrow(() => assertServerShape(server));
    assert.ok(server.name, "server has no name");
    assert.ok(server.version, "server has no version");
  });

  for (const tool of server.tools) {
    test(`${pkg}: ${tool.name} follows the naming convention`, () => {
      assert.match(tool.name, /^[a-z][a-z0-9_]*$/, "tool names are lower snake_case");
      assert.ok(
        tool.name.length <= MAX_TOOL_NAME,
        `${tool.name} is ${tool.name.length} chars; over ${MAX_TOOL_NAME} breaks OAuth-connector installs`,
      );
      const verb = tool.name.split("_")[0];
      assert.ok(
        VERBS.has(verb),
        `"${verb}" is not a known leading verb. Tool names go verb first; if "${verb}" is a legitimate verb, add it to VERBS in this file.`,
      );
    });

    test(`${pkg}: ${tool.name} is described well enough to choose`, () => {
      assert.ok(tool.title, "tool has no title");
      assert.notEqual(tool.title, tool.name, "title is for humans and should not repeat name");
      assert.ok(
        tool.description.length >= 200,
        `description is ${tool.description.length} chars; aim for 3-4 sentences`,
      );
      assert.match(
        tool.description,
        SAYS_WHAT_IT_RETURNS,
        "description never says what the tool returns",
      );
      assert.match(
        tool.description,
        STATES_A_LIMIT,
        "description states no limitation. Say what a result does not mean, which is the defect most likely to make an agent mislead a user.",
      );
    });

    test(`${pkg}: ${tool.name} declares complete schemas`, () => {
      assert.equal(tool.outputSchema?.type, "object", "tool declares no outputSchema");
      for (const [key, spec] of Object.entries(tool.inputSchema.properties ?? {})) {
        assert.ok(spec.description, `input property "${key}" has no description`);
        if (spec.type === "string" && !spec.enum) {
          assert.ok(spec.maxLength, `string property "${key}" has no maxLength`);
        }
      }
    });
  }
}

test("tool names are unique across the whole portfolio", () => {
  const seen = new Map();
  for (const { package: pkg, server } of servers) {
    for (const tool of server.tools) {
      // A user can install several toolstop servers at once, so a collision is
      // a real ambiguity for the agent even though each server is valid alone.
      assert.ok(
        !seen.has(tool.name),
        `${tool.name} is defined by both ${seen.get(tool.name)} and ${pkg}`,
      );
      seen.set(tool.name, pkg);
    }
  }
});
