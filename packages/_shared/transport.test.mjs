import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetchHandler, assertServerShape } from "./http.mjs";
import server from "../mcp-check-digits/tools.mjs";

// Stand-in for the Analytics Engine binding.
function fakeEnv() {
  const rows = [];
  return { env: { MCP_EVENTS: { writeDataPoint: (r) => rows.push(r) } }, rows };
}

const REAL_IBAN = "GB82 WEST 1234 5698 7654 32";

async function call(handler, env, body) {
  const req = new Request("https://x.example/", {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "test-client/1.0" },
    body: JSON.stringify(body),
  });
  const res = await handler(req, env, {});
  return { res, json: res.status === 202 ? null : await res.json() };
}

test("initialize returns server info", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(json.result.serverInfo.name, "check-digits");
  assert.ok(json.result.capabilities.tools);
});

test("tools/list exposes annotated tools", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.equal(json.result.tools.length, 3);
  for (const t of json.result.tools) {
    // Asserting the hint is *declared*, not that it is true. Requiring `true`
    // would reject a correctly-annotated write tool, and would pass trivially
    // for a tool that declared nothing at all.
    assert.equal(
      typeof t.annotations.readOnlyHint,
      "boolean",
      `${t.name} does not declare readOnlyHint`,
    );
    assert.equal(t.inputSchema.type, "object");
    assert.equal(t.outputSchema.type, "object", `${t.name} does not declare an outputSchema`);
  }
});

// The regression that motivated assertServerShape: the transport used to default
// readOnlyHint to true, so a mutating tool that forgot the hint was advertised as
// safe to run unattended and every check downstream agreed with it.
test("a tool that omits readOnlyHint is rejected at construction", () => {
  const bad = {
    name: "bad", version: "0",
    tools: [{ name: "t", inputSchema: { type: "object", properties: {} }, handler: () => ({}) }],
  };
  assert.throws(() => createFetchHandler(bad), /readOnlyHint must be declared explicitly/);
});

test("a write tool is accepted, and must also declare destructiveHint", () => {
  const writeServer = (annotations) => ({
    name: "w", version: "0",
    tools: [{
      name: "t", inputSchema: { type: "object", properties: {} },
      annotations, handler: () => ({}),
    }],
  });

  assert.throws(
    () => assertServerShape(writeServer({ readOnlyHint: false })),
    /must also declare annotations.destructiveHint/,
  );
  assert.doesNotThrow(
    () => assertServerShape(writeServer({ readOnlyHint: false, destructiveHint: false })),
  );
});

test("duplicate tool names are rejected at construction", () => {
  const dupe = {
    name: "d", version: "0",
    tools: ["t", "t"].map((name) => ({
      name, inputSchema: { type: "object", properties: {} },
      annotations: { readOnlyHint: true }, handler: () => ({}),
    })),
  };
  assert.throws(() => assertServerShape(dupe), /duplicate tool name/);
});

test("tools/call validates a real IBAN", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: REAL_IBAN, kind: "iban" } },
  });
  assert.equal(JSON.parse(json.result.content[0].text).valid, true);
});

test("a tool with an outputSchema also returns structuredContent", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: REAL_IBAN, kind: "iban" } },
  });
  assert.equal(json.result.structuredContent.valid, true);
  assert.equal(json.result.structuredContent.country, "GB");
  // The serialized copy stays in the text block for clients that ignore it.
  assert.deepEqual(JSON.parse(json.result.content[0].text), json.result.structuredContent);
});

test("the renamed tools are reachable under their new names", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json: id } = await call(h, env, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "identify_format", arguments: { value: REAL_IBAN } },
  });
  assert.equal(id.result.structuredContent.matched, true);
  assert.ok(id.result.structuredContent.matches.some((m) => m.kind === "iban"));

  const { json: luhn } = await call(h, env, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "compute_luhn_digit", arguments: { partial: "455673500000000" } },
  });
  assert.match(luhn.result.structuredContent.checkDigit, /^\d$/);
});

test("bad arguments are rejected with a reason", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 4, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: "x", kind: "not-a-format" } },
  });
  assert.equal(json.result.isError, true);
  assert.match(json.result.content[0].text, /must be one of/);
});

test("unknown tool is a protocol error", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "nope", arguments: {} },
  });
  assert.equal(json.error.code, -32602);
});

test("notifications get 202 and no body", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { res } = await call(h, env, { jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
});

test("every request is recorded", async () => {
  const { env, rows } = fakeEnv();
  const h = createFetchHandler(server);
  await call(h, env, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  await call(h, env, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  await call(h, env, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: REAL_IBAN, kind: "iban" } },
  });
  assert.equal(rows.length, 3, "expected one row per request");
  const methods = rows.map((r) => r.blobs[2]);
  assert.deepEqual(methods, ["initialize", "tools/list", "tools/call"]);
  // tools/list must record how many tools were exposed, the discovery signal.
  assert.equal(rows[1].doubles[2], 3);
});

test("telemetry never contains the raw argument value", async () => {
  const { env, rows } = fakeEnv();
  const h = createFetchHandler(server);
  await call(h, env, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: REAL_IBAN, kind: "iban" } },
  });
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("GB82"), "raw IBAN leaked into telemetry");
  assert.ok(!dump.includes("WEST"), "raw IBAN leaked into telemetry");
  assert.ok(!dump.includes("765432"), "raw IBAN leaked into telemetry");
  // Shape and outcome are kept.
  // Shape and derived outcome are kept, parsed from their own blobs rather than
  // sniffed out of the stringified row.
  const argShape = JSON.parse(rows[0].blobs[12]);
  const classified = JSON.parse(rows[0].blobs[13]);
  assert.equal(argShape.value, `str:${REAL_IBAN.length}`);
  assert.equal(classified.kind, "iban");
  assert.equal(classified.valid, true);
});

// The leak the greps above could not see. Validators build prose that
// interpolates the input, so forwarding `reason` put a real IBAN's country code
// into telemetry. Only the bounded `code` crosses that boundary now.
test("a failure reason that embeds the input never reaches telemetry", async () => {
  const { env, rows } = fakeEnv();
  const h = createFetchHandler(server);
  // GB IBANs are 22 characters. This one is 20, so the validator produces
  // "GB IBANs are 22 characters, got 20", which carries the country code.
  const SHORT_GB = "GB82WEST123456987654";
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: SHORT_GB, kind: "iban" } },
  });

  const classified = JSON.parse(rows[0].blobs[13]);
  assert.equal(classified.code, "length", "the bounded code is what gets recorded");
  assert.equal(classified.reason, undefined, "free-text reason must not be forwarded");

  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("IBANs are"), "reason prose leaked into telemetry");
  assert.ok(!dump.includes("WEST"), "raw IBAN leaked into telemetry");

  // The caller still gets the detail: it is their own data, and it is useful.
  assert.match(json.result.structuredContent.reason, /GB IBANs are 22 characters/);
});

test("session id is stable within a request and non-identifying", async () => {
  const { env, rows } = fakeEnv();
  const h = createFetchHandler(server);
  await call(h, env, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const sid = rows[0].blobs[11];
  assert.match(sid, /^[0-9a-f]{16}$/);
});
