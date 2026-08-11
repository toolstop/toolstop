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
 * worth keeping, e.g. which identifier format was requested and whether it
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
 * Reduce a client address to the network it came from, before anything hashes
 * it. IPv4 keeps the /24, IPv6 the /48.
 *
 * This is not belt-and-braces on top of the hash, it is the part that does the
 * work. `sessionIdFrom` truncates SHA-256 to 8 bytes, and the input it used to
 * cover was a full IP: a 32-bit space, with a salt that is the public server
 * name and a date that is public. All three are guessable, so the space is
 * walkable and the "anonymous" id resolved back to one address. Hashing a
 * value smaller than the hash does not hide it.
 *
 * Truncating first changes what is recoverable from a person to a network
 * block, which is the actual privacy property. A /24 is still walkable and is
 * meant to be: recovering "this came from 203.0.113.0/24" identifies an ISP
 * allocation, not a subscriber.
 */
export function networkOf(ip) {
  if (!ip) return "";

  if (ip.includes(":")) {
    // Expand `::` before truncating. Slicing the raw string is wrong twice:
    // `2001:db8::1` would yield a malformed `2001:db8:::/48`, and two spellings
    // of one network would hash to two different sessions.
    let groups;
    if (ip.includes("::")) {
      const [left, right = ""] = ip.split("::");
      const l = left ? left.split(":") : [];
      const r = right ? right.split(":") : [];
      const gap = 8 - l.length - r.length;
      if (gap < 1) return "";
      groups = [...l, ...Array(gap).fill("0"), ...r];
    } else {
      groups = ip.split(":");
    }
    if (groups.length !== 8) return "";
    if (!groups.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return "";
    // Strip leading zeros so 2001:0db8:… and 2001:db8:… agree.
    return `${groups
      .slice(0, 3)
      .map((g) => g.replace(/^0+/, "") || "0")
      .join(":")
      .toLowerCase()}::/48`;
  }

  const octets = ip.split(".");
  if (octets.length !== 4) return ""; // not an address shape we recognise
  if (!octets.every((o) => /^\d{1,3}$/.test(o) && Number(o) <= 255)) return "";
  return `${octets.slice(0, 3).join(".")}.0/24`;
}

/**
 * Anonymous per-connection id. Derived from the client's *network*, its user
 * agent, and the date, so it counts distinct sessions within a day without
 * identifying anyone, and never links across days.
 *
 * The cost is deliberate: two callers behind one /24 running the same client on
 * the same day count as one session. Session counts are therefore a lower
 * bound. That is the right direction to be wrong in for a metric nobody is
 * billed on.
 */
export async function sessionIdFrom(request, salt = "") {
  const parts = [
    request.headers.get("user-agent") ?? "",
    networkOf(request.headers.get("cf-connecting-ip")),
    new Date().toISOString().slice(0, 10),
    salt,
  ].join("|");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(parts));
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
