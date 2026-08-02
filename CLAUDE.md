# toolstop

A set of small, stateless MCP servers on Cloudflare Workers, served at
`<name>.toolstop.dev`. This file is the operating manual.

## Adding a server

```
packages/mcp-<name>/
  tools.mjs      the only real work: tool definitions + handlers
  lib.mjs        the logic
  worker.mjs     3 lines, copy verbatim
  index.mjs      3 lines, copy verbatim (the stdio entrypoint)
  wrangler.toml  copy verbatim; only `name` changes
  server.json    name, hostname, description, transport
  package.json   npm metadata
  test.mjs
  README.md
```

Commit and push. CI discovers packages from the filesystem, tests, deploys,
smoke tests, and starts recording traffic. **Never edit a workflow to add a
server.** If that becomes necessary, `scripts/discover.mjs` is what needs
fixing.

**One manual step per server:** attach `<name>.toolstop.dev` as a Worker custom
domain, once, from a session with a full-permission login:

```bash
npx wrangler deploy   # then attach the domain in the dashboard, or via API
```

**Do not put the custom domain in `wrangler.toml`.** Declaring a route makes
wrangler re-assert it on every deploy, which is a *zone-level* API call, and
that forces the CI token to carry `Zone > Workers Routes > Edit` on top of the
account-level script permission. The binding is one-time infrastructure and
survives deploys that declare no routes (verified). The hostname lives in
`server.json` instead.

`workers_dev = false` and `preview_urls = false` are pinned in every
`wrangler.toml`. Without them wrangler re-enables the `workers.dev` URL on each
deploy and the server answers on two addresses.

## Constraints that are not negotiable

**Zero persistent state per server.** No database, no vector index, no metered
upstream API. Per-server storage means per-server setup, migration and ops,
which stops being affordable at three servers. A request must be answerable
from its arguments alone.

**Telemetry records shape and outcome, never argument values.** A check-digit
server logging raw input would be storing real IBANs and card numbers, which is
a liability regardless of intent. `packages/_shared/transport.test.mjs` asserts
no raw value reaches telemetry. That is the test least worth breaking silently.

**Tools carry `readOnlyHint` and a full `inputSchema` from the start.** The
post-deploy smoke test checks for them, so a server missing annotations fails
before it reaches a user.

**Servers are zero-dependency.** No MCP SDK, no zod. Stateless
request/response MCP makes hand-rolled dispatch small enough that dropping both
is worth it: faster cold starts, and no supply chain.

## Architecture

`packages/_shared/` holds everything reusable:

- `http.mjs` carries stateless MCP over `fetch`, plus the exported `dispatch`
  both transports share. Telemetry is emitted here, so every server gets it
  free.
- `telemetry.mjs` writes one row per request into Analytics Engine. Read the
  privacy note before adding fields.
- `stdio.mjs` runs the same dispatch over stdio. Note that stdio traffic is
  **invisible by design**: it runs on the user's machine and deliberately does
  not phone home.

A change under `_shared/` redeploys every server. That is intended.

## Operations

```bash
npm test                                        # every server + shared transport
node --test packages/mcp-<name>/test.mjs        # one server
node scripts/smoke.mjs mcp-<name>               # protocol check, live endpoint
npx wrangler deploy                             # from a package dir
```

CI needs exactly one Cloudflare permission: **Workers Scripts: Edit**. Not the
"Edit Cloudflare Workers" template, which bundles KV, R2, Routes and Tail that
nothing here uses. No client IP filtering, because GitHub runner IPs rotate.

Required repository secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`.

**Secrets never go in `wrangler.toml`.** It is committed.

## Traps

**Analytics Engine lags, but it does converge.** 17 requests read back as 11
minutes after firing, and as all 17 the next day. A fresh reading undercounts;
it is not permanently lossy. Never judge traffic within minutes of generating
it.

**The wrangler OAuth token expires hourly.** A bare `curl` against the Analytics
SQL API will 401 for no obvious reason. Back-to-back SQL queries also 429, so
space them.

**Nothing has quotas yet.** A single agent loop can fire 30 to 80 tool calls per
user prompt. Pure-computation servers are low-exposure; the first server
touching anything metered turns that gap into a bill.

**`git push` needs the `workflow` scope** on the `gh` token to touch
`.github/workflows/`. Git also caches credentials separately from `gh`, so after
`gh auth refresh` a push can still fail with a stale token.
