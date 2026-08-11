# @toolstop/export-control

Does the US Commerce Country Chart require an export licence for a given ECCN to
a given destination?

It reads two published tables, both US federal regulation and therefore public
domain:

- **Commerce Country Chart**, 15 CFR part 738, Supplement No. 1. 200 destinations
  by 16 control columns, with the ten chart footnotes.
- **Commerce Control List**, 15 CFR part 774, Supplement No. 1. 637 ECCNs with
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

check_export_license { eccn: "0A983", country: "France" }
  -> indeterminate, with "a license is required for ALL destinations,
     regardless of end-use" returned verbatim
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

**Entries the chart does not decide return `indeterminate`, not `false`.** Some
ECCNs carry their requirement in the entry itself rather than in a chart column,
and it is frequently the strongest one in the part: 0A983, implements of torture,
reads *a license is required for ALL destinations, regardless of end-use*. Others
are pointers to the ITAR with no EAR requirement at all. Both return the
requirement text verbatim and no verdict, because `licenseRequired: false` on
either would be the inverse of the answer. 47 of the 637 entries are in the
second group; the first is answered from the text.

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
node scripts/gen-export-control.mjs                  # the current edition
node scripts/gen-export-control.mjs --date=2026-01-01
```

With no `--date` it asks eCFR which edition title 15 is currently issued at,
rather than assuming today, because `SOURCE_EDITION` is quoted back to callers
as what the data is current to.

**This runs weekly on its own**, in `.github/workflows/refresh-data.yml`, and
opens a PR when the tables move. The CFR changes by Federal Register amendment
and a table embedded in a package is correct only on the day it ships: this one
was seven months stale inside a single release, with 9A012 split so that NS
Column 1 no longer covers `.a.1`.

Read that script before changing it. The first version of this data came from a
generator that was never committed, and it shipped seven defects that were
invisible in the output and green in the test suite: entries whose requirement
is written as prose lost it and then cleared every destination, table rows with
a trailing empty cell were dropped, the reason line was read past its end so one
entry carried 341 reason codes, XML entities were never decoded so Türkiye could
not be looked up by any spelling, and every string was cut at 220 characters
mid-word.

So the invariants at the foot of that script matter more than its parsing does.
Each one is a defect that shipped, and they fail the build rather than writing a
table that looks complete. The load-bearing one: **an entry with a licence
section and no control parsed out of it is a parse failure, not an entry without
controls.** That single assertion catches most of the above.

The shapes in the source that will silently lose data if a rewrite misses them:

| Shape | Where |
|---|---|
| Control table with both cells merged into one `colspan="2"` cell | 1C350 |
| Control table row with a trailing empty third cell | 6D201 |
| Empty chart cell, with the requirement stated in the scope cell | 1E355 |
| `Control(s):` as prose in an `FP-1`, with or without the `<I>` label | 0A981, 0A983 |
| `Controls:`, spelled without the parenthetical | 5D980 |
| `Control(s)` as a bare heading followed by `<P>` paragraphs | 1C355 |
| A control paragraph sitting beside a captured table | 1C350's CW rule |
| Entry heading split across several `<B>` tags to italicise a term | 3D006 |
| `Reason for Control` written in the plural, or wrapped in an `FP-2` | 0A919, 2B910 |
| An entry with no `License Requirements` header, going straight to the reason line | 3A001 |
| Referral sentence in place of X marks, rather than an empty row | Cuba, Iran, North Korea, Syria |
| Footnote text as a row of the destinations table | the ten chart footnotes |

## License

MIT for the code. The underlying tables are US federal regulation and are in the
public domain.
