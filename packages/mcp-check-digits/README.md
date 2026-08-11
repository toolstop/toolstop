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

**What is recorded.** Saying only what is *not* stored would be a half-answer, so
here is the whole row. One record per request, retained 90 days:

| | |
|---|---|
| The call | Server name and version, MCP method, tool name, outcome, error *class* (never the message), duration, result size |
| The client | Client name and version and protocol version as your software reports them, plus a truncated user agent |
| Coarse location | Country and Cloudflare data centre. Never a precise location |
| Argument *shape* | Field names with types and lengths, for example `str:22`. Never a value |
| A session id | See below |

**The session id is derived from your network, not from you.** It is a hash of
your user agent, the date, this server's name, and the **network block** your
request came from, truncated to a /24 (IPv4) or /48 (IPv6) before anything
hashes it. It exists to count distinct sessions in a day and it deliberately
cannot do more: it does not link across days, and two people behind the same
network running the same client are indistinguishable in it.

That truncation was added on 2026-08-10 and it fixed a real weakness rather than
adding a nicety. The id previously covered the full client address, and an
8-byte hash does not conceal a 32-bit value when the other inputs are public, so
it could be walked back to a single address. It no longer can. Being specific
about this matters more than looking clean: an unknown vendor asking you to
route data through their server owes you the actual answer.

**Running over stdio, none of this happens.** The server runs on your machine and
deliberately does not phone home, so there is no row and no network request.

## What it does not do

A passing check digit means the identifier is *well-formed*, not that it exists,
is active, or belongs to anyone in particular. A valid GTIN checksum does not
mean the product was ever manufactured.

## License

MIT
