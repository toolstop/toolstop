# mcp-check-digits

An MCP server that validates check digits for structured identifiers.

Assistants are bad at modular arithmetic and good at sounding confident about
it. This server does the arithmetic exactly, so a wrong IBAN or a mistyped VIN
gets caught instead of confirmed.

Supported: **IBAN**, **LEI**, **ISBN-10**, **ISBN-13**, **GTIN/UPC/EAN**,
**VIN**, **NPI**, **ISIN**, **ABA routing numbers**, and **payment cards**.

## Use it

Remote — no install, no account:

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

```json
{
  "mcpServers": {
    "check-digits": {
      "command": "npx",
      "args": ["-y", "mcp-check-digits"]
    }
  }
}
```

## Tools

| Tool | Does |
|---|---|
| `validate_identifier` | Verify one identifier against a named format. Returns whether the checksum passes and, when it fails, why. |
| `identify_identifier` | Given a bare number, report every supported format whose check digit it satisfies. |
| `luhn_check_digit` | Given digits without their check digit, return the digit that makes them Luhn-valid. |

All three are read-only and carry complete input schemas. Spaces and dashes in
input are ignored.

## Privacy

**Identifiers you submit are never recorded.** Telemetry captures the *kind* of
identifier checked and whether it passed — never the value. That boundary is
enforced by a test, not a promise: see `packages/_shared/transport.test.mjs` in
the [repo](https://github.com/jamesonhohbein/toolstop).

Running over stdio, nothing leaves your machine at all.

## What it does not do

A passing check digit means the identifier is *well-formed*, not that it exists,
is active, or belongs to anyone in particular. A valid IBAN checksum does not
mean the account is real.

## License

MIT
