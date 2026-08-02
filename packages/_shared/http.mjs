// Stateless MCP over HTTP, for Cloudflare Workers.
//
// The 2026-07-28 spec moved MCP from a bidirectional stateful protocol to plain
// request/response, which is what makes this a ~150-line fetch handler with no
// session store, no Durable Object, and no Node compat shim. Every request is
// self-contained, so the Worker scales to zero and costs nothing at idle.
//
// JSON Schema is the source of truth for tool inputs because that is what goes
// on the wire. Validation is deliberately small: types, required fields, enums,
// and string length. Anything deeper belongs in the tool handler.

import { recordEvent, shapeOf, sessionIdFrom } from "./telemetry.mjs";

const PROTOCOL_VERSION = "2025-06-18";
const JSONRPC = "2.0";

const rpcResult = (id, result) => ({ jsonrpc: JSONRPC, id, result });
const rpcError = (id, code, message) => ({ jsonrpc: JSONRPC, id, error: { code, message } });

// ------------------------------------------------------------------ validation

function validate(schema, args) {
  const errors = [];
  const props = schema?.properties ?? {};
  const required = schema?.required ?? Object.keys(props);

  for (const key of required) {
    if (args?.[key] === undefined) errors.push(`missing required argument "${key}"`);
  }
  for (const [key, spec] of Object.entries(props)) {
    const v = args?.[key];
    if (v === undefined) continue;
    const actual = Array.isArray(v) ? "array" : typeof v;
    const want = spec.type;
    if (want && want !== actual && !(want === "integer" && Number.isInteger(v))) {
      errors.push(`"${key}" should be ${want}, got ${actual}`);
      continue;
    }
    if (spec.enum && !spec.enum.includes(v)) {
      errors.push(`"${key}" must be one of: ${spec.enum.join(", ")}`);
    }
    if (spec.maxLength && typeof v === "string" && v.length > spec.maxLength) {
      errors.push(`"${key}" exceeds ${spec.maxLength} characters`);
    }
  }
  return errors;
}

// ------------------------------------------------------------------- dispatch

export async function dispatch({ message, server, env, meta = {} }) {
  const { id, method, params } = message;
  const started = Date.now();

  const base = {
    server: server.name,
    version: server.version,
    method,
    protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
    clientName: params?.clientInfo?.name ?? "",
    clientVersion: params?.clientInfo?.version ?? "",
    transport: meta.transport ?? "http",
    country: meta.country ?? "",
    colo: meta.colo ?? "",
    userAgent: meta.userAgent ?? "",
    sessionId: meta.sessionId ?? "",
  };

  const emit = (extra) =>
    recordEvent(env, { ...base, durationMs: Date.now() - started, ...extra });

  switch (method) {
    case "initialize":
      emit({ outcome: "ok" });
      return rpcResult(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: server.name, version: server.version },
        ...(server.instructions ? { instructions: server.instructions } : {}),
      });

    case "ping":
      emit({ outcome: "ok" });
      return rpcResult(id, {});

    case "tools/list": {
      // The most important funnel event: the server was discovered and
      // inspected, even if no tool is ever called.
      emit({ outcome: "ok", toolCount: server.tools.length });
      return rpcResult(id, {
        tools: server.tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { readOnlyHint: true, openWorldHint: false, ...t.annotations },
        })),
      });
    }

    case "tools/call": {
      const tool = server.tools.find((t) => t.name === params?.name);
      if (!tool) {
        emit({ outcome: "protocol_error", errorClass: "unknown_tool", tool: params?.name, isError: true });
        return rpcError(id, -32602, `Unknown tool: ${params?.name}`);
      }

      const args = params.arguments ?? {};
      const argShape = shapeOf(args);
      const errors = validate(tool.inputSchema, args);
      if (errors.length) {
        emit({ outcome: "invalid_args", errorClass: "validation", tool: tool.name, argShape, isError: true });
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: `Invalid arguments: ${errors.join("; ")}` }],
        });
      }

      try {
        const result = await tool.handler(args);
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        emit({
          outcome: "ok",
          tool: tool.name,
          argShape,
          resultBytes: text.length,
          // Derived, non-sensitive facts the tool chooses to surface.
          classified: tool.classify?.(args, result) ?? {},
        });
        return rpcResult(id, { content: [{ type: "text", text }] });
      } catch (err) {
        emit({
          outcome: "tool_error",
          errorClass: err.name ?? "Error",
          tool: tool.name,
          argShape,
          isError: true,
        });
        return rpcResult(id, {
          isError: true,
          content: [{ type: "text", text: `${tool.name} failed: ${err.message}` }],
        });
      }
    }

    default:
      if (method?.startsWith("notifications/")) return null; // Notifications get no reply.
      emit({ outcome: "protocol_error", errorClass: "unknown_method", isError: true });
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

// ------------------------------------------------------------- fetch handler

export function createFetchHandler(server) {
  return async function fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, server: server.name, version: server.version });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
    }

    // A batch is an array; a single call is an object. Both are valid JSON-RPC.
    const meta = {
      transport: "http",
      country: request.cf?.country ?? "",
      colo: request.cf?.colo ?? "",
      userAgent: request.headers.get("user-agent") ?? "",
      sessionId: await sessionIdFrom(request, server.name),
    };

    const batch = Array.isArray(body) ? body : [body];
    const responses = [];
    for (const message of batch) {
      const res = await dispatch({ message, server, env, meta });
      if (res) responses.push(res);
    }

    if (responses.length === 0) return new Response(null, { status: 202 });
    return Response.json(Array.isArray(body) ? responses : responses[0]);
  };
}
