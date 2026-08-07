// Every tool of every server on disk, called for real through the transport.
//
// transport.test.mjs imports check-digits by name and calls its three tools by
// name, which means it proves nothing about server #2: that server could ship
// with a handler that throws on first call and CI would stay green, because its
// own test.mjs tests the library underneath the tools rather than the tools.
// This file closes that by walking packages/mcp-*/ the way discover.mjs and
// conventions.test.mjs do, and driving whatever it finds.
//
// The contract a new server has to meet is one field: `examples` on each tool.
// conventions.test.mjs makes that mandatory, so a tool cannot exist without the
// input needed to call it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createFetchHandler, validate } from "./http.mjs";

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

// Stand-in for the Analytics Engine binding. Every call goes through it, so a
// classify() that throws on some input fails here rather than in production,
// where recordEvent runs after the handler has already succeeded.
function fakeEnv() {
  const rows = [];
  return { env: { MCP_EVENTS: { writeDataPoint: (r) => rows.push(r) } }, rows };
}

async function callTool(handler, env, name, args, id = 1) {
  const req = new Request("https://x.example/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
  });
  const res = await handler(req, env, {});
  return res.json();
}

// Subset semantics: every key the example names must match, and anything else
// the tool returns is allowed. An example that pinned the whole payload would
// have to be rewritten every time a field was added, which is how fixtures stop
// being maintained and start being deleted.
function assertSubset(actual, expected, path = "result") {
  for (const [key, want] of Object.entries(expected)) {
    const got = actual?.[key];
    const where = `${path}.${key}`;
    if (want !== null && typeof want === "object" && !Array.isArray(want)) {
      assert.ok(got !== null && typeof got === "object", `${where} should be an object, got ${got}`);
      assertSubset(got, want, where);
    } else {
      assert.deepEqual(got, want, `${where} did not match the declared example`);
    }
  }
}

for (const { package: pkg, server } of servers) {
  const handler = createFetchHandler(server);

  for (const tool of server.tools) {
    for (const [i, example] of (tool.examples ?? []).entries()) {
      test(`${pkg}: ${tool.name} example ${i} returns what it claims`, async () => {
        const { env } = fakeEnv();
        const json = await callTool(handler, env, tool.name, example.args);

        assert.ok(json.result, `expected a result, got ${JSON.stringify(json.error)}`);
        assert.notEqual(
          json.result.isError,
          true,
          `tool errored: ${json.result.content?.[0]?.text}`,
        );
        assert.ok(json.result.content?.[0]?.text, "tool returned no content block");

        if (tool.outputSchema) {
          const structured = json.result.structuredContent;
          assert.ok(structured, "tool declares an outputSchema but returned no structuredContent");
          // The same validator the transport applies to inputs, pointed at the
          // output. A tool that advertises a schema and then violates it is
          // lying to every client that reads the schema.
          const errors = validate(tool.outputSchema, structured);
          assert.deepEqual(errors, [], `result violates the declared outputSchema: ${errors.join("; ")}`);
        }

        if (example.expect) assertSubset(json.result.structuredContent, example.expect);
      });
    }
  }

  // The telemetry path runs after a successful handler, so a classify() that
  // throws on an input the handler accepted would surface only in production.
  test(`${pkg}: every example is recorded without leaking its arguments`, async () => {
    const { env, rows } = fakeEnv();
    const values = [];
    let id = 0;
    for (const tool of server.tools) {
      for (const example of tool.examples ?? []) {
        await callTool(handler, env, tool.name, example.args, ++id);
        values.push(...Object.values(example.args).filter((v) => typeof v === "string" && v.length >= 6));
      }
    }
    assert.equal(rows.length, id, "expected one telemetry row per call");

    // Portfolio-wide privacy boundary: no argument the caller sent may appear in
    // a row. transport.test.mjs asserts this for hand-picked substrings of one
    // identifier; this asserts it for every example of every server.
    const dump = JSON.stringify(rows);
    for (const value of values) {
      assert.ok(!dump.includes(value), `raw argument "${value}" leaked into telemetry`);
    }
  });
}
