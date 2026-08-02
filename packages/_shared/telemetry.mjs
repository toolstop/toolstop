// Traffic recording for spray servers.
//
// Sink is Cloudflare Workers Analytics Engine: included on the free plan, writes
// cost effectively nothing, queryable over SQL, and there is no database to run
// or scale. That matches the constraint that adding server N+1 costs nothing.
//
// PRIVACY BOUNDARY: read before adding fields.
//
// We record the *shape* and *outcome* of every call, never the argument values.
// A check-digit server that logged raw arguments would be storing real IBANs and
// card numbers: a liability, and a near-certain directory rejection, since
// Anthropic's policy prohibits collecting user data. Shape plus outcome gives us
// everything analytically useful (which tools get called, with what kinds of
// input, succeeding or failing, how fast) while holding nothing sensitive.
//
// Analytics Engine caps: 20 blobs, 20 doubles, 1 index, 5120 bytes of blobs.

/** Describe an argument object without retaining its values. */
export function shapeOf(args) {
  if (args === null || typeof args !== "object") return {};
  const shape = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") shape[k] = `str:${v.length}`;
    else if (typeof v === "number") shape[k] = "num";
    else if (typeof v === "boolean") shape[k] = "bool";
    else if (Array.isArray(v)) shape[k] = `arr:${v.length}`;
    else if (v === null) shape[k] = "null";
    else shape[k] = "obj";
  }
  return shape;
}

/**
 * One row per MCP request.
 *
 * `classified` is the per-server escape hatch for derived, non-sensitive facts
 * worth keeping: e.g. which identifier format was requested and whether it
 * validated. Servers must pass derived values only, never raw input.
 */
export function recordEvent(env, ev) {
  const ds = env?.MCP_EVENTS;
  if (!ds) return; // Local dev, or binding not configured: stay silent.

  try {
    ds.writeDataPoint({
      // Sampling key. Server name keeps per-server data intact under load.
      indexes: [ev.server ?? "unknown"],
      blobs: [
        ev.server ?? "",
        ev.version ?? "",
        ev.method ?? "",
        ev.tool ?? "",
        ev.outcome ?? "",
        ev.errorClass ?? "",
        ev.clientName ?? "",
        ev.clientVersion ?? "",
        ev.protocolVersion ?? "",
        ev.country ?? "",
        ev.colo ?? "",
        ev.sessionId ?? "",
        JSON.stringify(ev.argShape ?? {}).slice(0, 512),
        JSON.stringify(ev.classified ?? {}).slice(0, 512),
        ev.transport ?? "http",
        ev.userAgent?.slice(0, 128) ?? "",
      ],
      doubles: [
        ev.durationMs ?? 0,
        ev.resultBytes ?? 0,
        ev.toolCount ?? 0,
        ev.isError ? 1 : 0,
        ev.authenticated ? 1 : 0,
      ],
    });
  } catch {
    // Telemetry must never break a request.
  }
}

/**
 * Anonymous per-connection id. Derived from coarse request properties, not from
 * anything identifying, and not stable across days by design, enough to count
 * distinct sessions, not enough to track a person.
 */
export async function sessionIdFrom(request, salt = "") {
  const parts = [
    request.headers.get("user-agent") ?? "",
    request.headers.get("cf-connecting-ip") ?? "",
    new Date().toISOString().slice(0, 10),
    salt,
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
