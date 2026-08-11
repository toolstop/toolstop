import { test } from "node:test";
import assert from "node:assert/strict";
import { createFetchHandler, assertServerShape } from "./http.mjs";
import { networkOf, sessionIdFrom } from "./telemetry.mjs";
import server from "../mcp-check-digits/tools.mjs";

// Stand-in for the Analytics Engine binding.
function fakeEnv() {
  const rows = [];
  return { env: { MCP_EVENTS: { writeDataPoint: (r) => rows.push(r) } }, rows };
}

// Apple's published LEI. A real identifier, so the no-leak assertions below are
// testing the real thing, but a public one: clause F6 means no sensitive value
// is ever sent to this server, including from its own test suite.
const REAL_LEI = "HWUPKR0MPOU8FGXBT394";

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

test("tools/call validates a real LEI", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: REAL_LEI, kind: "lei" } },
  });
  assert.equal(JSON.parse(json.result.content[0].text).valid, true);
});

test("a tool with an outputSchema also returns structuredContent", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 3, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: REAL_LEI, kind: "lei" } },
  });
  assert.equal(json.result.structuredContent.valid, true);
  assert.equal(json.result.structuredContent.normalized, REAL_LEI);
  // The serialized copy stays in the text block for clients that ignore it.
  assert.deepEqual(JSON.parse(json.result.content[0].text), json.result.structuredContent);
});

test("the renamed tools are reachable under their new names", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const { json: id } = await call(h, env, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "identify_format", arguments: { value: REAL_LEI } },
  });
  assert.equal(id.result.structuredContent.matched, true);
  assert.ok(id.result.structuredContent.matches.some((m) => m.kind === "lei"));

  const { json: luhn } = await call(h, env, {
    jsonrpc: "2.0", id: 2, method: "tools/call",
    params: { name: "compute_luhn_digit", arguments: { partial: "455673500000000" } },
  });
  assert.match(luhn.result.structuredContent.checkDigit, /^\d$/);
});

// identify() builds matches as { kind, ...r }, so any validator returning its own
// `kind` silently overwrites the format key. validateGtin did, reporting "EAN-13"
// where the declared enum allows only "gtin". That broke the outputSchema
// contract and meant the returned kind could not be fed back to
// validate_identifier, so the two tools did not compose.
test("identify_format always reports a kind validate_identifier accepts", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const validateKinds = new Set(
    server.tools.find((t) => t.name === "validate_identifier").inputSchema.properties.kind.enum,
  );

  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "identify_format", arguments: { value: "4006381333931" } },  // valid EAN-13
  });
  const matches = json.result.structuredContent.matches;
  assert.ok(matches.length > 0, "expected the EAN-13 to match something");
  for (const m of matches) {
    assert.ok(validateKinds.has(m.kind), `kind "${m.kind}" is not accepted by validate_identifier`);
  }
  assert.ok(matches.some((m) => m.kind === "gtin"), "expected the gtin format key, not its width");

  // The width is still reported, just under a name that cannot collide.
  const gtin = matches.find((m) => m.kind === "gtin");
  assert.equal(gtin.width, "EAN-13");
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

// --------------------------------------------------------------- GET routing
//
// These exist because every GET used to answer 405 regardless of path, which
// made three different questions indistinguishable: "open me an SSE stream",
// "what is this URL", and "do you require OAuth". Only the first has 405 as its
// correct answer.

async function get(handler, env, path, headers = {}) {
  const req = new Request(`https://x.example${path}`, { method: "GET", headers });
  return handler(req, env, {});
}

test("a browser GET on the MCP endpoint gets a readable page, not an error", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const res = await get(h, env, "/", { accept: "text/html" });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/html/);
  const body = await res.text();
  assert.match(body, new RegExp(server.name));
  // The page has to name the tools, or it says nothing a directory or a human
  // could not have guessed from the hostname.
  for (const t of server.tools) assert.match(body, new RegExp(t.name));
});

test("a GET asking for an event stream still gets 405, per the transport spec", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const res = await get(h, env, "/", { accept: "text/event-stream" });
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("an unknown path is 404, so auth discovery reads as 'no OAuth required'", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/robots.txt",
    "/wp-admin/install.php",
  ]) {
    const res = await get(h, env, path);
    assert.equal(res.status, 404, `${path} should be 404, got ${res.status}`);
  }
});

test("glama.json is served, and in the connector shape rather than the repo one", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const res = await get(h, env, "/.well-known/glama.json");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /application\/json/);

  const body = await res.json();
  assert.equal(body.$schema, "https://glama.ai/mcp/schemas/connector.json");
  // The failure this guards is silent on the wire: Glama's repo-root schema
  // takes bare GitHub usernames and the connector schema takes objects with an
  // `email`, so the wrong shape serves 200, validates against nothing, and
  // leaves the connector unclaimed with no error anywhere to notice.
  assert.ok(Array.isArray(body.maintainers) && body.maintainers.length > 0);
  for (const m of body.maintainers) {
    assert.equal(typeof m, "object", "maintainers must be objects, not usernames");
    assert.match(m.email, /^[^@\s]+@[^@\s]+\.[^@\s]+$/);
  }
});

test("health still answers, and HEAD is routed like GET", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  assert.equal((await get(h, env, "/health")).status, 200);

  const head = await h(new Request("https://x.example/", { method: "HEAD" }), env, {});
  assert.equal(head.status, 200);
});

test("a method that is neither read nor POST is still 405", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler(server);
  const res = await h(new Request("https://x.example/", { method: "DELETE" }), env, {});
  assert.equal(res.status, 405);
  assert.equal(res.headers.get("allow"), "POST");
});

