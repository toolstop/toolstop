# toolstop

Small, stateless MCP servers. Each one does a single narrow job exactly, so an
assistant can call it instead of guessing.

Every server runs on Cloudflare Workers at `<name>.toolstop.dev`, holds no
state, and can also run locally over stdio.

## Servers

| Server | Does | Endpoint |
|---|---|---|
| [check-digits](packages/mcp-check-digits) | Validates check digits for IBAN, LEI, ISBN, GTIN/UPC/EAN, VIN, NPI, ISIN, ABA routing numbers and payment cards | `https://check-digits.toolstop.dev` |

## Connecting

Remote, over streamable HTTP — no install, no account:

```json
{
  "mcpServers": {
    "check-digits": {
      "type": "url",
      "url": "https://check-digits.toolstop.dev"
    }
  }
}
```

Local, over stdio:

```bash
npx mcp-check-digits
```

## Design

**Stateless.** No database, no vector index, no metered upstream API. A request
is answered from its arguments alone. Servers scale to zero and an idle one
costs nothing.

**Zero runtime dependencies.** No MCP SDK, no schema library. MCP over
streamable HTTP is request/response, which makes hand-rolled dispatch small
enough to be worth it — faster cold starts and no supply chain.

**Telemetry records shape and outcome, never argument values.** A check-digit
server that logged its input would be storing real IBANs and card numbers. The
transport emits one row per request describing *what kind* of call happened and
whether it succeeded. `packages/_shared/transport.test.mjs` asserts that no raw
argument value can reach it.

**Every tool carries `readOnlyHint` and a complete `inputSchema`**, so a client
can tell what a call will do before making it.

## Repo layout

```
packages/_shared/     transport, dispatch, telemetry — shared by every server
packages/mcp-<name>/  one server
scripts/discover.mjs  derives the CI matrix from the filesystem
scripts/smoke.mjs     protocol check against a live endpoint
```

See [CLAUDE.md](CLAUDE.md) for the operating manual.

## Development

```bash
npm install
npm test                                # every server plus the shared transport
node scripts/smoke.mjs mcp-check-digits # protocol check against the live endpoint
```

## License

MIT
