#!/usr/bin/env node
// Post-deploy check against the live endpoint. A deploy that succeeds but serves
// a broken protocol is worse than one that fails loudly.

import { readFileSync } from "node:fs";

// Accepts either a full URL, or a package name whose hostname is read from its
// wrangler.toml. The latter keeps the hostname declared in exactly one place —
// CI never reconstructs it from parts.
function resolveBase(arg) {
  if (!arg) return null;
  if (/^https?:\/\//.test(arg)) return arg.replace(/\/$/, "");
  let meta;
  try {
    meta = JSON.parse(readFileSync(`packages/${arg}/server.json`, "utf8"));
  } catch {
    console.error(`No packages/${arg}/server.json — pass a package name or a URL.`);
    process.exit(2);
  }
  if (!meta.hostname) {
    console.error(`packages/${arg}/server.json has no "hostname".`);
    process.exit(2);
  }
  return `https://${meta.hostname}`;
}

const base = resolveBase(process.argv[2]);
if (!base) {
  console.error("usage: smoke.mjs <package-name | base-url>");
  process.exit(2);
}
console.log(`testing ${base}\n`);

const rpc = async (body) => {
  const res = await fetch(base, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok && res.status !== 202) throw new Error(`HTTP ${res.status} from ${base}`);
  return res.status === 202 ? null : res.json();
};

const fail = (msg) => {
  console.error(`FAIL  ${msg}`);
  process.exit(1);
};

const health = await fetch(`${base}/health`).then((r) => r.json());
if (!health.ok) fail("health endpoint did not report ok");
console.log(`ok    health: ${health.server} v${health.version}`);

const init = await rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
if (!init?.result?.serverInfo?.name) fail("initialize returned no serverInfo");
console.log(`ok    initialize: ${init.result.serverInfo.name}`);

const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
const tools = list?.result?.tools ?? [];
if (tools.length === 0) fail("tools/list returned no tools");
// This checks the wire, so it is the only gate that sees what a client actually
// receives. It used to read back a value the transport had just defaulted, which
// meant it could not fail; the transport no longer defaults readOnlyHint, so
// these assertions are now load-bearing.
for (const t of tools) {
  if (!t.inputSchema) fail(`tool ${t.name} has no inputSchema; directory review will reject it`);
  if (typeof t.annotations?.readOnlyHint !== "boolean") {
    fail(`tool ${t.name} does not declare readOnlyHint, so clients cannot tell if it is safe to auto-approve`);
  }
  if (t.annotations.readOnlyHint === false && typeof t.annotations.destructiveHint !== "boolean") {
    fail(`tool ${t.name} is not read-only but does not declare destructiveHint`);
  }
  // Clients namespace as mcp__<server>__<tool> against a hard 64-char limit. An
  // OAuth-connector prefix is `mcp__` + a 36-char UUID + `__` = 43, so a name
  // over 21 characters can be unusable through a directory install even though
  // it works fine locally.
  if (t.name.length > 21) {
    fail(`tool name ${t.name} is ${t.name.length} chars; over 21 breaks OAuth-connector installs`);
  }
  if (!/^[a-z][a-z0-9_]*$/.test(t.name)) {
    fail(`tool name ${t.name} is not lower snake_case`);
  }
}
console.log(`ok    tools/list: ${tools.length} tools, all annotated and within the name budget`);

// Exercise the first tool with its own example, so this stays generic across servers.
const first = tools[0];
const example = first.inputSchema?.properties ?? {};
const args = {};
for (const [k, spec] of Object.entries(example)) {
  if (spec.enum) args[k] = spec.enum[0];
  else if (spec.type === "string") args[k] = "0";
  else if (spec.type === "number" || spec.type === "integer") args[k] = 1;
  else if (spec.type === "boolean") args[k] = false;
}
const call = await rpc({
  jsonrpc: "2.0", id: 3, method: "tools/call",
  params: { name: first.name, arguments: args },
});
if (!call?.result?.content?.[0]) fail(`tools/call on ${first.name} returned no content`);
console.log(`ok    tools/call: ${first.name} responded`);

console.log("\nsmoke passed");
