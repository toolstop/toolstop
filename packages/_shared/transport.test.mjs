import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetchHandler } from "./http.mjs";
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
    assert.equal(t.annotations.readOnlyHint, true, `${t.name} missing readOnlyHint`);
    assert.equal(t.inputSchema.type, "object");
  }
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
  // tools/list must record how many tools were exposed: the discovery signal.
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

test("session id is stable within a request and non-identifying", async () => {
  const { env, rows } = fakeEnv();
  const h = createFetchHandler(server);
  await call(h, env, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const sid = rows[0].blobs[11];
  assert.match(sid, /^[0-9a-f]{16}$/);
});
