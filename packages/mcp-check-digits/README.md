# mcp-check-digits

An MCP server that validates check digits for structured identifiers.

Assistants are bad at modular arithmetic and good at sounding confident about
it. This server does the arithmetic exactly, so a wrong IBAN or a mistyped VIN
gets caught instead of confirmed.

Supported: **IBAN**, **LEI**, **ISBN-10**, **ISBN-13**, **GTIN/UPC/EAN**,
**VIN**, **NPI**, **ISIN**, **ABA routing numbers**, and **payment cards**.

## Use it

Remote. No install, no account:

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
| `validate_identifier` | Check a number you already know the type of. Returns whether the check digit passes and, when it fails, what is wrong. |
| `detect_identifier_format` | Given a bare number, report every supported format whose check digit it satisfies. |
| `compute_luhn_check_digit` | Given digits without their final check digit, return the one that completes them. |

All three are read-only and carry complete input schemas. Spaces and dashes in
input are ignored.

## Privacy

**Identifiers you submit are never recorded.** Telemetry captures the *kind* of
identifier checked and whether it passed, never the value. That boundary is
enforced by a test rather than a promise: see
`packages/_shared/transport.test.mjs` in the
[repo](https://github.com/jamesonhohbein/toolstop).

Running over stdio, nothing leaves your machine at all.

## What it does not do

A passing check digit means the identifier is *well-formed*, not that it exists,
is active, or belongs to anyone in particular. A valid IBAN checksum does not
mean the account is real.

## License

MIT
