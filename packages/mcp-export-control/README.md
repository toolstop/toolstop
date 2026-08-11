# @toolstop/export-control

Does the US Commerce Country Chart require an export licence for a given ECCN to
a given destination?

It reads two published tables, both US federal regulation and therefore public
domain:

- **Commerce Country Chart**, 15 CFR part 738, Supplement No. 1. 200 destinations
  by 16 control columns.
- **Commerce Control List**, 15 CFR part 774, Supplement No. 1. 636 ECCNs with
  their reasons for control and the chart column each one maps to.

Both are embedded in the package from the **2026-01-01** edition. There is no
upstream API call, no key, and no account.

## Install

```jsonc
// Claude Desktop, Cursor, VS Code
{ "mcpServers": { "export-control": { "url": "https://export-control.toolstop.dev" } } }
```

```bash
npx @toolstop/export-control     # stdio, nothing leaves your machine
```

## Tools

| Tool | Answers |
|---|---|
| `check_export_license` | ECCN + destination, does the chart require a licence, and which reasons trigger it |
| `lookup_eccn` | One Control List entry: title, reasons for control, scope caveats |
| `lookup_country` | Which of the 16 control columns a destination carries |
| `explain_reason_code` | What NS, AT, CB and the rest stand for |

```
check_export_license { eccn: "3A001", country: "Japan" }
  -> licenseRequired: true, triggered by NS1 and RS1, with the scope text
     for each control

check_export_license { eccn: "3A001", country: "Canada" }
  -> licenseRequired: false, plus the RS controls on that entry that the
     chart does not decide
```

## What this does not do, which matters more than what it does

**It cannot classify an item into an ECCN, and you must not guess one.**
Classification depends on an item's technical parameters, not its name, and it is
the exporter's legal responsibility. Without an ECCN, this server has no useful
answer, and feeding it a plausible-looking guess produces a confident meaningless
one.

**`licenseRequired: false` is not permission to export.** It means the country
chart alone does not require a licence for that ECCN to that destination. Every
answer carries a `notCovered` list, because all of the following still apply:

- End-user and end-use controls: the Entity List, Denied Persons, Unverified
  List, and the part 744 prohibitions.
- Licence exceptions in part 740, which can authorise an export the chart says
  needs a licence.
- Embargoes and special controls in part 746.
- Deemed exports, reexports, and in-country transfers.

**Four destinations never get a chart answer.** Cuba, Iran, North Korea and Syria
return `embargoed` with a referral to part 746, because the chart does not govern
them and reading their row as permission would be badly wrong.

**Ambiguous country names are not guessed.** "Congo" returns both Congos and asks
you to choose. So does anything else matching more than one row.

**It is a snapshot, and the regulation is the authority.** The CFR changes by
Federal Register amendment. If this disagrees with the current regulation, the
regulation wins and the disagreement is a bug worth reporting.

This is not legal advice.

## Privacy

**Nothing you submit is recorded.** Telemetry captures the *shape* of a call, not
its values: field names with types and lengths, never an ECCN or a destination.

**What is recorded.** One row per request, retained 90 days:

| | |
|---|---|
| The call | Server name and version, MCP method, tool name, outcome, error *class* (never the message), duration, result size |
| The client | Client name, version and protocol version as your software reports them, plus a truncated user agent |
| Coarse location | Country and Cloudflare data centre. Never a precise location |
| Argument *shape* | Field names with types and lengths, for example `str:5`. Never a value |
| A session id | A hash of your user agent, the date, this server's name, and the **network block** your request came from, truncated to a /24 or /48 first. It counts distinct sessions in a day, does not link across days, and cannot distinguish two callers behind one network |

**Running over stdio, none of this happens.** The server runs on your machine and
deliberately does not phone home.

## Refreshing the data

`data.mjs` is generated from eCFR, which is keyless and public:

```bash
curl "https://www.ecfr.gov/api/versioner/v1/full/<date>/title-15.xml?part=738" -o chart.xml
curl "https://www.ecfr.gov/api/versioner/v1/full/<date>/title-15.xml?part=774" -o ccl.xml
```

The country chart is one table keyed by a 16-column header (`CB 1` through
`AT 2`); the Control List is one entry per `<FP-2><B>` heading whose text starts
with an ECCN, each carrying a `Reason for Control:` line and a two-column table
mapping a control to its chart column.

Two shapes in that source will silently lose data if a rewrite misses them.
Some control tables merge both cells into one `colspan="2"` cell, and the four
embargoed destinations carry a referral sentence instead of X marks rather than
appearing as an empty row.

## License

MIT for the code. The underlying tables are US federal regulation and are in the
public domain.
