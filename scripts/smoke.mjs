#!/usr/bin/env node
// Post-deploy check against the live endpoint. A deploy that succeeds but serves
// a broken protocol is worse than one that fails loudly.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

// Accepts either a full URL, or a package name whose endpoint is read from its
// server.json. That file is now the MCP registry's own schema rather than a
// local invention, so the URL CI smoke-tests and the URL the registry publishes
// are the same string and cannot drift.
function resolveBase(arg) {
  if (!arg) return null;
  if (/^https?:\/\//.test(arg)) return arg.replace(/\/$/, "");
  let meta;
  try {
    meta = JSON.parse(readFileSync(`packages/${arg}/server.json`, "utf8"));
  } catch {
    console.error(`No packages/${arg}/server.json. Pass a package name or a URL.`);
    process.exit(2);
  }
  const url = meta.remotes?.find((r) => r.type === "streamable-http")?.url;
  if (!url) {
    console.error(`packages/${arg}/server.json declares no streamable-http remote.`);
    process.exit(2);
  }
  return url.replace(/\/$/, "");
}

const target = process.argv[2];
const base = resolveBase(target);
if (!base) {
  console.error("usage: smoke.mjs <package-name | base-url>");
  process.exit(2);
}
// A package name also gives access to the local definition, and so to the
// examples each tool declares. A bare URL does not.
const pkg = /^https?:\/\//.test(target) ? null : target;
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

// Exercise every tool, with the examples the server declares.
//
// This used to call tools[0] only, with arguments synthesized from the schema
// (every string became "0"), so it asserted that one tool returned some content
// and nothing about the other tools or about any answer being right. Examples
// come from the local tools.mjs rather than the wire, because they are test
// fixtures and deliberately do not ship in tools/list.
//
// Passing a bare URL still works and falls back to synthesized arguments, since
// there is no package to read examples from.
const examplesByTool = new Map();
if (pkg) {
  const local = (await import(pathToFileURL(resolve(`packages/${pkg}/tools.mjs`)).href)).default;
  for (const tool of local.tools) if (tool.examples?.[0]) examplesByTool.set(tool.name, tool.examples[0]);
}

const synthesize = (schema) => {
  const args = {};
  for (const [key, spec] of Object.entries(schema?.properties ?? {})) {
    if (spec.enum) args[key] = spec.enum[0];
    else if (spec.type === "string") args[key] = "0";
    else if (spec.type === "number" || spec.type === "integer") args[key] = 1;
    else if (spec.type === "boolean") args[key] = false;
  }
  return args;
};

let id = 3;
for (const tool of tools) {
  const example = examplesByTool.get(tool.name);
  const args = example?.args ?? synthesize(tool.inputSchema);
  const call = await rpc({
    jsonrpc: "2.0", id: id++, method: "tools/call",
    params: { name: tool.name, arguments: args },
  });
  if (!call?.result?.content?.[0]) fail(`tools/call on ${tool.name} returned no content`);
  if (call.result.isError) {
    fail(`tools/call on ${tool.name} returned an error: ${call.result.content[0].text}`);
  }

  // With an example there is a right answer, so check it. A deploy that serves
  // a stale build responds to everything and is wrong about all of it, which is
  // precisely the failure a liveness-only smoke test cannot see.
  for (const [key, want] of Object.entries(example?.expect ?? {})) {
    const got = call.result.structuredContent?.[key];
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      fail(`${tool.name} returned ${key}=${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    }
  }
  console.log(`ok    tools/call: ${tool.name}${example ? " answered its example correctly" : " responded"}`);
}

console.log("\nsmoke passed");
