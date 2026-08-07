// stdio.mjs, executed as a real child process.
//
// This transport had no coverage at all: it appeared in no import in the suite
// and so in no coverage report either. It is also the transport behind the npm
// `bin`, which is one of the two distribution paths this project advertises, so
// the untested code was the code strangers run on their own machines.
//
// Everything here spawns packages/<pkg>/index.mjs rather than importing
// runStdio, because the parts that were never covered are exactly the parts an
// import cannot reach: line framing across chunk boundaries, the malformed-line
// skip, and the notification path that must write nothing at all.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { openStdioServer } from "../../scripts/lib/stdio-client.mjs";

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), "..");

const packageNames = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.startsWith("mcp-"))
  .map((d) => d.name)
  .filter((name) => existsSync(join(PACKAGES_DIR, name, "index.mjs")))
  .sort();

const packages = await Promise.all(
  packageNames.map(async (name) => ({
    name,
    entry: join(PACKAGES_DIR, name, "index.mjs"),
    server: (await import(pathToFileURL(join(PACKAGES_DIR, name, "tools.mjs")).href)).default,
  })),
);

const open = (entry) => openStdioServer(process.execPath, [entry]);

test("at least one stdio entrypoint is present to drive", () => {
  assert.ok(packages.length > 0, "found no packages/mcp-*/index.mjs to run");
});

for (const { name, entry, server } of packages) {
  test(`${name}: initialize over stdio agrees with the server definition`, async (t) => {
    const client = open(entry);
    t.after(() => client.close());

    const { result } = await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    assert.equal(result.serverInfo.name, server.name);
    // The version the stdio artifact reports is the one a user sees in their
    // client, and it is the field this repo has twice let drift.
    assert.equal(result.serverInfo.version, server.version);
    assert.ok(result.capabilities.tools);
  });

  test(`${name}: tools/list over stdio exposes the same tools as HTTP`, async (t) => {
    const client = open(entry);
    t.after(() => client.close());

    const { result } = await client.request({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    assert.deepEqual(
      result.tools.map((tool) => tool.name).sort(),
      server.tools.map((tool) => tool.name).sort(),
      "the stdio transport exposes a different tool set than the definition",
    );
    for (const tool of result.tools) {
      assert.equal(typeof tool.annotations.readOnlyHint, "boolean");
    }
    // Test-only metadata must not ride along to the client.
    assert.ok(
      !JSON.stringify(result.tools).includes("examples"),
      "examples leaked into tools/list, which pays for test fixtures on every wire response",
    );
  });

  test(`${name}: every tool answers its own examples over stdio`, async (t) => {
    const client = open(entry);
    t.after(() => client.close());

    let id = 0;
    for (const tool of server.tools) {
      for (const example of tool.examples ?? []) {
        const { result } = await client.request({
          jsonrpc: "2.0",
          id: ++id,
          method: "tools/call",
          params: { name: tool.name, arguments: example.args },
        });
        assert.notEqual(result.isError, true, `${tool.name} errored: ${result.content?.[0]?.text}`);
        for (const [key, want] of Object.entries(example.expect ?? {})) {
          assert.deepEqual(result.structuredContent?.[key], want, `${tool.name}: ${key} mismatch`);
        }
      }
    }
    assert.ok(id > 0, "no examples were exercised");
  });

  test(`${name}: a notification is answered with silence, not a reply`, async (t) => {
    const client = open(entry);
    t.after(() => client.close());

    await client.notify({ jsonrpc: "2.0", method: "notifications/initialized" });
    // No sleep: stdin is processed in order, so once the ping is answered any
    // reply to the notification would already have been written.
    const { result } = await client.request({ jsonrpc: "2.0", id: 7, method: "ping" });
    assert.deepEqual(result, {});
    assert.equal(client.lines.length, 1, `expected only the ping reply, got: ${client.lines.join(" | ")}`);
  });

  test(`${name}: a malformed line is skipped without killing the server`, async (t) => {
    const client = open(entry);
    t.after(() => client.close());

    // Two ways a line can be unusable: not JSON at all, and JSON that is not a
    // message. Both must be dropped rather than crashing the process, because a
    // crash here takes down a long-lived desktop client session.
    await client.writeRaw("this is not json\n");
    await client.writeRaw("\n");
    const { result } = await client.request({ jsonrpc: "2.0", id: 1, method: "ping" });
    assert.deepEqual(result, {});
  });

  test(`${name}: framing survives batched and split writes`, async (t) => {
    const client = open(entry);
    t.after(() => client.close());

    // Two complete messages in one write. The reader has to keep consuming after
    // the first newline instead of treating a chunk as one message.
    const first = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    const second = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const firstReply = client.awaitReply(1, "(ping)");
    const secondReply = client.awaitReply(2, "(tools/list)");
    await client.writeRaw(`${first}\n${second}\n`);
    assert.deepEqual((await firstReply).result, {});
    assert.ok((await secondReply).result.tools.length > 0, "the second message in a chunk was dropped");

    // One message split across two writes, which is what a pipe does under load.
    // The buffer has to hold the fragment rather than parsing it.
    const whole = JSON.stringify({ jsonrpc: "2.0", id: 3, method: "initialize", params: {} });
    const split = Math.floor(whole.length / 2);
    const reply = client.awaitReply(3, "(initialize)");
    await client.writeRaw(whole.slice(0, split));
    await client.writeRaw(whole.slice(split) + "\n");
    assert.equal((await reply).result.serverInfo.name, server.name, "a split message was lost");
  });

  test(`${name}: stdout carries protocol and nothing else`, async (t) => {
    const client = open(entry);
    t.after(() => client.close());

    // A stray console.log on stdout corrupts the stream and the client sees a
    // parse error rather than a log line, which is a genuinely hard failure to
    // diagnose from the far end.
    await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    await client.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    for (const line of client.lines) {
      assert.doesNotThrow(() => JSON.parse(line), `non-JSON on stdout: ${line}`);
    }
  });
}