test("the landing page escapes server-supplied text", async () => {
  const { env } = fakeEnv();
  const h = createFetchHandler({
    ...server,
    tools: [{ ...server.tools[0], title: '<script>alert(1)</script>' }],
  });
  const body = await (await get(h, env, "/")).text();
  assert.ok(!body.includes("<script>alert(1)</script>"));
  assert.match(body, /&lt;script&gt;/);
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
    params: { name: "validate_identifier", arguments: { value: REAL_LEI, kind: "lei" } },
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
    params: { name: "validate_identifier", arguments: { value: REAL_LEI, kind: "lei" } },
  });
  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("HWUPKR"), "raw identifier leaked into telemetry");
  assert.ok(!dump.includes("FGXBT"), "raw identifier leaked into telemetry");
  assert.ok(!dump.includes("T394"), "raw identifier leaked into telemetry");
  // Shape and outcome are kept.
  // Shape and derived outcome are kept, parsed from their own blobs rather than
  // sniffed out of the stringified row.
  const argShape = JSON.parse(rows[0].blobs[12]);
  const classified = JSON.parse(rows[0].blobs[13]);
  assert.equal(argShape.value, `str:${REAL_LEI.length}`);
  assert.equal(classified.kind, "lei");
  assert.equal(classified.valid, true);
});

// The leak the greps above could not see. Validators build prose that
// interpolates the input, so forwarding `reason` put a substring derived from a
// real identifier into telemetry. Only the bounded `code` crosses that boundary.
//
// The original fixture was a short GB IBAN, whose reason carried the country
// code. IBAN is gone under F6, so the guard now rides on VIN, which is the
// remaining validator whose failure path is built from the input: the reason
// interpolates the expected check digit, and the result carries the character
// the VIN actually holds at position 9.
test("a failure reason that embeds the input never reaches telemetry", async () => {
  const { env, rows } = fakeEnv();
  const h = createFetchHandler(server);
  // One digit off a real VIN, so the check digit disagrees and the validator
  // produces "check digit at position 9 should be 1".
  const BAD_VIN = "1HGCM82634A004352";
  const { json } = await call(h, env, {
    jsonrpc: "2.0", id: 1, method: "tools/call",
    params: { name: "validate_identifier", arguments: { value: BAD_VIN, kind: "vin" } },
  });

  const classified = JSON.parse(rows[0].blobs[13]);
  assert.equal(classified.code, "checksum", "the bounded code is what gets recorded");
  assert.equal(classified.reason, undefined, "free-text reason must not be forwarded");

  const dump = JSON.stringify(rows);
  assert.ok(!dump.includes("check digit at position"), "reason prose leaked into telemetry");
  assert.ok(!dump.includes("HGCM"), "raw identifier leaked into telemetry");
  assert.ok(!dump.includes("expectedCheckDigit"), "derived input characters leaked into telemetry");

  // The caller still gets the detail: it is their own data, and it is useful.
  assert.match(json.result.structuredContent.reason, /check digit at position 9 should be 1/);
});

test("session id is stable within a request and non-identifying", async () => {
  const { env, rows } = fakeEnv();
  const h = createFetchHandler(server);
  await call(h, env, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  const sid = rows[0].blobs[11];
  assert.match(sid, /^[0-9a-f]{16}$/);
});

// A session id is written to Analytics Engine on every request. It used to be
// derived from the full client IP, which an 8-byte hash does not hide: the
// address space is 32 bits and the other inputs are public. These assert the
// truncation that fixes it, because the property is invisible in the output.

test("the session id is derived from a network, never a whole address", () => {
  assert.equal(networkOf("203.0.113.47"), "203.0.113.0/24");
  assert.equal(networkOf("203.0.113.201"), "203.0.113.0/24");
  assert.equal(networkOf("2001:db8:1:2:3:4:5:6"), "2001:db8:1::/48");
});

test("one IPv6 network has one representation, however it is spelled", () => {
  // Slicing the raw string got this wrong: it produced `2001:db8:::/48`, and
  // split equivalent spellings across two sessions.
  const expected = "2001:db8:0::/48";
  for (const spelling of ["2001:db8::1", "2001:0db8:0000:0000:0000:0000:0000:0001", "2001:DB8::1"]) {
    assert.equal(networkOf(spelling), expected, `disagreed on ${spelling}`);
  }
});

test("a malformed or absent address yields nothing, never a passthrough", () => {
  // Failing open here would put the raw value straight back into the hash.
  const bad = ["", null, undefined, "not-an-ip", "1.2.3", "1.2.3.4.5", "999.1.1.1", "1:2:3:4:5:6:7:8:9", "zzzz::1"];
  for (const b of bad) {
    assert.equal(networkOf(b), "", `leaked on ${JSON.stringify(b)}`);
  }
});

test("two callers in one /24 share a session id; different /24s do not", async () => {
  const req = (ip) =>
    new Request("https://x.example/", { headers: { "cf-connecting-ip": ip, "user-agent": "ua/1" } });
  const [a, b, c] = await Promise.all([
    sessionIdFrom(req("203.0.113.47"), "s"),
    sessionIdFrom(req("203.0.113.201"), "s"),
    sessionIdFrom(req("198.51.100.47"), "s"),
  ]);
  assert.equal(a, b, "same network must collapse to one session");
  assert.notEqual(a, c, "different networks must stay distinct");
});

test("no part of a client address survives into the session id", async () => {
  const ip = "203.0.113.47";
  const id = await sessionIdFrom(
    new Request("https://x.example/", { headers: { "cf-connecting-ip": ip, "user-agent": "ua/1" } }),
    "s",
  );
  assert.ok(!id.includes("203"), "octet leaked into the id");
  assert.match(id, /^[0-9a-f]{16}$/, "id must be an opaque 8-byte digest");
});
