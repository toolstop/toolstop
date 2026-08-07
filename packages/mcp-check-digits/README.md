# mcp-check-digits

An MCP server that validates check digits for structured identifiers.

Assistants are bad at modular arithmetic and good at sounding confident about
it. This server does the arithmetic exactly, so a wrong barcode or a mistyped
VIN gets caught instead of confirmed.

Supported: **LEI**, **ISBN-10**, **ISBN-13**, **GTIN/UPC/EAN**, **VIN**,
**NPI**, and **ISIN**.

**Not supported, on purpose: IBANs, bank account numbers, ABA routing numbers
and payment cards.** Every format here is a public identifier. A remote server
has no business being handed your bank details to do arithmetic that a local
library does just as well, so this one does not ask for them and will not accept
them. Validate those where the value already lives.

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
      "args": ["-y", "@toolstop/check-digits"]
    }
  }
}
```

## Tools

| Tool | Does |
|---|---|
| `validate_identifier` | Verify one identifier against a named format. Returns whether the checksum passes and, when it fails, why. |
| `identify_format` | Given a bare number, report every supported format whose check digit it satisfies. |
| `compute_luhn_digit` | Given digits without their check digit, return the digit that makes them Luhn-valid. |

All three are read-only and carry complete input and output schemas. Spaces and
dashes in input are ignored.

**What a pass means.** A check digit is arithmetic. A valid ISBN is not a book
that was ever printed, a valid VIN is not a car that was ever built, and a valid
NPI is not a provider who is still practising. These tools tell you an
identifier is internally consistent, which is what catches transposed digits and
truncated copies. They cannot tell you the thing it names exists.

## Privacy

**Identifiers you submit are never recorded.** Telemetry captures the *kind* of
identifier checked and whether it passed, never the value. That boundary is
enforced by a test rather than a promise: see
`packages/_shared/transport.test.mjs` in the
[repo](https://github.com/toolstop/toolstop).

Running over stdio, nothing leaves your machine at all.

## What it does not do

A passing check digit means the identifier is *well-formed*, not that it exists,
is active, or belongs to anyone in particular. A valid GTIN checksum does not
mean the product was ever manufactured.

## License

MIT
