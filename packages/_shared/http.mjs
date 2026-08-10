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

// Exported so the shared suite can point the same rules at a tool's declared
// outputSchema. A tool that advertises a schema and then returns something else
// is a defect no client can defend against, and checking it with the transport's
// own validator means the check cannot drift from what the transport enforces.
export function validate(schema, args) {
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

// ----------------------------------------------------------- server definition

// Checked once, when a transport is constructed, so a malformed server fails at
// deploy instead of quietly serving a wrong answer for the life of the Worker.
//
// `readOnlyHint` has no safe default and so is not given one. A tool that
// mutates something but omits the hint would otherwise be advertised as safe to
// run unattended, and clients use exactly that hint to decide what to
// auto-approve without asking a human. Absence is an error, not something to
// paper over. `openWorldHint` does default, because "no upstream, no network,
// pure computation" is a property of this architecture rather than of any one
// tool.
export function assertServerShape(server) {
  const seen = new Set();
  for (const t of server.tools ?? []) {
    const where = `${server.name}/${t.name}`;
    if (seen.has(t.name)) throw new Error(`${where}: duplicate tool name`);
    seen.add(t.name);

    if (typeof t.annotations?.readOnlyHint !== "boolean") {
      throw new Error(`${where}: annotations.readOnlyHint must be declared explicitly, true or false`);
    }
    if (t.annotations.readOnlyHint === false && typeof t.annotations.destructiveHint !== "boolean") {
      throw new Error(`${where}: a tool that is not read-only must also declare annotations.destructiveHint`);
    }
    if (t.inputSchema?.type !== "object") {
      throw new Error(`${where}: inputSchema must be an object schema`);
    }
  }
  return server;
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
          ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
          // readOnlyHint is deliberately not defaulted here; assertServerShape
          // has already required the tool to state it.
          annotations: { openWorldHint: false, ...t.annotations },
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
        // A tool advertising an outputSchema MUST return conforming structured
        // results. The serialized JSON stays in the text block, which is what
        // the spec recommends for clients that ignore structuredContent, so
        // this is purely additive.
        return rpcResult(id, {
          content: [{ type: "text", text }],
          ...(tool.outputSchema && result !== null && typeof result === "object"
            ? { structuredContent: result }
            : {}),
        });
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

// ----------------------------------------------------------------- landing page

const escapeHtml = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// What a human sees when they paste the hostname into a browser. Worth having
// because the endpoint is otherwise indistinguishable from a broken host: the
// only other thing a GET could return is an error, and someone evaluating an
// unknown vendor reads that as "this does not work" rather than "wrong method".
function landingPage(server, origin) {
  const npm = `https://www.npmjs.com/package/@toolstop/${server.name}`;
  const tools = (server.tools ?? [])
    .map((t) => `<li><code>${escapeHtml(t.name)}</code> ${escapeHtml(t.title ?? "")}</li>`)
    .join("\n");

  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(server.name)} - MCP server</title>
<style>
  body { max-width: 34rem; margin: 4rem auto; padding: 0 1.5rem;
         font: 16px/1.6 system-ui, sans-serif; }
  code { background: #8881; padding: .1em .3em; border-radius: 3px; }
  ul { padding-left: 1.2rem }
  @media (prefers-color-scheme: dark) { body { background: #111; color: #eee } a { color: #7bf } }
</style>
<h1>${escapeHtml(server.name)}</h1>
<p>An MCP server, version ${escapeHtml(server.version)}. This URL speaks
<a href="https://modelcontextprotocol.io">Model Context Protocol</a> over
streamable HTTP; it answers <code>POST</code>, not <code>GET</code>, so there is
nothing else to see here in a browser.</p>
<p>Add it to an MCP client as <code>${escapeHtml(origin)}</code>, or run it
locally from <a href="${escapeHtml(npm)}">npm</a>.</p>
<h2>Tools</h2>
<ul>
${tools}
</ul>
<p><a href="https://github.com/toolstop/toolstop">Source</a> (MIT) &middot;
<a href="/health">health</a></p>
`;
}

// ------------------------------------------------------------- fetch handler

export function createFetchHandler(server) {
  assertServerShape(server);
  return async function fetch(request, env, ctx) {
    const url = new URL(request.url);
    const read = request.method === "GET" || request.method === "HEAD";

    if (read && url.pathname === "/health") {
      return Response.json({ ok: true, server: server.name, version: server.version });
    }

    // A GET on the MCP endpoint is how a client opens the server-initiated SSE
    // stream, and the spec says a server that does not offer one answers 405.
    // That is a different question from "what is at this URL", which is what a
    // browser is asking, and the two are told apart by Accept alone.
    if (read && url.pathname === "/") {
      if ((request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
      }
      return new Response(landingPage(server, url.origin), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    // Anything else read from a path this server does not have is a 404, not a
    // 405. Discovery probes land here -- `/.well-known/oauth-protected-resource`
    // most consequentially, where a client reads 404 as "no OAuth required" and
    // proceeds, but has no defined reading for a 405.
    if (read) return new Response("Not Found", { status: 404 });

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
